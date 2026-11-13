# Third-party notices

dsh-h3-image (plugin code) is MIT-licensed. It does **not** bundle, vendor,
re-host or re-distribute any of the following; the setup wizard downloads
each item from its official upstream at a pinned revision, on the user's
machine, after the user accepts the respective license where required.

## MLX engine — `minimax-h3-mlx`

- Upstream: <https://github.com/mrbizarro/minimax-h3-mlx>
- License: Apache-2.0 (see the upstream `LICENSE`)
- Pinned commit: recorded in `lib/pinned.js` (`ENGINE.commit`). The wizard
  clones and checks out exactly this commit; `main` is never followed.

## Model weights — `MiniMaxAI/MiniMax-H3-Image` (+ upstream meta from `MiniMaxAI/MiniMax-H3`)

- Upstream: <https://huggingface.co/MiniMaxAI/MiniMax-H3-Image>
- License: MiniMax H3 Image Community License Agreement (upstream `LICENSE`
  file). **The license includes territorial exclusions (EU, UK, South Korea,
  US)** — read the upstream LICENSE text yourself before downloading; the
  wizard shows its key points with a direct link and requires your explicit
  acceptance. The plugin never accepts on your behalf.
- Pinned revisions: recorded in `lib/pinned.js` (`WEIGHTS.revision`,
  `TEXT_ENCODER.revision`); every downloaded file is verified against a
  recorded sha256.

## Quantized text encoder — `ddalcu/MiniMax-H3-FL2VA-MLX-Serve-8bit`

- Upstream: <https://huggingface.co/ddalcu/MiniMax-H3-FL2VA-MLX-Serve-8bit>
- A community-quantized Model Derivative, hosted by an independent third
  party; this plugin neither operates that repository nor is affiliated with
  it. It is the package the pinned engine actually loads for the text path.
- License: **MiniMax H3 Community License Agreement** (a second agreement,
  distinct from the H3-Image one, with the same territorial exclusions). Its
  `LICENSE`, `NOTICE` and `MODIFICATIONS.md` are downloaded beside the
  weights; the wizard lists both agreements before acceptance.
- Pinned revision + sha256: recorded in `lib/pinned.js`
  (`TEXT_ENCODER_PACKAGE`).

## Runtime — Python ≥ 3.13 + MLX

- The wizard creates an isolated virtual environment on your machine and
  installs the engine's declared dependencies (MLX is MIT-licensed by Apple,
  other packages under their own licenses). The plugin ships none of them.

No trademark or brand assets of MiniMax are included in this package.
