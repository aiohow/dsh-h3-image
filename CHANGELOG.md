# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.14] - 2026-11-13

README: 32 GB is now called what it is — a stretch config. Fanless machines
(MacBook Air class) throttle under sustained generation and take longer.

## [0.2.13] - 2026-11-13

Memory is now reported in the unit the box uses. A machine sold as 32 GB
reports 34.4e9 bytes; dividing by 1e9 showed it as "34 GB" and read like a
different machine. Thresholds and tiers are unchanged — this is display and
matching only.

## [0.2.12] - 2026-11-13

Gate fix found on a 34 GB MacBook Air: a warning-tier check (memory between
the hard floor and the recommendation) kept `h3_status` at `setup_required`
forever, and `h3_image` refuses anything but `ready` — so generation was
locked out on a workable machine even after every step had passed.
`overallOf` now treats `warning: true` checks as caveats: the line still
shows its detail, but it no longer blocks the overall verdict. Real
blockers and refused platforms are unaffected; the wizard's explicit
`confirm_risk` gate for below-recommended memory is untouched.

- Two regression tests: warning-only reads ready; a real blocker alongside
  a warning still reads setup_required.

## [0.2.11] - 2026-11-13

Large files (64 MB and up) now download in 4 concurrent byte-range segments,
each with its own resumable part file; once all segments are in they are
stitched and go through the same size + sha256 verification as before. A
server that answers a Range request with 200 is treated as lacking the
capability: the segment parts are cleaned and the untouched single-stream
path takes over. Small files, the endpoint ladder (two direct rounds, then
one announced system-proxy round) and every progress line are unchanged.
Stitching briefly needs roughly one extra copy of the file on disk.

- README: the per-shard time estimate is replaced with an honest statement
  that download time depends on your network and machine; the segmented
  download and its automatic fallback are documented.
- Three new tests: segmented byte-exactness with exact closed-range tiling,
  the 200 fallback to single stream, and a half-written segment resuming
  with a Range pinned to its own end.

## [0.2.10] - 2026-11-13

Staging driver hardening from a real-world mirror outage (a user's download
 stalled when the mirror began answering every pinned-file request with a
 redirect back to the origin, and bursty timeouts killed the run after one
 try per endpoint):

- Two direct rounds before the system-proxy round. Mirror flakiness is
  bursty; a second direct attempt is free, proxy bytes are not. The failed
  first round is announced with the error.
- When a redirect chain lands on a different host than the endpoint asked
  for (a mirror bouncing to the origin), a `note:` line names the host the
  bytes actually come from, so a slow transfer is attributed correctly.
- New regression test: a server that fails the first request per file and
  then serves normally must recover on the second direct round without any
  mention of the proxy round.

## [0.2.9] - 2026-11-13

### Changed
- The plugin title now carries the package name in both locales, so the
  entry in the plugin list matches the npm name for every language.

### Docs
- Install section covers the GUI path (Settings > Plugins) and notes that
  an npm mirror can lag behind the official registry.

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
