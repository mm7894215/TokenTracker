# OpenClaw Integration

How TokenTracker collects token usage from OpenClaw, and what to check when it isn't working.

## TL;DR

You do **not** need to download, copy, or drag any plugin into OpenClaw. Running `tokentracker` (or `tokentracker init`) once handles the whole installation.

## How it works

TokenTracker ships a small OpenClaw session plugin (`openclaw-session-sync`) inside the `tokentracker-cli` npm package. It lives at:

```
~/.tokentracker/tracker/openclaw-plugin/openclaw-session-sync/
├── package.json
├── openclaw.plugin.json
└── index.js
```

During `tokentracker init`, TokenTracker:

1. Writes the plugin files to the path above.
2. Calls OpenClaw's own CLI: `openclaw plugins install --link <that path>`.
3. Calls `openclaw plugins enable openclaw-session-sync`.
4. Ensures `plugins.entries.openclaw-session-sync.hooks.allowConversationAccess` is `true` in OpenClaw's config.
5. The plugin registers a session listener inside OpenClaw. After you restart the OpenClaw gateway, every completed session gets a token-usage record that TokenTracker reads during `sync`.

OpenClaw requires `allowConversationAccess` before non-bundled plugins can register session lifecycle hooks such as `agent_end`. TokenTracker needs that event to know when a session has finished and a sync should run.

The plugin only passes session identifiers, model names, timestamps, and token counters into TokenTracker. It never reads or transmits prompt or response content.

## Passive transcript scanning (fallback for missed sessions)

The session plugin is the fast path, but it can't cover every case: messages that
arrive through a channel (for example a WeChat ClawBot) may carry a session key the
plugin can't map back to a `sessions.json` entry, the gateway may not have loaded the
plugin yet, or a newer OpenClaw build may keep runtime rows in SQLite and only leave
archived transcripts on disk. In all of those cases usage exists but would otherwise
show as 0.

To close that gap, a full `tokentracker sync` also passively scans every transcript
under `~/.openclaw/agents/*/` and counts their token usage directly — no plugin event
required. The per-event identity dedup makes the plugin path and the passive scan
idempotent, so a session counted by both is never double counted, and the
`sessions.json` totals fallback defers to real transcript events once it sees them.

Scanned locations, per agent:

- `sessions/*.jsonl` — the live transcripts.
- `sessions/*.jsonl.reset.<iso>` and `*.jsonl.deleted.<ts>` — archives left behind by
  session resets and deletes.
- `session-sqlite-import-archive/*.jsonl` — where the SQLite migration moves
  still-hot transcripts. Note this is a *sibling* of `sessions/`, not a child.

### Windows: the state directory is usually inside WSL

OpenClaw's recommended Windows install (Windows Hub → "Set up locally") provisions an
app-owned `OpenClawGateway` WSL distro and runs the gateway inside it. `.openclaw` then
lives on the distro's Linux home and `C:\Users\<you>\.openclaw` stays empty. TokenTracker
probes the WSL distro home on Windows for exactly this reason. Only the native path is
scanned when `TOKENTRACKER_OPENCLAW_HOME`, `OPENCLAW_HOME` or `OPENCLAW_STATE_DIR` is set —
an explicit override means you have told us where to look.

If usage still reads 0 on Windows, check where the gateway actually runs:

```bash
openclaw gateway status --json
openclaw --version
```

### Known expiry: the SQLite flip

Upstream moved runtime session and transcript rows into
`~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`, leaving `sessions/` as a
legacy/archive location. That change is not in the stable line yet, so JSONL scanning
still covers current installs — but once it ships, transcripts alone will stop reflecting
new usage and this reader will need a SQLite path.

## Verifying the install

Run:

```bash
tokentracker status
```

Look for the `OpenClaw Session Plugin` row. Expected states:

| Status | Meaning |
|---|---|
| `installed` | Plugin is linked and enabled. Restart the OpenClaw gateway once so it loads. |
| `set` | Plugin is already active in the running OpenClaw process. |
| `skipped` | Something prevented the install. See the `detail` column. |

For deeper checks, `tokentracker status --json` and `tokentracker diagnostics` expose `openclaw_session_plugin_conversation_access`. A linked and enabled plugin without conversation access is not considered fully configured, because OpenClaw will block the `agent_end` hook that triggers automatic sync.

## Troubleshooting

If `tokentracker status` shows `skipped`, the `detail` column tells you which case applies:

### `OpenClaw CLI not found`

The `openclaw` binary is not on your `PATH`. TokenTracker cannot link a plugin without it.

**Fix:** install OpenClaw globally, confirm `openclaw --version` works in a fresh terminal, then re-run `tokentracker init`.

### `OpenClaw config unreadable` / `OpenClaw config not found`

TokenTracker could not read `~/.openclaw/openclaw.json`. This usually means OpenClaw has never been launched on this machine, or the config path is in a non-default location.

**Fix:**
- Launch OpenClaw once so it generates its config.
- If you use a custom location, set `OPENCLAW_CONFIG_PATH` to the absolute path before running `tokentracker init`.

### `Install failed: …`

OpenClaw's own CLI rejected the `plugins install --link` command. The `detail` includes the stderr from OpenClaw.

**Fix:** try the command manually to reproduce it:

```bash
openclaw plugins install --link ~/.tokentracker/tracker/openclaw-plugin/openclaw-session-sync
openclaw plugins enable openclaw-session-sync
```

Then make sure `~/.openclaw/openclaw.json` includes:

```json
{
  "plugins": {
    "entries": {
      "openclaw-session-sync": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

If that surfaces a clearer error (e.g. version mismatch, locked config file), resolve it there, then re-run `tokentracker init`.

## Removing the plugin

```bash
openclaw plugins disable openclaw-session-sync
openclaw plugins uninstall openclaw-session-sync
```

Or run `tokentracker uninstall` to remove hooks and plugins for every integration at once.

## Where to look in the source

- `src/lib/openclaw-session-plugin.js` — installer, probe, plugin-file builders.
- `src/commands/init.js` — calls `installOpenclawSessionPlugin` and reports its result.
- `src/lib/rollout.js` — parses OpenClaw session records during `tokentracker sync`.
