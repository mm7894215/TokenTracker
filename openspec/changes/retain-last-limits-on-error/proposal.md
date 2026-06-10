# Proposal: Retain last successful limits record + surface visible prompt on fetch failure (native)

**ID**: `retain-last-limits-on-error`  
**Type**: New feature (UX improvement)  
**Scope**: macOS native app (TokenTrackerBar)  
**Status**: Implemented (post-review)  
**Author**: Follow-up to plan + review discussion  
**Date**: 2026-06

## Why (Problem Statement)

In the macOS menu bar app, the "Limits" / "限额" section (progress bars + reset timers for Claude, Codex, Grok Build, etc.) lives in the popover (`DashboardView` → `UsageLimitsView`).

Previously:
- The fetch to `/functions/tokentracker-usage-limits` is marked "best-effort, non-fatal" inside `loadAll()`.
- On hard failure (throw): the old `usageLimits` value was sometimes kept, but the view logic (`hasAnyAvailable` + `if limits == nil { skeleton } else if !hasAny { nothing }`) frequently caused the entire section (and its bars) to disappear.
- On successful HTTP response that contained per-provider `error` strings (or no usable windows): the response was unconditionally assigned, overwriting any previous good record → again the section vanished.
- Result (user observation): "如果这个限额调用出现问题...进度条是直接都不显示了" — the quota progress bars simply stop appearing, even though the last known good values from a prior sync were still valuable.

The backend already has explicit "last successful" disk caches + serve-stale logic for **Claude** and **Antigravity** precisely "so the panel can keep showing it instead of flashing a red error" (see `src/lib/usage-limits.js` comments around the 7-day caches and rate-limit cooldown handling). Other providers just emit `{ configured: true, error: "..." }`.

The web dashboard (`useUsageLimits` hook + `LimitsPage` + `UsageLimitsPanel`) already followed the desired behavior: on fetch error it sets `error` but **never clears `data`**, and renders both the error banner and the (stale) panel content. Native was the outlier.

This change brings the native popover in line with:
- The "best effort" design intent.
- The backend's investment in staleness preservation for key providers.
- The web implementation.
- User expectation for quota/ limit information ("show me what I had last time + tell me it's possibly stale").

## What (Desired Behavior After Change)

- When the limits fetch **throws** (network, server down, timeout, 500, etc.):
  - `limitsError` is set with the message.
  - The previous successful `usageLimits` record (if any) is **retained**.
  - The popover still renders the Limits section with the old progress bars.
  - A visible, contextual prompt is shown inside the section: "Refresh failed: <msg>. Showing last synced limits." (localized via `Strings.limitsRefreshFailed`).
- When a response succeeds but has **no usable providers** (`!hasAnyProviderWithoutError`):
  - We protect the previous good record (do not overwrite).
- When a response succeeds **with at least one usable provider**:
  - We take the fresh data (partial updates are fine; errored providers are still hidden per the existing "hide errors" design in `buildVisibleGroups`).
- `limitsError` is cleared on the next successful limits fetch.
- Indirect consumers (menu-bar stats composite, `WidgetSnapshotWriter`) automatically keep showing the last good values because they read the (protected) `usageLimits` from the VM.
- The prompt is only shown in the main popover Limits section (space-constrained surfaces like the menu-bar numbers and widgets just retain the data silently — acceptable per the scoped request).

No change to the `/tokentracker-usage-limits` HTTP contract or response shape. The web dashboard behavior is untouched (it was already correct).

## How (Design & Key Changes)

Core state change in the ViewModel (best-effort task only):

```swift
// success path
let newLimits = try await ...
self.limitsError = nil
if self.usageLimits == nil || newLimits.hasAnyProviderWithoutError {
    self.usageLimits = newLimits
}
// else: deliberately keep the prior good record

// catch path
self.limitsError = error.localizedDescription
// do NOT touch usageLimits
```

New helper on the model (single source of truth, dedupes the check that used to live only in the View):

```swift
extension UsageLimitsResponse {
    var hasAnyProviderWithoutError: Bool { ... }  // configured && error == nil for any provider
}
```

View signature + rendering:

```swift
UsageLimitsView(limits: ..., fetchError: viewModel.limitsError)

if let limits, hasAnyAvailable(limits) {
    ... render header + bars (existing logic) ...
    if let fetchError {
        Text(Strings.limitsRefreshFailed(fetchError))   // new prompt
            .font(.caption2)
            .foregroundStyle(.orange)
    }
} else if limits == nil {
    if let fetchError { compact error note with header } else { skeleton }
}
```

Files touched (exactly as in the approved implementation plan):
- `TokenTrackerBar/TokenTrackerBar/Models/UsageLimits.swift` (new computed)
- `TokenTrackerBar/TokenTrackerBar/ViewModels/DashboardViewModel.swift` (new `@Published limitsError`, guarded assignment)
- `TokenTrackerBar/TokenTrackerBar/Views/UsageLimitsView.swift` (accept param, render prompt, use model helper)
- `TokenTrackerBar/TokenTrackerBar/Views/DashboardView.swift` (wire the error down)
- `TokenTrackerBar/TokenTrackerBar/Utilities/Strings.swift` (new `limitsRefreshFailed(_:)` using the existing `t(...)` multi-lang helper)

The prompt string is localized (en + zh primary + other languages) following the exact pattern already used for `usageLimitsTitle`, `allProvidersHidden`, `kimiParallelLabel`, etc.

## Impact & Risks

**Positive**:
- Users no longer lose visibility into their last-known quota state during transient provider API issues, rate-limit cooldowns, server restarts, etc.
- Better parity between native popover and the web dashboard experience.
- Leverages (rather than duplicates) the backend's existing Claude/Antigravity staleness caches.
- Menu bar stats and desktop widgets get the retention "for free."

**Risks / Mitigations**:
- Stale data could be misleading if a quota actually reset or changed significantly. → We show an explicit warning inside the section. The `fetchedAt` from the retained record is still visible in the data model (though not currently rendered in the prompt).
- Only affects the popover view; the full Dashboard window (WebView) was already good.
- No behavior change when everything is healthy.

**Backward compatibility**: Purely additive (new published property + optional view param with default). Existing call sites and observations continue to work.

## Verification

See the detailed manual steps in the implementation review:

1. Normal operation → bars render.
2. Simulate hard failure (kill server or force throw in `fetchUsageLimits`) → bars from the *previous* record remain, plus the orange prompt appears inside the Limits section.
3. Menu-bar numbers (if limits metrics are selected) and pinned widgets also keep the previous values.
4. Recovery → fresh data + prompt disappears.
5. First-load failure case, partial provider failure, user visibility settings, etc. all covered in the test plan.
6. `npm test` (JS side) unaffected.
7. Native build + popover smoke test (Xcode).

`openspec validate retain-last-limits-on-error --strict` should pass once the CLI is available.

## Related Work / References

- Backend caches: `src/lib/usage-limits.js` (Claude 7-day cache + rate-limit cooldown file, Antigravity cache, the "so the panel can keep showing it" comments).
- Web precedent: `dashboard/src/hooks/use-usage-limits.ts` (explicitly preserves `data` on catch), `UsageLimitsPanel.jsx` (renders per-provider errors or "not connected").
- Original user report + analysis + approved implementation plan (see session artifacts and prior chat).

## Tasks / Follow-ups (if any)

- [x] Implement core retention + prompt (done)
- [x] Add localized string via existing `Strings.t(...)` pattern (done)
- [ ] (Optional) Centralize warning color into `Colors.swift` extension instead of raw `.orange`
- [ ] Run full `ci:local` + native build + manual popover test
- [ ] When preparing PR / before merge to main: ensure this proposal is listed via `openspec list`

This proposal documents the motivation, design decisions, and scope so future contributors (and the architecture guardrails) understand why the native limits display now tolerates failure by showing stale-but-useful data + a prompt instead of vanishing.
