# dsh-h3-image

**English** | [简体中文](README.zh.md)

> **Name reserved.** This package version (0.2.0) ships the full local
> pipeline: the read-only environment check, the one-time setup wizard
> (venv → pinned engine clone → license gate → sha256-verified weight
> download with resume → smoke test, each long step a background job that
> survives restarts), and text-to-image. Nothing here calls any cloud
> service.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin bundle that runs the open-source **MiniMax H3-Image** text-to-image
model **entirely on your own Apple Silicon Mac**, through the
[MLX](https://github.com/ml-explore/mlx) engine. No API keys, no accounts, no
per-image fees, no egress during generation.

## What you get

| Tool | Purpose |
| --- | --- |
| `h3_status` | Read-only health check: platform, unified memory, venv, engine commit, weights, text encoder, free disk — each red item carries a fix hint. |
| `h3_setup` | The one-time setup wizard as a resumable state machine: `check → venv → engine → license → weights → smoke`. Long steps (engine install, ~59 GB of downloads + conversion) run as detached background jobs — submit returns a `job_id` in seconds, `action=poll` reads progress from the engine's own on-disk state, and an interrupted download resumes from `.part` on re-run. A dead job is reported `interrupted`, never "done". `action=license` shows the community license; acceptance is recorded only by you. `action=reset` clears the local state record. |
| `h3_image` | Text-to-image: one engine subprocess per call, internal deadline, one generation at a time (a second call gets an immediate `busy`), PNG verified before it is reported, output lands in your session workspace. |

## Requirements

- Apple Silicon Mac (the engine is arm64-only; Intel/Windows/Linux are
  declined by `h3_status`, not by a crash).
- **48 GB+ unified memory recommended**; 32 GB machines are warned-then-
  confirmed, below 32 GB is refused.
- ~60 GB free disk during setup (measured peak on a from-zero install; the
  steady state after the engine deletes source shards is ~53 GB — see the
  resource ledger below).
- DSH ≥ 0.2.2-rc.1, Node ≥ 22.19.

## Resource ledger (measured, bare-metal acceptance 2026-11-12/13)

Every number below comes from one from-zero acceptance run on a 275 GB
Apple Silicon machine (no reuse candidates, fresh venv/engine/weights) —
not from estimates.

| Item | Measured |
| --- | --- |
| Disk peak (incremental, whole setup) | 58.6 GB (54.6 GiB): DiT pack 21.5 + text encoder 28.2 + one in-flight source shard 5.4 + venv 1.1 |
| Disk steady state (post-setup) | 53.2 GB (source shards deleted by the engine after conversion) |
| venv creation | ~18 s (reuses a suitable standalone CPython when found; reports a miss otherwise) |
| Engine clone + pip install | ~72 s |
| Weights: per transformer shard (download 5.5 GB + Q8 convert + delete) | ~4–5 min |
| Weights: resume segment (7 shards + 28.2 GB text encoder) | 41 min |
| Smoke generation | 30 s wall / 10.8 s engine time (1 MP, 6 steps) |
| Generation peak memory (engine metrics) | 27.5 GB per image at 1 MP |
| Host memory in use during the run | 274 GB — includes a resident inference server; the plugin's own footprint is the 27.5 GB above |

Interrupted steps resume: a killed download continues from its `.part`
(Range requests), and finished shards are never re-fetched — verified by
the acceptance run's resume audit (zero re-downloads of completed shards).

## Licenses — read before downloading weights

This plugin's **code** is MIT. It does not ship, re-host or re-distribute the
model. The setup wizard downloads the weights from the official Hugging Face
repository at a pinned revision, and **shows you the MiniMax H3 Image
Community License Agreement — including its territorial exclusions — before
any byte is fetched. You accept it yourself; the plugin never accepts on your
behalf.** The upstream engine is Apache-2.0. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Install (DSH)

```
plugin_manager → install_bundle → <this repo or the npm package>
```

Then enable the bundle in your profile and run `h3_status` — it tells you
exactly what the machine still needs.

## Development

```sh
npm test                                   # unit tests (pure check logic)
npm run release                            # gates + pack + tarball scan
```

Two release gates run in CI and on `prepack`:
`scripts/check-release-safety.mjs` (no machine fingerprints, no AppleDouble,
no secrets — in source **and** in the built tarball) and
`scripts/check-version-consistency.mjs` (package.json ↔ CHANGELOG ↔ locales ↔
pinned revisions).
