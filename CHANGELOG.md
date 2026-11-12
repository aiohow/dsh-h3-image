# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
