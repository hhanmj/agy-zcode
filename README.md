# agy-zcode — Google Antigravity CLI delegation for ZCode

A [ZCode](https://zcode.ai) plugin that delegates real coding tasks to the
logged-in **Google Antigravity CLI (`agy`)** through a local MCP server.
**No Gemini API key is involved**: agy authenticates through your Antigravity
login (system keyring / Google Sign-In).

Ported from the DSH plugin
[dsh-subagent-agy](https://github.com/hhanmj/dsh-agy) (itself based on
[ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy), MIT):
the core logic — stream-json parsing, change evidence, execution traces,
model resolution — is shared; the outer shell is an MCP server instead of a
DSH subagent provider.

中文说明见 [plugin/README.md](plugin/README.md)。

## What you get

| Tool | What it does |
|---|---|
| `agy_run` | new task; foreground by default, `background: true` returns a task key immediately |
| `agy_followup` | continue the same agy conversation via its task key |
| `agy_status` | task status + live progress; incremental reads via `next_offset` |
| `agy_tasks` | list running, session-finished and recorded (resumable) tasks |
| `agy_cancel` | stop a running task (terminates the whole agy process tree) |
| `agy_evidence` | independently collected working-tree change evidence; review stays `pending` |
| `agy_trace` | agy's own execution record: steps, internal tool calls, result, timeout/cancel |
| `agy_models` | list what `agy models` really reports (models + effort variants) |
| `agy_login` | pop the interactive agy login window |
| `agy_accounts` | account library and quota rotation: capture / list / switch / remove / config |

Installing the plugin also brings a skill (`agy-delegation`) and a native
subagent (`agy`) — the latter needs the bundled local model gateway
(Anthropic Messages-compatible, `127.0.0.1:8378`) registered as a ZCode
custom model provider, so agy models appear in `/model` and native subagents
can be used directly.

## Install

Prerequisites: `agy` installed and logged in once (`irm
https://antigravity.google/cli/install.ps1 | iex` on Windows, then run `agy`
and sign in); Node.js ≥ 20; ZCode on PATH.

```bash
npm install && npm run build
zcode plugins marketplace add <repo>/dist/market
zcode plugins install agy-delegate@agy-local --scope user
```

See [plugin/README.md](plugin/README.md) for the full walkthrough: upgrades
(with backup + rollback), version checks, the model gateway, supervision
(opt-in command policy for agy), persistent sessions, and the account
library.

### Agent-driven deploy

The only step a coding agent cannot do for you is the interactive Google
sign-in. Install `agy` and sign in yourself first (your account's tier
decides which models you get), then paste this into ZCode or any agent with
shell access:

> Clone https://github.com/hhanmj/agy-zcode, run `npm install && npm run
> build` inside it, then `zcode plugins marketplace add <clone>/dist/market`
> and `zcode plugins install agy-delegate@agy-local --scope user`. Follow
> plugin/README.md to register the model gateway as a ZCode custom
> anthropic-messages provider, restart ZCode, and verify with `agy_models`.

The repository is self-contained: the shared DSH modules are vendored under
`shared/` (MIT, [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)),
so a plain clone builds without any parent project. After code changes,
`npm test` runs the full offline suite against a fake agy.

## Build & test

```bash
npm run build        # esbuild bundle + dist/market layout; validates version consistency
npm run typecheck    # tsc over src/
npm test             # build + all offline tests (node --test test/*.test.mjs)
node test/live-smoke.mjs   # opt-in live round trip against real agy (uses quota)
```

## Safety notes

- No credential, OAuth token, API key, or account state is bundled or checked
  into this repository. The account library keeps tokens in the plugin data
  directory only; tool responses and logs carry emails, never tokens.
- `--dangerously-skip-permissions` is the default (headless agy needs it);
  supervision (`AGY_MCP_SUPERVISION`) is a separate opt-in guardrail that
  applies agy hook-based command policies, protects host paths, and refuses
  to start if it cannot be applied.
- Test files matching `*.local.mjs` are git-ignored (they may contain
  machine-specific data); keep personal panels and probes out of git.

## License

MIT. Original work: [ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy).
