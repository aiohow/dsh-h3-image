# Contributing

Thanks for your interest in improving dsh-h3-image!

## Before you start

- **Open an issue before a pull request** for anything beyond a typo or an
  obvious bug. Design decisions here (resource thresholds, the job model, the
  license gate) have measured reasons behind them — see the resource ledger in
  the README and `docs/` — and we would rather agree on the approach first.
- One PR does one thing. Code and its documentation change together.

## Ground rules specific to this project

- **No machine paths, no personal data, no secrets** in code, comments,
  commit messages or docs. The release gate
  (`scripts/check-release-safety.mjs`) scans the source tree *and* the built
  tarball for home-directory paths, usernames and credential shapes; a PR
  that trips it will not merge.
- **Shipped numbers come from measurement.** Resource thresholds
  (`lib/pinned.js` `LIMITS`) and README claims must cite a measured run, not
  an estimate. If you change one, attach the measurement.
- **Pinned versions are single-point.** The engine commit, weight revisions
  and sha256 tables live only in `lib/pinned.js`. Never duplicate them
  elsewhere; upgrading means editing that one file and re-running the smoke
  test.
- The plugin never accepts the MiniMax community license on the user's
  behalf, never phones home, and never claims a step is done without a disk
  probe. Changes that weaken any of these will not merge.

## Workflow

```sh
npm test              # unit tests (pure logic, no engine needed)
npm run release       # version-consistency + release-safety gates + pack + tarball scan
```

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`), one
  sentence, imperative.
- Version bumps happen in `package.json`; the consistency gate sync-checks
  CHANGELOG, locales and pinned revisions for you (`npm run release` fails
  on drift).
- Bilingual surfaces: user-visible strings live in `locale/en.json` and
  `locale/zh.json`; the README has a paired `README.md` / `README.zh.md`.
  Change one, change the other, in the same PR.

## Reporting issues

Use the issue templates. For setup or generation failures, include the
output of `h3_status` (it contains no personal paths) and your machine's
unified-memory size. Redact anything you do not want public.
