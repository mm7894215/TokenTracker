<div align="center">

# TOKEN TRACKER

**Track AI Token Usage Across All Your CLI Tools**

[![Website](https://img.shields.io/badge/Website-token.rynn.me-blue.svg)](https://token.rynn.me)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/tokentracker-cli.svg)](https://www.npmjs.com/package/tokentracker-cli)
[![Node.js Support](https://img.shields.io/badge/Node.js-≥20-brightgreen.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-macOS-lightgrey.svg)](https://www.apple.com/macos/)

<img src="https://raw.githubusercontent.com/mm7894215/tokentracker/main/docs/screenshots/dashboard-dark.png" alt="Token Tracker Dashboard (Dark)" width="800" />

</div>

---

## Two Ways to Use

### Option A: macOS Menu Bar App (Recommended)

Download `TokenTrackerBar.dmg` from the [latest release](https://github.com/mm7894215/tokentracker/releases/latest), drag to Applications, done.

- Lives in your menu bar — click to see usage stats
- Auto-syncs data from all supported CLI tools
- No terminal, no Node.js, no setup required
- **Clawd pixel companion** — animated menu bar icon with breathing, blinking, and eye tracking
- **Interactive dashboard buddy** — Clawd reacts to your usage data with 30+ contextual quips, 5 tap animations, and data-driven moods

<div align="center">
  <img src="https://raw.githubusercontent.com/mm7894215/tokentracker/main/docs/screenshots/menubar.gif" alt="Menu Bar App" width="420" />
</div>

#### First launch: Gatekeeper may block the app

TokenTrackerBar is distributed **ad-hoc signed** (not notarized with an Apple Developer ID — that requires a paid account). macOS Gatekeeper may block the first launch with one of two messages. Pick the matching fix:

**Case 1 — "TokenTrackerBar can't be opened because Apple cannot check it for malicious software"** (or "unidentified developer")

1. Open **System Settings → Privacy & Security**
2. Scroll to the **Security** section — you'll see a line like *"TokenTrackerBar was blocked to protect your Mac."*
3. Click **Open Anyway** next to it
4. Confirm with **Open** in the follow-up dialog (you'll need to authenticate)

You only need to do this once. Older macOS alternative: right-click the app in Finder → **Open** → **Open** in the confirmation dialog.

**Case 2 — "TokenTrackerBar is damaged and can't be opened. You should move it to the Trash"**

This is Gatekeeper reacting to the `com.apple.quarantine` attribute macOS attaches to every downloaded file, not an actual problem with the app. Clear it once with:

```bash
xattr -cr /Applications/TokenTrackerBar.app
```

After that the app opens normally. You only need to do this once per download.

### Option B: CLI + Web Dashboard

```bash
npx tokentracker-cli
```

One command does everything: first-time setup → hook installation → data sync → open dashboard at `http://localhost:7680`.

Install globally for shorter commands:

```bash
npm i -g tokentracker-cli
tokentracker              # Open dashboard
tokentracker sync         # Manual sync
tokentracker status       # Check hook status
tokentracker doctor       # Health check
```

---

<div align="center">
  <img src="https://raw.githubusercontent.com/mm7894215/tokentracker/main/docs/screenshots/dashboard-light.png" alt="Token Tracker Dashboard (Light)" width="800" />
</div>

## Leaderboard

Compare your token usage with developers worldwide. Sign in to join the ranking.

<div align="center">
  <img src="https://raw.githubusercontent.com/mm7894215/tokentracker/main/docs/screenshots/leaderboard.png" alt="Leaderboard" width="800" />
</div>

## Features

- **Multi-Source Tracking** — Claude Code, Codex CLI, Cursor, Kiro, Gemini CLI, OpenCode, OpenClaw, Every Code
- **Local-First** — All data stays on your machine. No cloud account required.
- **Zero-Config** — Hooks auto-detect and configure on first run
- **Built-in Dashboard** — Web UI with usage trends, model breakdowns, heatmaps
- **Leaderboard** — Global ranking with weekly, monthly, and all-time stats
- **Privacy-First** — Only token counts tracked, never prompts or responses

## Supported CLI Tools

| CLI Tool | Auto-Detection |
|----------|----------------|
| **Claude Code** | ✅ |
| **Codex CLI** | ✅ |
| **Cursor** | ✅ (via API) |
| **Kiro** | ✅ |
| **Gemini CLI** | ✅ |
| **OpenCode** | ✅ |
| **OpenClaw** | ✅ |
| **Every Code** | ✅ |

## How It Works

```
AI CLI Tools (Claude, Codex, Cursor, Kiro, Gemini, OpenCode, ...)
    │
    │  hooks auto-trigger on usage
    ▼
Token Tracker (local parsing + aggregation)
    │
    │  30-minute UTC buckets
    ▼
Dashboard (Menu Bar App or localhost:7680)
```

1. AI CLI tools generate logs during usage
2. Lightweight hooks detect changes and trigger sync (Cursor: usage pulled via API)
3. CLI parses logs locally, extracts only token counts
4. Data aggregated into 30-minute buckets
5. Dashboard reads local data directly — no cloud needed

## Privacy

| Protection | Description |
|------------|-------------|
| **No Content Upload** | Never uploads prompts or responses — only token counts |
| **Local Only** | All data stays on your machine, all analysis local |
| **Transparent** | Audit the sync logic in `src/lib/rollout.js` — only numbers and timestamps |

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TOKENTRACKER_DEBUG` | Enable debug output (`1` to enable) | - |
| `TOKENTRACKER_HTTP_TIMEOUT_MS` | HTTP timeout (ms) | `20000` |
| `CODEX_HOME` | Codex CLI directory override | `~/.codex` |
| `GEMINI_HOME` | Gemini CLI directory override | `~/.gemini` |

## Development

```bash
git clone https://github.com/mm7894215/tokentracker.git
cd tokentracker
npm install

# Build and run web dashboard
cd dashboard && npm install && npm run build && cd ..
node bin/tracker.js

# Run tests
npm test
```

### Building the macOS App

```bash
cd TokenTrackerBar
npm run dashboard:build          # Build dashboard (from repo root)
./scripts/bundle-node.sh         # Download Node.js + bundle tokentracker
xcodegen generate                # Generate Xcode project
ruby scripts/patch-pbxproj-icon.rb  # Patch Icon Composer support
xcodebuild -scheme TokenTrackerBar -configuration Release clean build
./scripts/create-dmg.sh          # Create distributable DMG
```

Requires: Xcode 16+, [XcodeGen](https://github.com/yonaskolb/XcodeGen)

## Credits

Clawd pixel art inspired by [Clawd-on-Desk](https://github.com/Angel2518975237/Clawd-on-Desk) by [@marciogranzotto](https://github.com/marciogranzotto).
Clawd character design belongs to Anthropic. This is a community project with no official affiliation with Anthropic.

## License

[MIT](LICENSE)

---

<div align="center">
  <b>Token Tracker</b> — Quantify your AI output.<br/>
  <a href="https://token.rynn.me">token.rynn.me</a> · Made by developers, for developers.
</div>
