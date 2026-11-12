# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
