#!/usr/bin/env python3
"""Text-encoder fetch driver for dsh-h3-image (bundled asset, not engine code).

Why this exists instead of calling the engine's download_selected.py: that
script downloads three repos including video/audio VAEs and a pruned bf16
checkpoint this plugin's image path never loads, and it takes no pinning
parameters. This driver downloads EXACTLY the pinned file set, verifies the
main safetensors against a pinned sha256 + byte size, and honours a reuse
candidate list (sha256 verdict only — a size match alone never authorizes
reuse; it is reused by symlink, never by copy).

Progress contract (parsed by lib/jobs.js, all flushed):
    [te n/N] fetched <name>
    [te n/N] reused <name> (<path>)
    [te n/N] skipped <name> (already present)
    TE OK

Resumability: huggingface_hub keeps .incomplete part files and resumes them;
small files are atomic via .part + rename.

Mirror: set HF_ENDPOINT before launching (e.g. https://hf-mirror.com) —
hf_hub_download honours it. Nothing here hardcodes an endpoint.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dest", type=Path, required=True, help="text-encoder folder (the engine's --text-dir)")
    ap.add_argument("--meta-dest", type=Path, required=True, help="folder for upstream meta (FL2VA/...)")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--revision", required=True)
    ap.add_argument("--files", required=True, help="comma-separated file list from the pinned package")
    ap.add_argument("--main-file", default="text_encoder.safetensors")
    ap.add_argument("--sha256", required=True, help="pinned sha256 of the main file")
    ap.add_argument("--bytes", type=int, required=True, help="pinned byte size of the main file")
    ap.add_argument("--meta-repo", required=True)
    ap.add_argument("--meta-revision", required=True)
    ap.add_argument("--meta-files", required=True, help="comma-separated upstream paths (kept under meta-dest)")
    ap.add_argument("--candidates-file", type=Path, default=None, help="newline list of size-matching candidate paths to hash")
    args = ap.parse_args()

    # Xet high-performance mode is documented by Hugging Face for large single
    # files; harmless when the endpoint does not serve Xet.
    os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
    from huggingface_hub import hf_hub_download

    files = [f for f in args.files.split(",") if f]
    total = len(files)
    args.dest.mkdir(parents=True, exist_ok=True)

    def download(repo: str, revision: str, name: str, dest: Path) -> Path:
        dest.mkdir(parents=True, exist_ok=True)
        return Path(hf_hub_download(repo, filename=name, revision=revision, local_dir=str(dest)))

    reused = False
    main_path = args.dest / args.main_file
    if main_path.exists() and main_path.stat().st_size == args.bytes and sha256_of(main_path) == args.sha256:
        print(f"[te 1/{total}] skipped {args.main_file} (already present, sha256 match)", flush=True)
        reused = True
    else:
        candidate_ok = False
        if args.candidates_file is not None and args.candidates_file.exists():
            for line in args.candidates_file.read_text().splitlines():
                cand = Path(line.strip())
                if not cand.is_file() or cand.stat().st_size != args.bytes:
                    continue  # size mismatch: not even worth hashing
                print(f"[te 0/{total}] hashing reuse candidate {cand.name} ({args.bytes / 1e9:.1f} GB)", flush=True)
                if sha256_of(cand) == args.sha256:
                    # Exact digest match (design D3): reuse by symlink, never copy.
                    if main_path.exists() or main_path.is_symlink():
                        main_path.unlink()
                    main_path.symlink_to(cand)
                    print(f"[te 1/{total}] reused {args.main_file} (sha256 verified)", flush=True)
                    candidate_ok = True
                    reused = True
                    break
                print(f"[te 0/{total}] candidate {cand.name} hash MISMATCH — will download", flush=True)
        if not candidate_ok:
            got = download(args.repo, args.revision, args.main_file, args.dest)
            size = got.stat().st_size
            if size != args.bytes:
                print(f"SIZE MISMATCH {args.main_file}: got {size}, expected {args.bytes}", flush=True)
                return 3
            digest = sha256_of(got)
            if digest != args.sha256:
                print(f"SHA256 MISMATCH {args.main_file}: got {digest}, expected {args.sha256}", flush=True)
                got.unlink(missing_ok=True)
                return 3
            print(f"[te 1/{total}] fetched {args.main_file} (sha256 verified)", flush=True)

    rest = [f for f in files if f != args.main_file]
    for i, name in enumerate(rest, start=2):
        target = args.dest / name
        if target.exists() and target.stat().st_size > 0:
            print(f"[te {i}/{total}] skipped {name} (already present)", flush=True)
            continue
        download(args.repo, args.revision, name, args.dest)
        print(f"[te {i}/{total}] fetched {name}", flush=True)

    for name in [f for f in args.meta_files.split(",") if f]:
        target = args.meta_dest / name
        if target.exists() and target.stat().st_size > 0:
            print(f"[te meta] skipped {name} (already present)", flush=True)
            continue
        download(args.meta_repo, args.meta_revision, name, args.meta_dest)
        print(f"[te meta] fetched {name}", flush=True)

    print("TE OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
