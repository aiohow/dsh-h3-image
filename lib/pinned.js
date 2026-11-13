/**
 * Single source of truth for every pinned upstream version.
 *
 * Upgrades: change ONE line here, re-run the smoke step, and record the bump
 * in CHANGELOG.md (maintenance flow, docs/RELEASE-AND-MAINTENANCE.md). Never
 * follow a branch name — `main` of the engine has no image scripts (a pitfall
 * already paid for once).
 *
 * Values below were measured against the upstream on 2026-11-12:
 *  - engine commit: `git rev-parse HEAD` after a clean clone + checkout
 *  - weight revisions: Hugging Face API `sha` of the pinned tree
 *  - reuse-probe digest: sha256 of a locally verified text encoder file
 */

export const ENGINE = Object.freeze({
  repo: "https://github.com/mrbizarro/minimax-h3-mlx.git",
  /** Pinned commit (Apache-2.0). The wizard clones and checks this out exactly.
   *  Measured 2026-11-12: the commit is reachable from refs/heads/phosphene/
   *  v5.0-image5, NOT from main — `main` has no image scripts (pitfall already
   *  paid for once), so the wizard clones with --no-checkout and lands on the
   *  pin directly. */
  commit: "d65ec9f710fce31fbe9efa375537b5c94d83d7fe",
  /** Minimum CPython the engine requires. */
  pythonMin: [3, 13],
});

export const WEIGHTS = Object.freeze({
  repo: "MiniMaxAI/MiniMax-H3-Image",
  /** Pinned Hugging Face revision (tree sha at pin time). */
  revision: "6534ea1c979a5f8cb00c2bd1025d5ca4ee8d8901",
  /**
   * License: MiniMax H3 Image Community License Agreement, with territorial
   * exclusions. The wizard must display it and obtain the USER's acceptance
   * before any download; this plugin never accepts on the user's behalf.
   */
  license: "MiniMax H3 Image Community License Agreement",
});

export const TEXT_ENCODER = Object.freeze({
  repo: "MiniMaxAI/MiniMax-H3",
  revision: "0919fb684102ef115126612f3fbb84d1027e7317",
});

/**
 * Quantized text-encoder package the engine actually loads (the engine's own
 * `scripts/download_selected.py` names this repo for the H3 text path; the
 * upstream repo's FL2VA weights are the unquantised originals the loader does
 * NOT read). Revision pinned from the HF API `sha` on 2026-11-12; the
 * safetensors sha256 below is the HF LFS oid for that revision and matches
 * TEXT_ENCODER_REUSE.sha256 — two independent sources agreeing.
 */
export const TEXT_ENCODER_PACKAGE = Object.freeze({
  repo: "ddalcu/MiniMax-H3-FL2VA-MLX-Serve-8bit",
  revision: "64314cde0ac6d90f132bc94ae58e0c82f77396c6",
  /**
   * This quantized package is a Model Derivative of MiniMax-H3 (video) and
   * carries its own agreement — the MiniMax H3 Community License, with the
   * same territorial exclusions. It is a separate third-party repository;
   * this plugin neither operates it nor accepts on anyone's behalf.
   */
  license: "MiniMax H3 Community License Agreement",
  licenseSha256: "59b99642b95ea21630e311198ddbfffbfe05aadba0c2f5d884cbdf4efcc90f44",
  /** Only what the image path loads + the license trail. The engine's video
   *  path needs more from this repo; H3 Image does not. */
  files: [
    "text_encoder.safetensors",
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "LICENSE",
    "NOTICE",
    "MODIFICATIONS.md",
  ],
  /** sha256 of text_encoder.safetensors at the pinned revision (LFS oid). */
  mainSha256: "79514b061aa0acbeb802bbe37e4853f1b0d0e6fe7fad4f61624057201773bf56",
  mainBytes: 28_222_741_760,
});

/** Upstream metadata the loader needs beside the quantized weights. */
export const UPSTREAM_META = Object.freeze({
  repo: "MiniMaxAI/MiniMax-H3",
  revision: "0919fb684102ef115126612f3fbb84d1027e7317",
  files: ["FL2VA/text_encoder/config.json", "FL2VA/model_index.json"],
});

/**
 * Reuse-probe candidates (design D3): if a file with the EXACT size and
 * (verified in the weights step) sha256 already exists at one of these
 * locations, the ~28 GB text-encoder download can be skipped.
 *
 * A size match alone NEVER authorizes reuse — it only makes the candidate
 * worth hashing. The hash is the verdict.
 *
 * Paths are expressed relative to the user's home so nothing machine-specific
 * ships in the package.
 */
export const TEXT_ENCODER_REUSE = Object.freeze({
  fileName: "text_encoder.safetensors",
  bytes: 28_222_741_760,
  sha256: "79514b061aa0acbeb802bbe37e4853f1b0d0e6fe7fad4f61624057201773bf56",
  /** Directories (relative to $HOME) scanned one level deep for the file. */
  scanDirs: [".mlx-serve/models"],
});

/** Resource thresholds used by the read-only checks (see docs/PRD.md §3.1). */
export const LIMITS = Object.freeze({
  /** Recommended minimum unified memory. Below this → red. */
  memoryRecommendedGB: 48,
  /** Hard floor. Between floor and recommended → "not guaranteed" (needs user confirmation in the wizard). */
  memoryFloorGB: 32,
  /**
   * Free disk required on the volume holding `model_dir`. Backfilled from the
   * M2 bare-metal acceptance run (2026-11-12/13): peak incremental usage on a
   * from-zero install (no reuse candidates) measured 58.63 GB decimal
   * (54.6 GiB) — DiT pack 21.5 GB + text encoder 28.2 GB + one in-flight
   * source shard 5.4 GB + venv 1.1 GB, sampled by the driver's disk probe
   * throughout. Steady state after the engine deletes source shards: 53.2 GB.
   * Shipped value rounds the measured peak up to 60 (decimal GB, matching the
   * decimal-GB semantics of the free-space probe). The old placeholder (80)
   * is retired per TEST-PLAN: shipped numbers come from measurement only.
   */
  diskMinFreeGB: 60,
});

/** Default resolved locations (design D6: zero hardcoded machine paths). */
export const DEFAULTS = Object.freeze({
  modelSubdir: "models",
  engineSubdir: "engine",
  venvSubdir: "venv",
  rootSubdir: "dsh-h3-image", // under $HOME
  mirror: "hf",
  defaultMp: 4,
});
