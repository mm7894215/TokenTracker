# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
npm test                              # Run all tests (node --test test/*.test.js)
node --test test/rollout-parser.test.js  # Run a single test file
npm run ci:local                      # Full local CI (tests + validations + builds)
npm run dashboard:dev                 # Dashboard dev server with local API mock
npm run dashboard:build               # Build dashboard to dashboard/dist/
npm run validate:copy                 # Validate copy registry completeness
npm run validate:ui-hardcode          # Check for hardcoded UI strings
npm run validate:guardrails           # Validate architecture guardrails
node bin/tracker.js serve --no-sync   # Start local dashboard server
```

## Architecture

Token Tracker is a local-first AI token usage tracker. It collects token counts from multiple AI CLI tools via hooks, aggregates locally, and displays in a built-in web dashboard and native macOS menu bar app.

### Data Flow

```
AI CLI Tools → hooks/notify.cjs trigger sync → rollout.js parses logs → queue.jsonl → local API → dashboard
```

### Three Layers (this repo) + Cloud Backend (separate repo)

**CLI (`src/`)** — Node.js CommonJS. Entry: `bin/tracker.js` → `src/cli.js` dispatches commands. Default command (no args) runs `serve` which auto-runs `init` on first use, then launches local HTTP server on port 7680.

**Dashboard (`dashboard/`)** — React 18 + Vite 7 + TypeScript + TailwindCSS. Built to `dashboard/dist/` and served by the CLI's `serve` command. In local mode (`localhost`), skips auth and reads data from local API endpoints. Deployed to Vercel at token.rynn.me for cloud mode.

**macOS App (`TokenTrackerBar/`)** — Native Swift 5.9 menu bar + widget app. Embeds a complete Node.js + tokentracker runtime (`EmbeddedServer/`, universal arm64+x64). Hosts the React dashboard via WKWebView and provides native UI panels (usage summary, heatmap, model breakdown, usage limits, Clawd companion). Ships a `TokenTrackerWidget` WidgetKit target. Built with XcodeGen.

**Cloud backend** — InsForge Edge Functions live in a separate repo and are documented in `BACKEND_API.md`. Handles cloud authentication, leaderboard, and data sync. Not needed for local-only usage.

### Supported AI Tools (13 providers)

| Tool | Hook Method | Parser |
|------|------------|--------|
| Claude Code | SessionEnd hook in settings.json | `normalizeClaudeUsage` |
| Codex CLI | TOML notify array in config.toml | Rollout JSONL |
| Cursor IDE | API-based (SQLite auth + CSV fetch) | `normalizeCursorUsage` |
| Gemini CLI | SessionEnd hook in settings.json | `diffGeminiTotals` |
| OpenCode | Plugin system + SQLite DB | `normalizeOpencodeTokens` |
| OpenClaw | Session plugin (modern) | Rollout JSONL |
| Every Code | TOML notify array (same as Codex) | Rollout JSONL |
| Kiro | SQLite + JSONL hybrid | Rollout JSONL |
| Hermes Agent | SQLite sessions table (`~/.hermes/state.db`) | `parseHermesIncremental` |
| GitHub Copilot | OpenTelemetry file exporter (`COPILOT_OTEL_FILE_EXPORTER_PATH`) | Rollout JSONL |
| Kimi Code | Passive `wire.jsonl` reader (`~/.kimi/sessions/**/wire.jsonl`) | `parseKimiIncremental` |
| oh-my-pi (omp) | Passive JSONL reader (`~/.omp/agent/sessions/**/*.jsonl`) | `parseOmpIncremental` |
| CodeBuddy (Tencent) | SessionEnd hook in `~/.codebuddy/settings.json` (Claude-Code fork) | `parseCodebuddyIncremental` |

### CLI Commands

| Command | Purpose |
|---------|---------|
| `serve` | Start local HTTP server on :7680, auto-runs init on first use |
| `init` | Setup wizard: consent → detect CLIs → install hooks → browser auth |
| `sync` | Parse all log sources → queue.jsonl → upload to cloud (if token set) |
| `status` | Display integration status for all AI tools |
| `doctor` | Health check: backend, tokens, queue, hooks |
| `diagnostics` | Export full system state as JSON |
| `uninstall` | Remove all hooks and config |
| `activate-if-needed` | Auto-detect & configure unconfigured AI CLIs |

### Key Source Files — CLI

- `src/lib/rollout.js` (3020 lines) — Core parser. Handles all 9 log formats. Aggregates into 30-minute UTC buckets. Contains per-provider normalizers + `parseHermesIncremental` for SQLite-backed Hermes sessions.
- `src/lib/local-api.js` (961 lines) — Local API handler. Serves 11 endpoints under `/functions/tokentracker-*` and `/api/auth/*`.
- `src/lib/usage-limits.js` (1151 lines) — Rate limit detection via API/CLI introspection for Claude, Codex, Cursor, Gemini, Kiro, Antigravity.
- `src/commands/init.js` (912 lines) — First-time setup. Installs notify.cjs, copies runtime to `~/.tokentracker/app/`, configures hooks for all providers.
- `src/commands/sync.js` (840 lines) — Parses all sources (including Hermes SQLite), queues hourly buckets, uploads in batches (max 5 batches × 200 records).
- `src/commands/serve.js` — HTTP server. Port conflict resolution, CORS, SPA fallback.
- `src/lib/cursor-config.js` — Extracts Cursor auth from local SQLite, fetches usage CSV.
- `src/lib/codex-config.js` — Parse/update Codex & Every Code config.toml notify arrays.
- `src/lib/opencode-config.js` / `src/lib/opencode-usage-audit.js` — OpenCode plugin install + SQLite audit.
- `src/lib/openclaw-session-plugin.js` / `src/lib/openclaw-hook.js` — OpenClaw session plugin + legacy hook.
- `src/lib/subscriptions.js` — Detect Claude Pro, ChatGPT plans via keychain/API.
- `src/lib/project-usage-purge.js` — Purge/trim project-attribution state.
- `src/lib/upload-throttle.js` — Per-device upload rate limiting.
- `src/lib/tracker-paths.js` — Canonical paths under `~/.tokentracker/`.

### Key Source Files — Dashboard

- `dashboard/src/App.jsx` — Router + auth gate. Localhost → dashboard directly; cloud → requires auth. Lazy-loads all pages; `/ip-check`, `/leaderboard/:handle`, and the native-auth callback bypass the sidebar shell.
- `dashboard/src/pages/DashboardPage.jsx` — Main dashboard (lazy-loaded). Period selector, usage panels, charts.
- `dashboard/src/pages/LeaderboardPage.jsx` — Global token usage rankings with sortable columns.
- `dashboard/src/pages/LeaderboardProfilePage.jsx` — Public user profile (standalone chrome; excluded from `AppLayout`).
- `dashboard/src/pages/LandingPage.jsx` — Marketing/onboarding page.
- `dashboard/src/pages/LimitsPage.jsx` — Dedicated usage-limits view (wrapped by `AppLayout`).
- `dashboard/src/pages/SettingsPage.jsx` — User settings + progressive disclosure for account actions.
- `dashboard/src/pages/WidgetsPage.jsx` — Widget gallery (macOS desktop widget previews).
- `dashboard/src/pages/IpCheckPage.jsx` — Standalone Claude IP check tool with dark mode support.
- `dashboard/src/pages/LoginPage.jsx` — Cloud-mode sign-in page.
- `dashboard/src/pages/NativeAuthCallbackPage.jsx` — OAuth callback for the macOS WKWebView bridge.
- `dashboard/src/ui/openai/components/Shell.jsx` / `Sidebar.jsx` — `AppLayout` sidebar shell used by most pages.
- `dashboard/src/ui/matrix-a/views/DashboardView.jsx` — Main layout orchestrator.
- `dashboard/src/ui/matrix-a/components/UsageLimitsPanel.jsx` — Rate limits display per AI tool.
- `dashboard/src/ui/matrix-a/components/TrendChart.jsx` — Line/bar chart with Motion animations.
- `dashboard/src/ui/matrix-a/components/ActivityHeatmap.jsx` — GitHub-style contribution calendar.
- `dashboard/src/ui/share/ShareModal.tsx` + `variants/BroadsheetCard.jsx` + `variants/AnnualReportCard.jsx` — Shareable screenshot cards (Broadsheet + Neon annual-report variant with glassmorphism). `capture-share-card.ts` → html-to-image, `native-save.ts` dispatches to Swift via `NativeBridge`.
- `dashboard/src/hooks/use-usage-data.ts` — Primary data fetching hook.
- `dashboard/src/lib/api.ts` — HTTP client for local & cloud APIs.
- `dashboard/src/lib/copy.ts` — i18n system reading from `content/copy.csv` (~550 strings).
- `dashboard/src/lib/native-bridge.js` — JS half of the Swift ↔ WebView bridge (`getSettings`, `setSetting`, `action`).
- `dashboard/src/contexts/InsforgeAuthContext.jsx` — Cloud OAuth via InsForge SDK.
- `dashboard/src/contexts/LoginModalContext.jsx` — Global sign-in modal controller.

### Key Source Files — macOS App

- `TokenTrackerBar/TokenTrackerBarApp.swift` — Entry point. NSApplicationDelegateAdaptor manages StatusBarController, DashboardViewModel, ServerManager.
- `TokenTrackerBar/Services/ServerManager.swift` — Embedded/system Node.js server lifecycle with health check polling.
- `TokenTrackerBar/Services/StatusBarController.swift` — Menu bar popover UI + status icon animation.
- `TokenTrackerBar/Services/DashboardWindowController.swift` — WKWebView hosting React dashboard.
- `TokenTrackerBar/Services/NativeBridge.swift` — WKScriptMessageHandler bridging dashboard settings/actions to Swift.
- `TokenTrackerBar/Services/APIClient.swift` — HTTP client against the embedded local server.
- `TokenTrackerBar/Services/MenuBarAnimator.swift` — Status icon idle/activity animation.
- `TokenTrackerBar/Services/LaunchAtLoginManager.swift` — `SMAppService.mainApp` wrapper with `@Published` state.
- `TokenTrackerBar/Services/UpdateChecker.swift` — Polls npm registry for CLI updates.
- `TokenTrackerBar/Services/WidgetSnapshotWriter.swift` — Writes App Group snapshots for the desktop widget.
- `TokenTrackerBar/ViewModels/DashboardViewModel.swift` — All dashboard state. Auto-refresh every 5 minutes.
- `TokenTrackerBar/Views/ClawdCompanionView.swift` — Animated pixel art companion with 9 states (DrawCtx + static draw methods).
- `TokenTrackerBar/Views/UsageLimitsView.swift` — Native usage limits display.
- `TokenTrackerBar/Views/UsageTrendChart.swift` / `TopModelsView.swift` / `SummaryCardsView.swift` / `ActivityHeatmapView.swift` — Native panel components. Charts module is hidden on macOS < 13 (the popover auto-shrinks).
- `TokenTrackerBar/Models/LimitsSettingsStore.swift` — UserDefaults persistence for limit preferences.
- `TokenTrackerBar/TokenTrackerWidget/` — Desktop widget target (WidgetKit) reading shared snapshots via App Group.

### Local API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /functions/tokentracker-usage-summary` | Aggregate token totals + 7/30-day rolling stats |
| `GET /functions/tokentracker-usage-daily` | Day-by-day token breakdown |
| `GET /functions/tokentracker-usage-hourly` | Hourly breakdown for selected day |
| `GET /functions/tokentracker-usage-monthly` | Month-by-month trends |
| `GET /functions/tokentracker-usage-heatmap` | Weekly activity grid (52 weeks) |
| `GET /functions/tokentracker-usage-model-breakdown` | Tokens/cost by source + model |
| `GET /functions/tokentracker-project-usage-summary` | Project attribution |
| `GET /functions/tokentracker-usage-limits` | Rate limits & subscription status |
| `GET /functions/tokentracker-user-status` | User status (always pro: true locally) |
| `POST /functions/tokentracker-local-sync` | Trigger sync |
| `GET/POST /api/auth/*` | Proxy to cloud auth |

Query params: `from`, `to` (YYYY-MM-DD), `tz` (timezone), `tz_offset_minutes`, `weeks`, `limit`

### Token Normalization Convention

`input_tokens` = pure non-cached input (no cache_creation/cache_write). `cached_input_tokens` = cache reads. `cache_creation_input_tokens` = cache writes. `total_tokens` = input + output + cache_creation + cache_read (aligned with ccusage). All token types including cache are tracked and included in totals.

### Queue Entry Format

```json
{
  "hour_start": "2026-04-05T14:00:00Z",
  "source": "codex|claude|gemini|opencode|cursor|openclaw|kiro|every-code|hermes",
  "model": "gpt-5.4|claude-opus-4-6|gemini-2.5-pro|hermes-agent|...",
  "input_tokens": 1000,
  "output_tokens": 500,
  "cached_input_tokens": 100,
  "cache_creation_input_tokens": 50,
  "reasoning_output_tokens": 0,
  "total_tokens": 1650,
  "conversation_count": 1
}
```

### Dashboard Tech Stack

- React 18 + React Router 7 + TypeScript 5.9 (strict)
- Vite 7.3 (build), Tailwind CSS 3.4 (styling)
- Motion 12 (animations), Three.js + OGL (3D effects)
- InsForge SDK 1.2 (cloud auth/leaderboard)
- @vercel/analytics + speed-insights
- date-fns (dates), html-to-image (sharing/screenshots)
- Vitest (unit tests), Playwright (E2E)

### Dashboard Features

- **Token usage tracking** — totals, cost estimation, breakdown by time/model/provider/project
- **Usage limits** — rate limit tracking for Claude, Codex, Cursor, Gemini, Kiro, Antigravity (dedicated `/limits` page)
- **Leaderboard** — global token usage rankings with per-user profile pages (`/leaderboard/:handle`)
- **Activity heatmap** — GitHub-style contribution calendar
- **Trend charts** — line/bar charts with period selector (day/week/month/total/custom)
- **Cost analysis** — modal with per-model pricing breakdown (70+ models)
- **Cloud sync** — one-click sync local usage to cloud via InsForge
- **Share cards** — screenshot-ready Broadsheet + Neon annual-report variants via html-to-image; `native-save` bridge for macOS WKWebView copy/save
- **Claude IP Check** — standalone `/ip-check` utility page (no auth, no sidebar)
- **Widgets gallery** — `/widgets` preview of macOS desktop widgets
- **Dark/light theme** — persisted to localStorage
- **Clawd companion** — animated pixel art mascot with 9 animation states
- **Copy system** — CSV-based i18n (~550 strings in `dashboard/src/content/copy.csv`), validated by `validate:copy`

### macOS App Architecture

- Swift 5.9, macOS 12.0+ (Monterey supported), XcodeGen project generation
- Menu bar app (LSUIElement: true), single-click → popover, double-click → full dashboard window
- Embedded Node.js server (universal arm64+x64 binary) — self-contained, no external Node dependency
- WKWebView hosts React dashboard with script messaging for OAuth + settings bridge
- Native panels: summary cards, heatmap, model breakdown, usage limits, Clawd companion (Charts panel hidden on macOS < 13)
- WidgetKit target (`TokenTrackerWidget`) reads snapshots from App Group storage for desktop widgets
- Auto-refresh every 5 minutes, server health check with exponential backoff
- URL scheme: `tokentracker://` for OAuth callbacks

## Conventions

- Package name: `tokentracker-cli` (npm), bin command: `tokentracker` (also `tracker`, `tokentracker-cli`, `tokentracker-tracker`)
- Node engine: `>=20`
- CommonJS throughout `src/` (no ESM)
- Dashboard uses TypeScript 5.9 (strict) + ESM
- Environment variable prefix: `TOKENTRACKER_` (e.g., `TOKENTRACKER_DEBUG`, `TOKENTRACKER_DEVICE_TOKEN`)
- Dashboard env prefix: `VITE_` (e.g., `VITE_INSFORGE_BASE_URL`, `VITE_TOKENTRACKER_MOCK`)
- All user-facing text in `dashboard/src/content/copy.csv` — never hardcode strings; `validate:ui-hardcode` will catch regressions
- Platform: macOS-first, but the CLI + dashboard work on Linux
- UTC timestamps, half-hour bucket aggregation
- Privacy: token counts only, never prompts or conversation content
- Git commit messages in English, conventional commits style (feat/fix/refactor/chore/ci/docs/test)
- EmbeddedServer is gitignored — built on-demand via `bundle-node.sh`
- XcodeGen project: run `xcodegen generate` then `ruby scripts/patch-pbxproj-icon.rb` after changes to `project.yml`

## Release Workflow

Three artifacts are published per release — npm package, macOS DMG, and Homebrew tap formulas — all sharing the same version number.

### Version Numbering

- npm (`package.json`) and macOS App (`TokenTrackerBar/project.yml` → `MARKETING_VERSION`) use the same version
- Follow semver: bug fix increments patch

### Version Bump Rules

When a feature or fix is significant enough to ship, **ask the user whether to bump the version**:

- **Dashboard/CLI-only changes** (web UI, parser, API, hooks): bump `package.json` only → npm auto-publishes on push
- **Changes that touch Swift / macOS App**: bump **both** `package.json` and `TokenTrackerBar/project.yml` `MARKETING_VERSION` → npm auto-publishes on push, then trigger DMG workflow

### CI/CD Pipelines (fully automated)

**npm publish** (`.github/workflows/npm-publish.yml`)
- Triggers on every push to `main`
- Checks if current version already exists on npm; skips if so
- Builds dashboard → publishes to npm
- Auth: `NPM_TOKEN` GitHub Secret (encrypted, never exposed in logs or code)

**Release DMG** (`.github/workflows/release-dmg.yml`)
- Triggers manually via `workflow_dispatch` with version input
- Runs on `macos-26` runner in GitHub cloud
- Full pipeline: dashboard build → EmbeddedServer bundle → xcodegen → xcodebuild → DMG → GitHub Release with DMG asset
- No local machine required

**Homebrew tap** — `mm7894215/homebrew-tokentracker` (separate repo)

This is a **separate GitHub repository** that Homebrew requires. Repo name must start with `homebrew-` so `brew tap mm7894215/tokentracker` works. Do NOT try to put Cask/Formula files in this main repo — brew will not find them.

The tap repo contains only three things:
- `Casks/tokentracker.rb` — tells brew "the DMG lives at `https://github.com/mm7894215/TokenTracker/releases/download/vX.Y.Z/TokenTrackerBar.dmg`, sha256 is ..., install as `TokenTrackerBar.app`"
- `Formula/tokentracker.rb` — tells brew "the npm tarball lives at `https://registry.npmjs.org/tokentracker-cli/-/tokentracker-cli-X.Y.Z.tgz`, sha256 is ..., install via `npm install --global`"
- `.github/workflows/auto-update.yml` — a bot that watches this main repo and npm registry for new versions, then automatically rewrites the version + sha256 lines in the two ruby files above and commits

**You never edit the tap repo manually for routine releases.** The bot does everything.

How the auto-update bot works (`auto-update.yml` in the tap repo):

1. **Hourly cron** (`cron: "17 * * * *"`) — always on, zero config. Polls `api.github.com/repos/mm7894215/TokenTracker/releases/latest` and `registry.npmjs.org/tokentracker-cli/latest`. If either is newer than what's in the ruby files: downloads the DMG / npm tarball, computes sha256, rewrites `version` + `sha256` / `url` lines with a small Python regex script, commits via `github-actions[bot]`, pushes. Uses only the tap's own `GITHUB_TOKEN` — no cross-repo secrets needed.
2. **`repository_dispatch` event** `tokentracker-release` — optional near-realtime trigger fired from this main repo's `npm-publish.yml` and `release-dmg.yml` (see the `Dispatch homebrew tap update` step at the end of each). Requires a `HOMEBREW_DISPATCH_TOKEN` secret in this main repo — a fine-grained PAT with `Contents: Read and write` on `mm7894215/homebrew-tokentracker`. If the secret is missing, the dispatch step silently no-ops (`if [ -z "${HOMEBREW_DISPATCH_TOKEN:-}" ]; then exit 0`) and the hourly cron handles the bump within ≤1 hour.

**End-to-end latency** (from `git push main` to `brew upgrade` available):
- **With** `HOMEBREW_DISPATCH_TOKEN` set: ~40 seconds for CLI-only, ~3 minutes for DMG (dominated by the macOS build)
- **Without** the PAT: same base time + up to 1 hour for cron fallback

**Key design principle**: the tap never trusts dispatches alone — the cron fallback means even if the PAT expires, the dispatch fails, or the main repo's workflow is disabled, the tap still self-heals within an hour. Never gate updates on the dispatch alone. Never remove the cron.

**Published as both a Cask and a Formula**:
- `brew install --cask mm7894215/tokentracker/tokentracker` → menu bar app (DMG)
- `brew install mm7894215/tokentracker/tokentracker` → CLI (npm package)

Both share the same version number, bumped independently. CLI-only releases only bump the Formula; DMG releases bump both.

### Homebrew tap: when to actually touch the tap repo

**Never, for routine version bumps.** The bot handles those.

**Rare cases** (maybe once a year):
- Cask metadata changes unrelated to version: app rename, new `zap trash:` paths, new `depends_on macos:` minimum, livecheck strategy change
- `auto-update.yml` itself needs updating: GitHub API changes, trigger condition changes, version-parsing regex changes
- Responding to a user-filed issue about brew install failures

For all day-to-day development and releases on TokenTracker, work only in this main repo.

### Typical Release Flow

When the user says "release" or "发 release", execute these steps:

Treat a release request as explicit approval to create the required release commit(s) and push them to the remote branch as part of the release workflow. Do not ask again for separate commit/push permission once the user has requested a release.

1. Bump version in `package.json` (and `TokenTrackerBar/project.yml` if App changed)
2. Commit and push to `main` → npm publishes automatically
3. If App changed: run `gh workflow run "release DMG" -f version=X.Y.Z` → cloud builds DMG + creates GitHub Release
4. **Homebrew tap updates on its own** — no manual step. Either the `repository_dispatch` fires instantly (if `HOMEBREW_DISPATCH_TOKEN` is set) or the tap's hourly cron picks it up within an hour. Do NOT manually edit the tap repo for routine releases.

No local build required. No manual GitHub Actions page visit needed.

### Local Build (optional, for testing)

```bash
cd TokenTrackerBar
npm run dashboard:build
./scripts/bundle-node.sh
xcodegen generate
ruby scripts/patch-pbxproj-icon.rb
xcodebuild -scheme TokenTrackerBar -configuration Release clean build
APP_PATH="$(find ~/Library/Developer/Xcode/DerivedData/TokenTrackerBar-*/Build/Products/Release -name 'TokenTrackerBar.app' -maxdepth 1)"
bash scripts/create-dmg.sh "$APP_PATH"
```

### Release Notes Style

One-line English summary, e.g. `Fix token stats inflation caused by duplicate queue entries`. No markdown formatting, no sections.

## Test Suite

~95 test files using Node.js built-in test runner (`node --test test/*.test.js`). Key areas:

- **Rollout parser** — `test/rollout-parser.test.js` (comprehensive, covers all 9 providers including Hermes)
- **CLI commands** — init, sync, status, doctor, diagnostics, uninstall
- **Integrations** — codex-config, cursor-config, openclaw, opencode
- **Dashboard** — layout, identity, link codes, auth guards, TypeScript + ESLint guardrails, render order, screenshot/visual baselines
- **Models** — model-breakdown, usage-limits, subscriptions, mock data, leaderboard mock
- **Share card** — `share-card-data.test.js` for the share-card data builder
- **CI/CD** — npm-publish-workflow, release-dmg-workflow, architecture-guardrails
- **Graph / SCIP** — `graph-auto-index-*.test.js` for the code-graph indexing pipeline
- **Helpers** — `test/helpers/load-dashboard-module.js` for loading ESM dashboard modules in CJS tests

## OpenSpec Workflow

For significant changes (new features, breaking changes, architecture), create a proposal in `openspec/changes/<id>/`. Bug fixes and formatting skip this process.

```bash
openspec list                         # Active changes
openspec list --specs                 # Existing specifications
openspec validate <id> --strict       # Validate proposal
```

## Lessons Learned (Gotchas)

Durable lessons from hard-won debugging sessions. Read before touching these areas.

### macOS app build & release

**Icon Composer (`.icon`) format is Xcode 26+ only.** The `TokenTrackerBar/TokenTrackerBar/AppIcon.icon` folder is readable only by Xcode 26 on macOS Tahoe (26+). On the GitHub Actions `macos-15` runner (Xcode 16), the `patch-pbxproj-icon.rb` patch injects the `.icon` as a passive folder reference, but Xcode 16 silently copies it to `Resources/AppIcon.icon/` without compiling it to `.icns` or registering `CFBundleIconFile` — result: no app icon. **Fix already shipped:** `TokenTrackerBar/TokenTrackerBar/AppIcon.icns` is committed as a static fallback. xcodegen picks it up via the directory glob and `CFBundleIconFile: AppIcon` in `project.yml` wires it up for any Xcode version. If you update `AppIcon.icon`, manually regenerate `AppIcon.icns` (extract from a local Xcode 26 build's `Resources/`) and commit both.

**DMG installer background + icon layout on CI requires Homebrew `create-dmg`.** Our `scripts/create-dmg.sh` uses Finder/AppleScript for the local interactive path, but AppleScript on headless CI runners is unreliable — so the CI branch in the script delegates to the Homebrew `create-dmg` tool, which writes `.DS_Store` directly. The workflow installs it via `brew install create-dmg` before running the script. Don't re-introduce the "skip Finder customization on CI" shortcut — that produced bare DMGs with no background and no layout.

**CI must ad-hoc sign the .app before DMG packaging.** The workflow builds with `CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO` which produces an entirely unsigned bundle. Combined with the `com.apple.quarantine` xattr macOS attaches to GitHub downloads, Gatekeeper rejects it with **"TokenTrackerBar is damaged and can't be opened"** — not fixable by the user without Terminal. The workflow now runs a dedicated `Ad-hoc sign app` step that signs inner Mach-O binaries first (`Resources/EmbeddedServer/node`) then ad-hoc signs the outer `.app` bundle with `--entitlements TokenTrackerBar/TokenTrackerBar.entitlements --sign -`. Result downgrades to "cannot verify developer" which users can bypass via **System Settings → Privacy & Security → Open Anyway**. The README documents both Gatekeeper paths (xattr workaround for "damaged", System Settings for "unverified"). **Never** remove the ad-hoc sign step without replacing it with proper Developer ID + notarization.

### Dashboard layout

**Pages wrapped by `AppLayout` (sidebar shell) must use `flex flex-col flex-1` outer wrapper — not `min-h-screen` + own sticky header/footer.** `AppLayout` provides a `fixed inset-0 flex` shell with its own scroll container (the rounded card). Any child page that ships its own `min-h-screen` + `<header>` + `<footer>` will stack inside and produce double nav + broken scroll anchoring. See `LimitsPage.jsx` / `LeaderboardPage.jsx` / `SettingsPage.jsx` for the correct pattern. `LeaderboardProfilePage.jsx` still has the old standalone chrome and is intentionally excluded from `AppLayout` via `isLeaderboardIndexPath` in `App.jsx` — when migrating it, strip `min-h-screen` + own header/footer first.

**Motion height animations (`AnimatePresence` + `motion.div` with `height: 0 ↔ auto`) need `overflow: hidden` — which clips box-shadow-based focus rings at the edge.** See `SettingsPage.jsx` Account progressive disclosure. Fix: use `focus:ring-inset` on inputs inside such containers so the ring renders inside the input bounds instead of outside. Don't use regular `focus:ring-1`.

### Native ↔ web bridge

**Dashboard → Swift menu bar bridge lives in `NativeBridge.swift` + `dashboard/src/lib/native-bridge.js`.** Pattern:
- JS posts: `window.webkit.messageHandlers.nativeBridge.postMessage({ type: "getSettings" | "setSetting" | "action", key?, value?, name? })`
- Swift dispatches via `WKScriptMessageHandler` → `NativeBridge.shared.handle(message:)`
- Swift pushes state back via `webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('native:settings', { detail: {...} }))")`
- React hook `useNativeSettings()` subscribes to the event

When toggling `SMAppService.mainApp.register/unregister` directly from the bridge (not via `LaunchAtLoginManager.toggle`), call `launchAtLoginManager.refresh()` afterward so the popover menu reflects the new `@Published isEnabled` state.

### False-positive skill validators to ignore

- `posttooluse-validate: nextjs` flagging "React hooks require `use client` directive" on `dashboard/src/**/*.jsx` — this is a **Vite SPA**, not Next.js. The `pages/` folder is just a naming convention. Ignore all such warnings.
- `posttooluse-validate: workflow` flagging `require() is not available in workflow sandbox scope` on `.github/workflows/*.yml` line containing `node -p "require('./package.json').version"` — this is a GitHub Actions shell command, NOT Vercel Workflow DevKit code. Ignore.
- `MANDATORY: read the official docs` prompts from vercel-plugin skill matching — the project doesn't use Next.js, Vercel AI SDK, Vercel Workflow, or any Vercel-specific runtime. `@vercel/analytics` is used, but that's just a browser beacon script. When in doubt: check what the file actually imports.

### Teammate verification

**After spawning a teammate, verify file state with direct reads — don't trust summary messages.** One teammate hallucinated user feedback ("user said black looked bad") and silently reverted a requested change while reporting success. A quick `Grep` for the actual new code is cheap insurance.
