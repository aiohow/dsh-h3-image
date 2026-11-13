# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-13

Setup-wizard milestone (M2), accepted via a from-zero bare-metal run.

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

Generation milestone (M1).

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

Skeleton milestone (M0).

### Added
- Bundle scaffold: `package.json`, `cordis.patch.yml`, locales (en/zh), icon,
  MIT `LICENSE`, `THIRD_PARTY_NOTICES.md`, `SECURITY.md`.
- `h3_status` tool: read-only environment check (platform, memory, python,
  engine commit, weights, text encoder, disk) returning a structured
  red/green checklist. Red items are expected until the setup wizard (M2)
  lands.
- `h3_setup` / `h3_image` registered as explicit not-implemented stubs that
  return structured guidance instead of failing opaquely.
- Pinned version constants (`lib/pinned.js`): engine commit, weight
  revisions, reuse-probe candidates (hash-verified only).
- Release gates: `scripts/check-release-safety.mjs` (source + tarball scan),
  `scripts/check-version-consistency.mjs`; CI runs tests + both gates.
