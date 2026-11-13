# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.8] - 2026-11-13

### Added
- Weight downloads now adapt to your network. When `mirror` is set to a custom
  endpoint, a staging step places the pinned main weights from that endpoint
  (falling back to huggingface.co) before the engine fetch runs, and the
  text encoder uses the same endpoint. Downloads go direct without touching
  your system proxy; the proxy is only used as a last resort, announced in
  the log. Resumable per file, verified by the engine's own pinned hashes.
- `mirror` now accepts any `https://` URL, not just the two known names.

## [0.2.7] - 2026-11-13

English readme synced with the Chinese one: same three-step intro,
Hugging Face/pinned-version sentence in the license section, text encoder
in the status list.

## [0.2.6] - 2026-11-13

Resource table trimmed to what users act on, all figures rounded with "~";
setup-time numbers marked as reference only (measured on an M5 Ultra 256 GB).
Dev section rewritten in a plainer voice.

## [0.2.5] - 2026-11-13

Plain wording pass over the readme and plugin descriptions:
no internal jargon (pinned/host/ledger/egress/miss).

## [0.2.4] - 2026-11-13

Requirements: say "Apple Silicon (M1 or later)" instead of
"arm64" — the chip name means nothing to most Mac users.

## [0.2.3] - 2026-11-13

Rewrite the Chinese readme in plainer language.

## [0.2.2] - 2026-11-13

Add npm search keywords (minimax, minimax-h3-image, h3-image) and
homepage/bugs links.

## [0.2.1] - 2026-11-13

License gate now covers both upstream agreements: the quantized text
encoder carries its own MiniMax H3 Community License, so the wizard lists
both agreements with direct links to their full texts and names the
territorial exclusions (EU/UK/KR/US). Acceptance records both agreement
names; a record naming only one must be re-confirmed. Docs and notices
corrected accordingly.

## [0.2.0] - 2026-11-13

Setup wizard, accepted via a from-zero bare-metal run.

### Added
- `h3_setup` is now a resumable setup state machine:
  `check → venv → engine → license → weights → smoke`, each step re-probing
  the disk as its own truth (a step already complete on disk is a `noop`,
  so re-runs are idempotent and a kill-then-resume never repeats finished
  work).
- Detached long jobs for the hour-scale steps (engine install, weight
  download + conversion, smoke): submit returns a `job_id` in seconds;
  `action=poll` reads progress from the engine's own on-disk state
  (`.part` files, `convert_state.json`, the fetch script's done-list) —
  never from exit codes. Jobs live in a detached supervisor process: a
  host restart marks their records `interrupted`, never "done", and
  re-running the same action resumes from `.part` (Range requests;
  finished shards are never re-fetched — verified zero re-downloads in
  the acceptance resume audit).
- Re-entrancy guard: submitting a step while a live job for it exists
  attaches to the running job instead of starting a second fetch (two
  fetchers on one `.part` corrupts it — a real incident, now structurally
  prevented).
- Reuse probe for the text encoder honours a configurable `scan_dirs`
  list; an empty list is a true bare-metal simulation (probe must report
  a miss, never silently reuse).
- `venv` step discovers a suitable CPython (brew / python.org / uv /
  pyenv, or an explicit `python_bin` override) and creates an isolated
  environment without touching any hosted app.
- Measured resource ledger in the README (disk peak 58.6 GB, steady 53.2
  GB, per-shard 4–5 min, resume segment 41 min, smoke 30 s wall / 10.8 s
  engine, 27.5 GB peak per 1 MP image) — all from the acceptance run.

### Changed
- `LIMITS.diskMinFreeGB` 80 (placeholder) → 60, backfilled from the
  measured bare-metal peak (58.6 GB decimal, rounded up), per TEST-PLAN's
  "shipped numbers come from measurement only".

### Fixed
- `h3_setup action=status|check` and job polling (`running`/`done`/
  `killed`) now emit the schema-required `message` field — found by live
  verification after reinstall (the bare-metal driver called the internal
  API directly and could not see it).

## [0.1.0] - 2026-11-12

Generation pipeline.

### Added
- `h3_image`: real local text-to-image. Spawns the pinned engine per call
  (subprocess, no resident process), parses the engine metrics JSON, enforces
  an internal deadline (default 240 s, cap 900 s, SIGKILL on expiry), and
  validates the PNG structurally (magic + IHDR + IEND) before reporting
  success — a truncated file is a `verify` failure, never a silent pass.
- Concurrency gate = 1: a second call while one is running returns a
  structured `busy` envelope immediately (no queue, no memory pile-up).
  Plugin unload kills the live child.
- License record (`h3-plugin-state.json` next to the weights): `h3_setup
  action=license` shows the community-license summary; acceptance is recorded
  only via an explicit `accept: true` from you — the plugin never accepts on
  your behalf. `h3_image` refuses with a structured `license` envelope until
  a matching record exists.
- Error taxonomy on every failure path: `network | disk | license | memory |
  verify | engine | timeout | busy | unsupported_platform`, each with a
  message and a fix hint; user-visible paths are `~`-relative only.
- Capability refusals are explicit: reference-image / edit / strength-style
  arguments are rejected with a "pure text-to-image" explanation instead of
  being silently ignored.
- `output_dir` is fenced to the session workspace; escapes are refused before
  anything spawns.
- `h3_status` now reports `text_dir` / `text_config` and probes the text
  encoder at the path the engine actually loads.

### Fixed
- `resolveConfig` no longer throws when `model_dir` is configured without the
  sibling directories.

## [0.0.1] - 2026-11-12

Initial plugin scaffold.

### Added
- Bundle scaffold: `package.json`, `cordis.patch.yml`, locales (en/zh), icon,
  MIT `LICENSE`, `THIRD_PARTY_NOTICES.md`, `SECURITY.md`.
- `h3_status` tool: read-only environment check (platform, memory, python,
  engine commit, weights, text encoder, disk) returning a structured
  red/green checklist. Red items are expected until the setup wizard
  lands.
- `h3_setup` / `h3_image` registered as explicit not-implemented stubs that
  return structured guidance instead of failing opaquely.
- Pinned version constants (`lib/pinned.js`): engine commit, weight
  revisions, reuse-probe candidates (hash-verified only).
- Release gates: `scripts/check-release-safety.mjs` (source + tarball scan),
  `scripts/check-version-consistency.mjs`; CI runs tests + both gates.
