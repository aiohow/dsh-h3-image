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
    stage: <name>: direct round failed (<err>); retrying direct once
    stage: retrying via system proxy (may count against proxy data)
    STAGE OK            (terminal, stdout)
    STAGE FAIL <rel>    (terminal, stderr, exit 1)

Resumability: a `.part` survives a failed attempt and resumes with a Range
request; a server that ignores Range restarts the file cleanly (200 →
truncate). A part that fails sha256 is deleted, never renamed into place.

Usage:
    python stage_weights.py --dir MODEL_DIR \
        --engine-script .../scripts/fetch_h3_image.py \
        --endpoints hf,https://mirror.example
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

TIMEOUT = 60  # seconds without data on any single read — same as the engine fetch
REDIRECT_CODES = (301, 302, 303, 307, 308)
HF = "https://huggingface.co"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Neutralise urllib's built-in redirect handling (it ignores 308); the
    loop in open_following() follows every redirect code itself."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


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


def stage_file(*, name: str, rel: str, dest: Path, size: int, sha, endpoints,
               middle: str, index: int, total: int) -> bool:
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
                attempt(direct, url_of(endpoint), dest, part, size, sha, name, index, total, first=attempts == 0)
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
            attempt(proxied, url_of(endpoint), dest, part, size, sha, name, index, total, first=attempts == 0)
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
                        endpoints=endpoints, middle=middle, index=index, total=total)
        if not ok:
            print(f"STAGE FAIL {rel}", file=sys.stderr, flush=True)
            return 1
    print("STAGE OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
