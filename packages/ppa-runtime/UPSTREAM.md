# Upstream provenance

- Project: `letta-ai/letta-code`
- Tag: `v0.31.12`
- Commit: `787b856f9db9f5030dc2976618e1d1f909f61612`
- Imported: 2026-09-08
- License: Apache-2.0; the upstream `LICENSE` is retained in this package.

PPA Runtime deliberately retains Letta-compatible storage paths, environment variables, protocol fields, and indirect client dependencies in this first phase. `upstream_letta_code_version` in the App Server handshake records this baseline separately from `ppa_runtime_version`.

When updating, import a reviewed upstream tag, rebuild from a clean npm install, rerun the focused runtime tests and the root PPA acceptance suite, then verify an existing backed-up Agent ID and conversation set before switching the daily data directory.
