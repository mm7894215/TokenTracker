# Add OpenCode Go usage limits to the dashboard

## Background & findings

- The opencode web console exposes the Go usage page as a SolidStart `"use server"` RPC at `https://opencode.ai/workspace/<id>/go`. There is no public REST API today (ref `anomalyco/opencode#16017`, `slkiser/opencode-quota#36`).
- The page's `queryLiteSubscription` returns three windows: **5h** (`rollingUsage`), **Weekly** (`weeklyUsage`), **Monthly** (`monthlyUsage`) — each `{ usagePercent, resetInSec }`. The page also embeds them in SSR hydration output as `rollingUsage:$R[N]={...usagePercent:N...resetInSec:N...}` plus a `data-slot="usage-item"` HTML fallback.
- Limits (per `packages/console/core/src/subscription.ts` + `ZEN_LIMITS` resource): rolling `$12 / 5h`, weekly `$30`, monthly `$60`. (Pricing surface can be added later; this PR is percentage-only like the rest of the panel.)
- The repo's existing `opencode` source row tracks *your local* OpenCode sessions; we add a **separate** `opencodeGo` row so they don't collide.
- A precedent with the same approach is **merged in `slkiser/opencode-quota#41`** (TypeScript). The implementation there: `GET https://opencode.ai/workspace/<workspaceId>/go` with `Cookie: auth=<cookie>` → regex-parse three windows out of the HTML. Two env vars: `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`. ~430 tests pass, no breakage on missing config (`{state: "none"}` → not-attempted result).
- This is the proven, safe approach. Mirroring the SolidStart `"use server"` RPC is possible but fragile (SolidStart uses opaque internal `_server` URLs and a per-hash function name; the dashboard approach has a stable public URL and is what the opencode team themselves eventually want — the issue is tracked).

## Decision (user-confirmed)

- New provider: `opencodeGo`, displayed as **"OpenCode Go"**, reusing the existing `opencode` icon (`OPENCODE` key) in `ProviderIcon.jsx`.
- Config: `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE` env vars, same naming as `slkiser/opencode-quota#41` and the existing `OPENCODE_*` / `KIMI_*` / `ZAI_*` convention already in `.env.example` (no `TOKENTRACKER_` prefix — that prefix is only for our own CLI runtime, not provider auth). No macOS Keychain reading — env-only matches the rest of the dashboard's `VITE_*` pattern. The Fe26.* cookie becomes `OPENCODE_GO_AUTH_COOKIE` and is sent verbatim as `Cookie: auth=<value>`.

## Files to add / modify

### Backend (CLI)

1. **`src/lib/opencode-go-limits.js` (new)** — `fetchOpencodeGoLimits({ home, env, fetchImpl, providerTimeoutMs })`:
   - Reads `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE` from `env` (no `TOKENTRACKER_` prefix — mirrors the `KIMI_API_KEY` / `ZAI_API_KEY` pattern already in `.env.example` and the upstream `slkiser/opencode-quota` env names).
   - `GET https://opencode.ai/workspace/<encoded workspaceId>/go` with `Cookie: auth=<cookie>`, `User-Agent: Mozilla/5.0…` (matches PR #41, dodges some anti-bot 403s).
   - Parses SSR-hydration regexes (3 windows × 2 field orderings) + a `data-slot` HTML fallback, ported from `slkiser/opencode-quota/src/lib/opencode-go.ts:54-126` (MIT, project allows reuse with attribution note in code).
   - Returns one of:
     - `{ configured: false }` — env vars missing
     - `{ configured: true, error: "…" }` — fetch/parse error
     - `{ configured: true, primary_window, secondary_window, tertiary_window }` where each window is `{ used_percent, reset_at: <ISO from resetInSec> }` — mirrors the existing `zcode` / `kimi` / `antigravity` shape so the dashboard spec works without any spec changes. No `plan_label` is set; the brand "OpenCode Go" is the row title and any plan tier would just duplicate it.
2. **`src/lib/usage-limits.js`** — add `import { fetchOpencodeGoLimits }` and a `Promise.all` slot for it next to the existing 10 providers; merge with `withPlanLabel(opencodeGo, opencodeGo?.plan_label, "OpenCode Go")` in the returned `data` object. `normalizePlanLabel(null, ...)` returns `null` so the rendered title stays "OpenCode Go" (the brand), not "OpenCode Go OpenCode Go".
3. **`src/lib/local-api.js`** — no changes (the new provider is just another key on the JSON the existing `/functions/tokentracker-usage-limits` endpoint already returns).
4. **`test/opencode-go-limits.test.js` (new)** — node:test, fixtures:
   - missing env → `{ configured: false }`
   - happy path: stubbed `fetch` returning both SSR hydration + data-slot HTML → 3 windows parsed
   - 401/403 → `{ configured: true, error: "…" }` (treats logout the same way as the other providers)
   - 200 but no parseable windows → `{ configured: true, error: "Could not parse any known OpenCode Go dashboard usage windows…" }`

### Frontend (dashboard)

5. **`dashboard/src/lib/limits-providers.js`** — add `"opencodeGo"` to `LIMIT_PROVIDER_IDS` (newest entry, after `zcode`); map to `OPENCODE` in `LIMIT_PROVIDER_ICON_KEYS`; add a `case "opencodeGo"` in `limitProviderName()`.
6. **`dashboard/src/ui/dashboard/components/usage-limits-provider-specs.js`** — add `opencodeGo` spec with 3 windows (`primary_window` = 5h, `secondary_window` = weekly, `tertiary_window` = monthly), reusing the existing `used_percent` + `reset_at` fields. Append the three new `copy("limits.label.opencode_go_*")` calls to `usageLimitsLabelCopyAnchor()`.
7. **`dashboard/src/content/copy.csv`** — add copy rows for `limits.provider.opencode_go` ("OpenCode Go") and the three labels (5h, Weekly, Monthly); mirrors the `zcode` block. All 5 i18n locales regenerated via the existing sync script.
8. **`dashboard/src/hooks/use-usage-limits.ts`** — extend the `UsageLimitsData` type to include the new `opencodeGo` field.
9. **`dashboard/src/pages/LimitsPage.jsx`** — pass `opencodeGo={usageLimits?.opencodeGo}` to `<UsageLimitsPanel>`. The existing `UsageLimitsPanel.jsx` and `ProviderIcon.jsx` need no changes — they iterate the `dataById` map and fall back to the shared `OPENCODE` icon.
10. **`dashboard/src/hooks/use-usage-limits.test.tsx`** — add `opencodeGo: { configured: false }` to the mock fixture.
11. **`dashboard/src/ui/dashboard/components/UsageLimitsPanel.test.jsx`** — add a test rendering the panel with the 3 mocked windows (5h 12%, Weekly 30%, Monthly 60%) and asserting the labels render.

### Docs / env

12. **`.env.example`** — append:
    ```dotenv
    # OpenCode Go (https://opencode.ai/workspace/<id>/go) — optional, enables dashboard scrape
    OPENCODE_GO_WORKSPACE_ID=
    OPENCODE_GO_AUTH_COOKIE=
    ```
13. **`docs/`** — short note in the existing limits doc (if one exists) + a paragraph in `CLAUDE.md` under "What's where" pointing at `src/lib/opencode-go-limits.js`. No README change.

## Reused / shared patterns

- **Spec shape**: copies ZCode's window spec verbatim (only labels differ) — same 3 `primary/secondary/tertiary` window fields already used by `kimi`/`cursor`/`gemini`/`antigravity`.
- **Error/cache plumbing**: existing `withPlanLabel`, the 2-min in-memory cache, the single-flight guard, and the 15s focus-throttled refetch in `use-usage-limits.ts` all just work — no changes needed.
- **Validation**: no new copy strings, but the new copy.csv rows get picked up by `npm run validate:copy`. New `limits.label.opencode_go_*` are referenced through `copy(...)` only — no UI hardcode, no `validate:ui-hardcode` regressions.

## Risks / non-goals

- **Brittleness** (the one real concern): the opencode team can rename the SSR hydration key, drop the `data-slot` attrs, or move to a public API at any time. The PR #41 maintainers flagged the same. Mitigation: keep both parsers; if both fail, surface a clear "Could not parse OpenCode Go dashboard" error in the panel so the user knows to re-check.
- **Cookie rotation**: the Fe26.* cookie expires on logout. If it 401s, we surface that as the provider's `error` field — same UX as Kimi/ZCode/Copilot when their token goes stale. No automatic re-auth.
- **No public API yet** — when upstream ships one, this is a one-file swap in `opencode-go-limits.js`.

## Auth details (user-confirmed)

When implementing, send `Cookie: auth=<OPENCODE_GO_AUTH_COOKIE>` exactly as PR #41 does, with no prefix manipulation. User sets `OPENCODE_GO_AUTH_COOKIE=<pasted-value>` in `.env.local`.

## Release impact (per `CLAUDE.md`)

Touches `src/` + `dashboard/` → must bump `package.json` + `TokenTrackerBar/project.yml` `MARKETING_VERSION` (×2) + `TokenTrackerWin/TokenTrackerWin.csproj` `<Version>` in lockstep, then trigger `release (macOS + Windows)`.

## Reference (MIT-licensed reuse)

`slkiser/opencode-quota` PR #41 — same approach, merged Apr 12 2026, 430 tests passing. Port the parser verbatim and credit the source in a code comment.
