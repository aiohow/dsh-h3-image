# dsh-h3-image

> **Name reserved.** This package version (0.1.0) generates images locally:
> the read-only environment check and text-to-image are live (the community
> license must be accepted by you, explicitly, before the first image); the
> one-click setup wizard arrives in the next milestone. Nothing here calls any
> cloud service.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin bundle that runs the open-source **MiniMax H3-Image** text-to-image
model **entirely on your own Apple Silicon Mac**, through the
[MLX](https://github.com/ml-explore/mlx) engine. No API keys, no accounts, no
per-image fees, no egress during generation.

## What you get

| Tool | Purpose |
| --- | --- |
| `h3_status` | Read-only health check: platform, unified memory, venv, engine commit, weights, text encoder, free disk — each red item carries a fix hint. |
| `h3_setup` | Records your explicit community-license acceptance (`action=license`, `accept: true`) and clears it (`action=reset`). The one-time wizard (venv → pinned engine clone → weight download, sha256-verified → smoke test) is the next milestone. |
| `h3_image` | Text-to-image: one engine subprocess per call, internal deadline, one generation at a time (a second call gets an immediate `busy`), PNG verified before it is reported, output lands in your session workspace. |

## Requirements

- Apple Silicon Mac (the engine is arm64-only; Intel/Windows/Linux are
  declined by `h3_status`, not by a crash).
- **48 GB+ unified memory recommended**; 32 GB machines are warned-then-
  confirmed, below 32 GB is refused.
- ~80 GB free disk during setup (peak; the steady state is smaller).
- DSH ≥ 0.2.2-rc.1, Node ≥ 22.19.

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
