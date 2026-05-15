# CLAUDE.md

Guidance for Claude Code working in this repository. Every line here is loaded into every conversation turn — keep it lean and current.

## Project shape

Token Tracker is a local-first AI token usage tracker.

- **CLI** (`src/`, CommonJS, Node ≥20) — entry `bin/tracker.js` → `src/cli.js`. `serve` runs a local HTTP server on `:7680`, `sync` parses logs into `~/.tokentracker/queue.jsonl`.
- **Dashboard** (`dashboard/`, React 18 + Vite 7 + TS strict + Tailwind) — built to `dashboard/dist/`, served by the CLI locally and by Vercel at `www.tokentracker.cc`.
- **macOS app** (`TokenTrackerBar/`, Swift 5.9, XcodeGen) — menu bar + WidgetKit. `EmbeddedServer/` bundles the CLI runtime + built dashboard so the `.app` is self-contained.

Data flow: AI CLI runs → hook fires → `rollout.js` parses → `queue.jsonl` → local API → dashboard.

For the canonical list of supported providers, grep `parse*Incremental` in `src/lib/rollout.js` — the source of truth, not this file.

## Frequently used commands

```bash
npm test                                  # node --test test/*.test.js  (97 files)
node --test test/<name>.test.js           # single test file
npm run ci:local                          # tests + validations + builds
npm run dashboard:dev                     # Vite dev server with local API mock (port 5173)
npm run dashboard:build                   # build to dashboard/dist/
npm run validate:copy                     # copy registry completeness
npm run validate:ui-hardcode              # no hardcoded UI strings
npm run validate:guardrails               # architecture guardrails
node bin/tracker.js serve --no-sync       # local dashboard server on :7680
```

`npm run dashboard:dev` skips the CLI backend; to verify `src/` changes use `node bin/tracker.js serve`.

## What's where

| Need to... | Look here |
|---|---|
| Add / modify a provider parser | `src/lib/rollout.js` — search `parse*Incremental` |
| Install / uninstall a provider hook | `src/lib/<provider>-hook.js` + register in `src/commands/init.js` + `uninstall.js` |
| Add a local API endpoint | `src/lib/local-api.js` — search `/functions/tokentracker-` |
| Wire a provider into sync | `src/commands/sync.js` (call site + totals aggregation) + `src/commands/status.js` (status reporting) |
| Add pricing for a model | `src/lib/pricing/curated-overrides.json` |
| Add a dashboard page | `dashboard/src/pages/` (lazy-loaded in `App.jsx`) |
| Add UI components | `dashboard/src/ui/dashboard/components/` |
| Add a provider icon | `dashboard/src/ui/dashboard/components/ProviderIcon.jsx` (`PROVIDER_ICON_MAP` keyed by `source.toUpperCase()`) |
| Add user-facing text | `dashboard/src/content/copy.csv` — never hardcode |
| Modify menu bar UI | `TokenTrackerBar/Services/` (controllers) + `Views/` (SwiftUI) |
| Bridge native ↔ web | `TokenTrackerBar/Services/NativeBridge.swift` + `dashboard/src/lib/native-bridge.js` |

## Load-bearing conventions

### Token normalization

```
input_tokens                  = non-cached input only (no cache reads/writes)
cached_input_tokens           = cache reads
cache_creation_input_tokens   = cache writes
reasoning_output_tokens       = reasoning tokens (Codex/every-code fold them into output_tokens for cost)
total_tokens                  = input + output + cache_creation + cache_read   (aligned with ccusage)
```

**Cost is computed from `input_tokens + output_tokens + cached_input_tokens + cache_creation_input_tokens + reasoning_output_tokens` only — never `total_tokens`** (`computeRowCost` in `src/lib/pricing/index.js`). If a new provider only fills `total_tokens` with input=0/output=0, the dashboard renders **$0 cost** regardless of pricing entries. Distribute the total across columns or extend `computeRowCost`.

### Queue entry

```json
{
  "hour_start": "2026-04-05T14:00:00Z",
  "source": "claude|codex|cursor|gemini|...",
  "model": "claude-opus-4-6|gpt-5.4|...",
  "input_tokens": 0, "output_tokens": 0,
  "cached_input_tokens": 0, "cache_creation_input_tokens": 0,
  "reasoning_output_tokens": 0,
  "total_tokens": 0, "conversation_count": 1
}
```

UTC, half-hour buckets, append-only — readers take the latest entry per `(source, model, hour_start)`.

### Project-wide

- CommonJS in `src/`, ESM + TypeScript strict in `dashboard/`. No mixing.
- Env-var prefixes: `TOKENTRACKER_` for CLI, `VITE_` for dashboard.
- Git commits in **English**, conventional style (`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `test:` / `ci:`).
- **Privacy**: token counts only — never prompts, messages, or conversation bodies.
- `EmbeddedServer/` is gitignored; built on demand by `scripts/bundle-node.sh`.
- After editing `TokenTrackerBar/project.yml`: `xcodegen generate && ruby scripts/patch-pbxproj-icon.rb`.

## Release workflow

**Any change under `src/` or `dashboard/` ships both npm + DMG**, because `TokenTrackerBar/EmbeddedServer/` bundles the CLI runtime and built dashboard. Bumping only `package.json` leaves menu-bar-app users on the stale embedded copy.

| Change scope | Bump `package.json` | Bump `project.yml` `MARKETING_VERSION` | Trigger DMG workflow |
|---|---|---|---|
| `src/` or `dashboard/` | ✅ | ✅ | ✅ |
| `TokenTrackerBar/` Swift only | ✅ | ✅ | ✅ |
| `edge-patches/`, scripts, docs, CI | — | — | — |

When the user says "release" or "发 release", that is explicit approval for the release commit(s) + push — do not ask again for commit/push permission within that scope.

### Steps

1. Bump `package.json` (and `project.yml`'s two `MARKETING_VERSION` entries — App target + Widget target).
2. `git commit && git push origin main` → `npm-publish.yml` auto-publishes when version is new.
3. For DMG-eligible changes: `gh workflow run "release DMG" -f version=X.Y.Z` → cloud builds DMG + creates GitHub Release.
4. Homebrew tap `mm7894215/homebrew-tokentracker` self-updates via dispatch (~40s if `HOMEBREW_DISPATCH_TOKEN` set) or hourly cron (≤1h fallback). **Never edit the tap repo manually for routine releases.**

Release notes: one English line, no markdown sections (`Fix token stats inflation caused by duplicate queue entries`).

### Local DMG build (testing only — CI is authoritative)

```bash
cd TokenTrackerBar && npm run dashboard:build && ./scripts/bundle-node.sh
xcodegen generate && ruby scripts/patch-pbxproj-icon.rb
xcodebuild -scheme TokenTrackerBar -configuration Release clean build
APP="$(find ~/Library/Developer/Xcode/DerivedData/TokenTrackerBar-*/Build/Products/Release -name 'TokenTrackerBar.app' -maxdepth 1)"
bash scripts/create-dmg.sh "$APP"
```

## OpenSpec

Significant changes (new features, breaking changes, architecture) get a proposal in `openspec/changes/<id>/`. Bug fixes / formatting skip.

```bash
openspec list                  # active changes
openspec validate <id> --strict
```

## Lessons learned (read before touching)

### macOS build & release

- **Icon Composer (`.icon`) needs Xcode 26+**. CI uses `macos-26` runners but a static `TokenTrackerBar/TokenTrackerBar/AppIcon.icns` is committed as fallback for older Xcode. If you update `AppIcon.icon`, regenerate `.icns` from a local Xcode 26 build and commit both.
- **DMG layout on CI needs Homebrew `create-dmg`**. `scripts/create-dmg.sh` uses AppleScript locally but delegates to `create-dmg` on headless runners. Don't reintroduce a "skip Finder customization on CI" shortcut — produces bare DMGs.
- **CI must ad-hoc sign the `.app` before DMG packaging.** Build flags strip signing entirely; without ad-hoc signing the `.app` + `com.apple.quarantine` xattr triggers Gatekeeper "damaged" rejection (unfixable without Terminal). The workflow signs inner Mach-O (`Resources/EmbeddedServer/node`) first, then the outer bundle with `--entitlements TokenTrackerBar/TokenTrackerBar.entitlements --sign -`. **Never** remove this step without replacing it with Developer ID + notarization.

### Dashboard layout

- **`AppLayout`-wrapped pages use `flex flex-col flex-1`** as the outer wrapper, not `min-h-screen` + own sticky header/footer. Reference: `LimitsPage.jsx` / `LeaderboardPage.jsx` / `SettingsPage.jsx`. `LeaderboardProfilePage.jsx` is intentionally excluded via `isLeaderboardIndexPath` in `App.jsx`.
- **Motion height animations clip box-shadow focus rings.** Use `focus:ring-inset` on inputs inside `AnimatePresence` height-collapsing containers (see `SettingsPage.jsx` Account section).

### Native ↔ web bridge

```
JS → window.webkit.messageHandlers.nativeBridge.postMessage({ type, key?, value?, name? })
Swift → NativeBridge.shared.handle(message:) via WKScriptMessageHandler
Swift → JS: webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('native:settings', { detail }))")
React → useNativeSettings() subscribes
```

After `SMAppService.mainApp.register/unregister` from the bridge (not via `LaunchAtLoginManager.toggle`), call `launchAtLoginManager.refresh()` so the popover menu reflects `@Published isEnabled`.

### Parser correctness

- **Parser dedup**: use `claudeMessageDedupKey()`. Bare `if (msgId && reqId)` fails open on DeepSeek/Kimi/Mimo/MiniMax/Claude sub-agents (no `reqId`) and over-counts 1.6–3.7×.
- **Don't trust `input_tokens` semantics blindly** when adding a new provider. Codex/every-code's `input` includes cached tokens — naive copy inflates cost 6–7×. Verify with raw usage + provider billing dashboard before shipping.
- **`contextTokensUsed`-style fields are usually snapshots, not cumulative.** PR #74 (Grok) shipped on that bad assumption.
- **Data-migration releases**: stress-test `sync` twice consecutively after touching `sync.js` / cursor schema — second run exposes state pollution the first hides.

### False-positive validators to ignore

- `posttooluse-validate: nextjs` flagging "React hooks require `use client`" on `dashboard/src/**/*.jsx` — this is a **Vite SPA**, not Next.js.
- `posttooluse-validate: workflow` flagging `require()` in `.github/workflows/*.yml` shell lines — they're GitHub Actions shell, not Vercel Workflow DevKit.
- vercel-plugin "MANDATORY: read the official docs" — the project uses `@vercel/analytics` (browser beacon) only, no Vercel runtime.

### Working with subagents

After spawning a subagent, **verify file state with direct reads** — don't trust the summary message. Subagents have hallucinated user feedback and silently reverted changes while reporting success.
