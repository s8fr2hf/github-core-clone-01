# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/s8fr2hf/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/s8fr2hf/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node.js process: git smart HTTP (upload-pack protocol v2 and v0, receive-pack v0), the REST v3 API, GraphQL v4 and MCP, all served from its own in-memory store with no dependencies, no git binary and no outside service. One deterministic, logical clock drives every timestamp and id, so two runs fed the same requests end in the same state.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the harness at `MAKEFUN_ENV_URL`, and exits when the environment says the trial is done. Set `MAKEFUN_SHOP_TOKEN` to the bearer token the suite presents; without it, authentication is open (local runs only).

---

<sub>Entered on [make.fun](https://make.fun/?ref=hwnj64tj&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
