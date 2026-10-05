# jev-router-local

Fork of [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router) that routes with a
**local JevK5 model on llama-server** instead of the TypeSafe API. No API key, and no prompt text
leaves this machine. `@typesafe-ai/sdk` was removed.

What changed: `src/router.mjs` (`askJev` now calls llama-server), `src/config.mjs` (local question
builders, longer timeouts), the launchers (no `JEV_API_KEY` gate), and one test string.

## Run

1. Start the server (`jevk5-9b-v0.3.3-Q6_K.gguf`, port 8080).
2. `jev-claude` (installed with `npm link`). Needs a valid `claude login`.

## Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `JEV_LOCAL_URL` | `http://127.0.0.1:8080` | llama-server address |
| `JEV_LOCAL_TEMPERATURE` | `1.316` | Calibration temperature of the model file (9B v0.3.3). Other files have other values; see the model card |
| `JEV_LOCAL_DEADLINE_MS` | `25000` | Hard limit for one routing decision |
| `JEV_MAX_PROMPT_CHARS` | `1500` | Prompt text sent to the model (head and tail kept) |
| `JEV_DISABLE` | unset | `1` starts the CLI without routing |
| `JEV_DASHBOARD_PORT` | `8787` | Port for `jev-dashboard` (read-only web view of sessions and the routing ledger) |
| `JEV_DOWNGRADE_CUTOFF_TOKENS` | `20000` | Conversation size above which an automatic downgrade is refused (prompt-cache rebuild not worth it) |

## Notes

- `routing.jsonl` lives alongside the per-session status files (same temp directory,
  mode 0600) and is read only by `jev-dashboard`. One line per routed decision, without the
  prompt text or the exact Jev exchange that the status files carry -- it is meant to live
  longer (across sessions and restarts), so it carries less.

- `jev-claude.lock` (same directory) names the pid of the currently running `jev-claude`
  session. A hard kill (`taskkill /F`, Task Manager "End Task", power loss) cannot be
  intercepted by any process on any platform, so a session killed that way skips restoring
  `~/.claude/settings.json` and can leave the routing sentinel stuck there, breaking plain
  `claude`. The *next* `jev-claude` checks whether the lock's pid is still running; if it
  is not, it clears the stuck sentinel before doing anything else. SIGTERM/SIGHUP are still
  handled for a graceful stop request (a real signal on POSIX; closing the console window maps
  to SIGHUP on Windows) -- neither of those help against a hard kill, which this heal check is
  what actually recovers from.

- One decision = 4 parallel questions (tier choice + 3 complexity scores). Measured about 1.4 s
  warm and about 15 s on the very first call after the server loads.
- llama-server splits `-c` across its slots: `-c 4096` with 4 slots leaves 1024 tokens per request.
  The client shrinks long prompts to fit; adding `-np 2` to the server gives each request more room.
- `confidence` is the probability of the chosen option, not the TypeSafe distribution-concentration measure.
