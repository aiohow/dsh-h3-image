#!/usr/bin/env python3
"""Weight-staging driver for dsh-h3-image (bundled asset, not engine code).

Why this exists: the pinned engine's fetch_h3_image.py hardcodes
https://huggingface.co and has no mirror switch, and patching the pinned
engine is out of scope (design D1). So instead of touching the engine, this
driver places the EXACT pinned file set (CORE_FILES + the transformer shards,
read live from the engine script — never re-listed or re-hashed here) into
the engine's own layout ahead of time. The engine's fetch contract then does
the rest: a file that already exists with the right size and sha256 is
returned without any network access, so the following engine run is instant
for the main weights while still converting shard by shard as usual.

Endpoint honesty: every endpoint is tried DIRECT first (proxies explicitly
disabled — a proxy download would silently spend the user's proxy data). The
direct round runs twice: mirrors are often flaky in bursts, and a second
direct round costs nothing next to silently spending proxy data. Only after
both direct rounds fail does one final round run through the system proxy,
announced by its own line before it starts. Redirects (301/302/303/307/308)
are followed by hand because urllib does not follow 308, which is exactly
what a mirror answers for every file; the Range header is kept across hops
so a resumed download stays resumed through a 308. When a redirect chain
lands on a different host than the endpoint asked for (a mirror bouncing
users back to the origin), a note line says so — a slow file behind such a
bounce is the mirror's doing, and the log should not hide it.

File-list truth: imported from the engine script (--engine-script), so a pin
bump needs no change here.

Progress contract (parsed by lib/jobs.js, all flushed):
    [stage n/N] fetching <name> via <host>
    [stage n/N] placed <name>
    [stage n/N] skipped <name> (already present)
    [stage n/N] switched endpoint: <host>
    [stage n/N] note: <name> redirected to <host>
    [stage n/N] seg <i>/4 <name> via <host>   (segmented mode only)
    stage: <name>: direct round failed (<err>); retrying direct once
    stage: retrying via system proxy (may count against proxy data)
    STAGE OK            (terminal, stdout)
    STAGE FAIL <rel>    (terminal, stderr, exit 1)

Resumability: a `.part` survives a failed attempt and resumes with a Range
request; a server that ignores Range restarts the file cleanly (200 →
truncate). A part that fails sha256 is deleted, never renamed into place.

Segmented downloads (files at or above --seg-threshold, default 64 MB): the
file is split into SEG_COUNT=4 byte ranges fetched concurrently by a
ThreadPoolExecutor (max_workers=4), each segment streaming into its own
`<name>.part.<i>` with a `Range: bytes=start-end` request. Every segment
resumes independently: a segment `.part` of `have` bytes re-requests
`bytes=(start+have)-`; only a 206 appends, a segment `.part` longer than its
segment is deleted and re-fetched from zero. Once all segments are in, they
are stitched into the single `.part` in order (4 MB blocks), the segment
parts are deleted, and the existing verification path takes over unchanged:
total size == size and sha256 match → rename into place; anything else → the
`.part` (and any segment parts) are deleted, never renamed. Disk cost: while
stitching, the segment parts and the assembled `.part` coexist, so the
temporary footprint is roughly one extra copy of the file (about 2x its size
during the stitch, back to ~1x once the segments are unlinked). A server that
answers a segment with 200 instead of 206 does not honour Range: the whole
segmented attempt is abandoned, every segment part is deleted, and the file
falls back to the untouched single-stream path on that same endpoint. One
segmented attempt counts as one attempt against the endpoint-fallback ladder
(two direct rounds, then one system-proxy round).

Usage:
    python stage_weights.py --dir MODEL_DIR \
        --engine-script .../scripts/fetch_h3_image.py \
        --endpoints hf,https://mirror.example \
        [--seg-threshold BYTES]
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

TIMEOUT = 60  # seconds without data on any single read — same as the engine fetch
REDIRECT_CODES = (301, 302, 303, 307, 308)
HF = "https://huggingface.co"

# Files at or above this many bytes are fetched in parallel segments. The
# default is deliberately high: below it the extra connections and the stitch
# pass cost more than the wall-clock they save. Overridable with
# --seg-threshold (the L2 tests use a tiny value to exercise the path).
SEG_THRESHOLD = 64 * 1024 * 1024
SEG_COUNT = 4
STITCH_BLOCK = 1 << 22  # 4 MB — same block size the single-stream path streams with


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Neutralise urllib's built-in redirect handling (it ignores 308); the
    loop in open_following() follows every redirect code itself."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


class _NoRangeError(RuntimeError):
    """A segmented request came back 200 instead of 206: this server does not
    honour Range, so segmentation is off for the file and the single-stream
    path takes over (never a reason to fail the whole endpoint)."""


def seg_part_of(dest: Path, i: int) -> Path:
    return dest.with_name(dest.name + f".part.{i}")


def host_of(url: str) -> str:
    return urllib.parse.urlsplit(url).hostname or url


def clear_segment_parts(dest: Path) -> None:
    """Drop every segment part. Called after a successful stitch, after a
    verification failure and on the 200 fallback — never after a plain network
    failure, because those parts are what the next attempt resumes from."""
    for i in range(SEG_COUNT):
        seg_part_of(dest, i).unlink(missing_ok=True)


def segment_ranges(size: int, count: int = SEG_COUNT):
    """Contiguous [start, end) ranges covering [0, size), as even as possible.
    Empty ranges are dropped; fewer than two ranges means there is nothing to
    parallelise and the caller should stay on the single-stream path."""
    base, extra = divmod(size, count)
    ranges = []
    start = 0
    for i in range(count):
        end = start + base + (1 if i < extra else 0)
        if end > start:
            ranges.append((start, end))
        start = end
    return ranges


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def build_opener(direct: bool):
    """direct=True → ProxyHandler({}) (never the user's proxy); direct=False
    → the default proxy handler, which honours the system proxy settings."""
    if direct:
        return urllib.request.build_opener(_NoRedirect(), urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(_NoRedirect())


def open_following(opener, url: str, headers: dict, max_redirects: int = 10):
    """GET url, following 301/302/303/307/308 by hand. Returns the live
    response; the caller streams from it and it closes with the caller's
    `with` block."""
    for _ in range(max_redirects + 1):
        req = urllib.request.Request(url, headers=headers)
        try:
            return opener.open(req, timeout=TIMEOUT)
        except urllib.error.HTTPError as err:
            location = err.headers.get("Location") if err.headers is not None else None
            err.close()
            if err.code in REDIRECT_CODES and location:
                url = urllib.parse.urljoin(url, location)
                continue
            raise
    raise RuntimeError(f"more than {max_redirects} redirects for {url}")


def attempt(opener, url: str, dest: Path, part: Path, size: int, sha, name: str,
            index: int, total: int, first: bool) -> None:
    """One endpoint, one file: stream into .part (resuming when the server
    honours Range), then verify and rename. Any raise = this endpoint failed
    for this file; the partial .part stays on disk for the next attempt."""
    host = urllib.parse.urlsplit(url).hostname or url
    if not first:
        print(f"[stage {index}/{total}] switched endpoint: {host}", flush=True)
    print(f"[stage {index}/{total}] fetching {name} via {host}", flush=True)
    have = part.stat().st_size if part.exists() else 0
    if have > size:
        part.unlink()
        have = 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    with open_following(opener, url, headers) as resp:
        final_host = urllib.parse.urlsplit(resp.geturl()).hostname or host
        if final_host != host:
            # A mirror that bounces to another host (typically the origin) is
            # still "via <mirror>" in the log above; say where the bytes
            # actually come from so a slow/stalled transfer is attributed right.
            print(f"[stage {index}/{total}] note: {name} redirected to {final_host}", flush=True)
        resume = bool(have) and getattr(resp, "status", 200) == 206
        with part.open("ab" if resume else "wb") as out:
            while True:
                block = resp.read(1 << 22)
                if not block:
                    break
                out.write(block)
    got = part.stat().st_size if part.exists() else 0
    if got != size:
        if got > size:
            part.unlink(missing_ok=True)  # a corrupt oversize part can never resume
        raise RuntimeError(f"expected {size} bytes, got {got}")
    if sha is not None and sha256_of(part) != sha:
        part.unlink(missing_ok=True)  # wrong content: never stage it, never resume it
        raise RuntimeError("sha256 mismatch")
    part.rename(dest)
    print(f"[stage {index}/{total}] placed {name}", flush=True)


def attempt_segment(opener, url: str, seg_part: Path, start: int, end: int,
                    name: str, i: int, index: int, total: int):
    """One endpoint, one byte range: stream into the segment's own .part
    (resuming from its current size when the server honours Range). Returns
    the final segment size. Raises _NoRangeError on a 200 (server ignores
    Range → the caller falls back to single-stream) and RuntimeError on a
    short/oversize transfer. A network failure leaves the partial segment part
    on disk so the next attempt resumes it."""
    host = urllib.parse.urlsplit(url).hostname or url
    print(f"[stage {index}/{total}] seg {i}/{SEG_COUNT} {name} via {host}", flush=True)
    seg_len = end - start
    have = seg_part.stat().st_size if seg_part.exists() else 0
    if have > seg_len:
        # A segment part longer than its range can never be right (torn write
        # or a stale part from a different layout): restart it from zero.
        seg_part.unlink()
        have = 0
    if have == seg_len:
        # Already complete from an earlier attempt — no request needed.
        return have
    # Closed range: the resume point is start+have, and the end stays pinned
    # so a server that answers cannot overshoot the segment (an open-ended
    # resume would pull the rest of the file into this segment).
    headers = {"Range": f"bytes={start + have}-{end - 1}"}
    with open_following(opener, url, headers) as resp:
        if getattr(resp, "status", 200) != 206:
            raise _NoRangeError(f"segment {i} of {name}: server answered {getattr(resp, 'status', 200)} to a Range request")
        # 206 → append; the Range started exactly at `have`, so whatever is on
        # disk stays and the missing tail streams in after it.
        with seg_part.open("ab") as out:
            while True:
                block = resp.read(STITCH_BLOCK)
                if not block:
                    break
                out.write(block)
    got = seg_part.stat().st_size if seg_part.exists() else 0
    if got != seg_len:
        if got > seg_len:
            seg_part.unlink(missing_ok=True)
        raise RuntimeError(f"segment {i} of {name}: expected {seg_len} bytes, got {got}")
    return got


def stitch_segments(dest: Path, part: Path, ranges) -> None:
    """Concatenate the segment parts into the single .part in order (blockwise,
    so peak disk stays at ~2x the file), then drop the segment parts. The
    caller's existing size/sha verification then judges the assembled part."""
    with part.open("wb") as out:
        for i, (_start, _end) in enumerate(ranges):
            seg_part = seg_part_of(dest, i)
            with seg_part.open("rb") as seg:
                while True:
                    block = seg.read(STITCH_BLOCK)
                    if not block:
                        break
                    out.write(block)
    clear_segment_parts(dest)


def attempt_segmented(opener, url: str, dest: Path, part: Path, size: int, name: str,
                      index: int, total: int) -> bool:
    """One endpoint, one whole-file segmented attempt: 4 ranges fetched
    concurrently, stitched into the single .part. Returns True when the .part
    is complete and ready for verification, False when the server does not
    honour Range (parts cleaned, single-stream takes over). Other failures
    raise with the segment parts kept for the next attempt's resume."""
    host = urllib.parse.urlsplit(url).hostname or url
    print(f"[stage {index}/{total}] fetching {name} via {host}", flush=True)
    ranges = segment_ranges(size)
    if len(ranges) < 2:
        return False
    # A previous single-stream attempt may have left a partial .part; the
    # segment parts are the source of truth from here, so it would only be
    # truncated by the stitch anyway.
    part.unlink(missing_ok=True)
    try:
        with ThreadPoolExecutor(max_workers=SEG_COUNT) as pool:
            futures = [
                pool.submit(attempt_segment, opener, url, seg_part_of(dest, i), start, end,
                            name, i + 1, index, total)
                for i, (start, end) in enumerate(ranges)
            ]
            errors = []
            for fut in as_completed(futures):
                try:
                    fut.result()
                except Exception as error:  # noqa: BLE001 — collect, decide below
                    errors.append(error)
        if errors:
            # A 200 anywhere is a capability statement, not a transient
            # failure: it must win over any other segment error so the
            # single-stream fallback always triggers when Range is unsupported.
            for error in errors:
                if isinstance(error, _NoRangeError):
                    raise error
            raise errors[0]
    except _NoRangeError:
        # Not this server's capability: clean slate, single-stream path from
        # scratch — that path treats a 200 as a normal full-file download.
        clear_segment_parts(dest)
        return False
    stitch_segments(dest, part, ranges)
    return True


def stage_file(*, name: str, rel: str, dest: Path, size: int, sha, endpoints,
               middle: str, index: int, total: int, seg_threshold: int = SEG_THRESHOLD) -> bool:
    """Place one pinned file. Returns True on placed/skipped, False after every
    endpoint failed in both the direct and the system-proxy round."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size == size and (sha is None or sha256_of(dest) == sha):
        print(f"[stage {index}/{total}] skipped {name} (already present)", flush=True)
        return True
    part = dest.with_name(dest.name + ".part")
    if part.exists() and part.stat().st_size == size:
        # A part that is already complete goes straight to verification
        # (same shortcut the engine fetch takes), skipping the network.
        if sha is None or sha256_of(part) == sha:
            part.rename(dest)
            print(f"[stage {index}/{total}] placed {name}", flush=True)
            return True
        part.unlink()

    def attempt_endpoint(opener, url, first):
        """One endpoint for this file. Big files try the segmented route
        first; a server that will not do Range (or a file too small to split)
        goes through the untouched single-stream attempt()."""
        if size < seg_threshold:
            attempt(opener, url, dest, part, size, sha, name, index, total, first=first)
            return
        if not first:
            print(f"[stage {index}/{total}] switched endpoint: {host_of(url)}", flush=True)
        if attempt_segmented(opener, url, dest, part, size, name, index, total):
            # Stitched: the same verification the single-stream path applies.
            got = part.stat().st_size if part.exists() else 0
            if got != size:
                part.unlink(missing_ok=True)
                clear_segment_parts(dest)
                raise RuntimeError(f"expected {size} bytes, got {got}")
            if sha is not None and sha256_of(part) != sha:
                part.unlink(missing_ok=True)
                clear_segment_parts(dest)
                raise RuntimeError("sha256 mismatch")
            part.rename(dest)
            print(f"[stage {index}/{total}] placed {name}", flush=True)
            return
        # 200 fallback: the switch (if any) was already announced above, so
        # single-stream runs with first=True and just re-announces fetching.
        attempt(opener, url, dest, part, size, sha, name, index, total, first=True)

    url_of = lambda endpoint: f"{endpoint.rstrip('/')}/{middle}/{rel}"  # noqa: E731
    last_error = None
    attempts = 0
    direct = build_opener(direct=True)
    # Two direct rounds before touching the proxy: mirror flakiness is bursty
    # (a file that times out once often succeeds seconds later), and a second
    # direct round is free while proxy bytes are not.
    for round_no in (1, 2):
        for endpoint in endpoints:
            try:
                attempt_endpoint(direct, url_of(endpoint), first=attempts == 0)
                return True
            except Exception as error:  # noqa: BLE001 — any failure means: next endpoint
                last_error = error
                attempts += 1
        if round_no == 1:
            print(f"stage: {name}: direct round failed ({last_error}); retrying direct once", flush=True)
    print("stage: retrying via system proxy (may count against proxy data)", flush=True)
    proxied = build_opener(direct=False)
    for endpoint in endpoints:
        try:
            attempt_endpoint(proxied, url_of(endpoint), first=attempts == 0)
            return True
        except Exception as error:  # noqa: BLE001
            last_error = error
            attempts += 1
    print(f"stage: {name}: {last_error}", file=sys.stderr, flush=True)
    return False


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", type=Path, required=True, help="model root (the engine fetch's --dir)")
    ap.add_argument("--engine-script", type=Path, required=True, help="absolute path to the engine's fetch_h3_image.py")
    ap.add_argument("--endpoints", required=True, help="comma-separated priority list; 'hf' or https://host[/prefix] per entry")
    ap.add_argument("--seg-threshold", type=int, default=SEG_THRESHOLD,
                    help=f"files at or above this many bytes download in {SEG_COUNT} concurrent Range segments (default {SEG_THRESHOLD})")
    args = ap.parse_args(argv)

    # The engine script's own directory goes on sys.path so `import
    # fetch_h3_image` (and its sibling import of fetch_ph3_image) resolves.
    # Importing it only reads constants — no network, no side effects.
    sys.path.insert(0, str(args.engine_script.resolve().parent))
    import fetch_h3_image as engine  # noqa: E402

    middle = f"{engine.REPO}/resolve/{engine.REVISION}"

    endpoints = []
    for raw in args.endpoints.split(","):
        raw = raw.strip().rstrip("/")
        if raw:
            endpoints.append(HF if raw == "hf" else raw)
    if not endpoints:
        print("stage: --endpoints resolved to nothing", file=sys.stderr)
        return 2

    # Layout truth = the engine's own fetch_h3_image.main: CORE_FILES go to
    # root/<rel> (root/source/<rel> for transformer/), shards to
    # root/source/transformer/<name> via the engine's SHARD_FILE template.
    shard_file = getattr(engine, "SHARD_FILE", "transformer/{name}")
    items = []
    for rel, (size, sha) in engine.CORE_FILES.items():
        dest = args.dir / rel if not rel.startswith("transformer/") else args.dir / "source" / rel
        items.append((rel, rel, dest, size, sha))
    for shard_name in sorted(engine.SHARDS):
        size, sha = engine.SHARDS[shard_name]
        rel = shard_file.format(name=shard_name)
        items.append((shard_name, rel, args.dir / "source" / rel, size, sha))

    total = len(items)
    for index, (name, rel, dest, size, sha) in enumerate(items, 1):
        ok = stage_file(name=name, rel=rel, dest=dest, size=size, sha=sha,
                        endpoints=endpoints, middle=middle, index=index, total=total,
                        seg_threshold=args.seg_threshold)
        if not ok:
            print(f"STAGE FAIL {rel}", file=sys.stderr, flush=True)
            return 1
    print("STAGE OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
