# Security policy

## Design summary

- **No secrets.** The plugin has no API keys, tokens, or credentials of any
  kind. Local inference needs none.
- **Zero runtime egress.** Generation is pure local subprocess work. The only
  network activity in the plugin's lifetime is the setup wizard fetching the
  pinned engine (GitHub) and weights (huggingface.co, or an optional
  hf-mirror you explicitly choose). Every fetched file is sha256-verified
  against a value recorded in `lib/pinned.js`.
- **Sandboxed outputs.** Generated images are written inside the session
  workspace by default; an `output_dir` outside the workspace is rejected.
- **Subprocess discipline.** The engine runs as a child process from the
  pinned commit inside an isolated venv; prompts are passed as arguments,
  never interpolated into a shell string. Concurrency gate = 1.
- **License self-acceptance.** Weight download requires the user's own
  acceptance of the MiniMax community license (including its territorial
  terms); the plugin records the acceptance timestamp locally and never
  accepts on the user's behalf.

## Reporting a vulnerability

Open a **private security advisory** on the GitHub repository
(`aiohow/dsh-h3-image` → Security → Report a vulnerability). Please do not
open a public issue for unfixed vulnerabilities. We aim to respond within 7
days.

## Out of scope

- Vulnerabilities in the upstream engine (`minimax-h3-mlx`) or model weights
  — report those to their respective upstreams; we will pin a fixed revision
  promptly if a release affects users.
- Attacks that already require code execution on your machine.
