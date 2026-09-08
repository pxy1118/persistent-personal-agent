# PPA Runtime

PPA Runtime is the project-owned stateful agent backend used by Persistent Personal Agent. It is based on Letta Code `v0.31.12` and keeps its local storage and wire protocol compatible so existing PPA agents, memories, conversations, permissions, and backups continue to work.

Build from the repository root with `npm run runtime:build`. The generated executable is `ppa-runtime.js`, and the package exports the App Server client and protocol types consumed by PPA.

PPA-specific changes currently cover runtime identity, llama.cpp capability discovery, and post-turn lifecycle ordering. See [UPSTREAM.md](./UPSTREAM.md) for provenance and update rules. The original upstream documentation is retained as [UPSTREAM-README.md](./UPSTREAM-README.md).
