# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- `tokentracker serve` now suggests `npx tokentracker-cli serve --port ...` when the requested port is still occupied, matching the published npm package name and avoiding the `E404` path reported in issue #30.

### Added

- **Kimi provider** — passive token tracking via `~/.kimi/sessions/**/wire.jsonl`. No hook or configuration required; TokenTracker reads Kimi's wire log directly on every sync.
  - `parseKimiIncremental` in `rollout.js` follows the file-offset + `message_id` dedup pattern (same as Copilot OTEL) to avoid double-counting across incremental syncs.
  - `tokentracker status` reports the number of `wire.jsonl` files found when `~/.kimi/sessions` exists.
  - `tokentracker init` detects the Kimi sessions directory and surfaces it as a passive reader in the setup summary.
  - Dashboard model-breakdown shows Kimi with brand logo (`kimi.svg`) and violet color (`#a78bfa`).
  - Model reported as `kimi-k2` (wire.jsonl does not expose the model name).

## [0.5.17] - 2026-03-31

### Fixed

- Preserve the macOS dashboard relay cookie file across updates and restarts so embedded dashboard sessions no longer get wiped unexpectedly.
- Isolate relay cookie persistence coverage to a temporary HOME so `npm test` never mutates a developer's real local login state.

## [0.2.21] - 2026-02-18

### Changed

- Release workflow now hard-gates publish/deploy on `ci:local` success.
- Added a single local CI entrypoint: `npm run ci:local`.

### Fixed

- `init` no longer deletes its own runtime when run from the installed local app path.
- Added regression coverage for re-running `init` from the local runtime (`test/init-local-runtime-reinstall.test.js`).

## [0.2.16] - 2026-02-01

### Changed

- Project usage summary now always returns all-time totals, ignoring date filters.

### Fixed

- Dashboard auth callback storage tests now use complete Storage stubs for type safety.

## [0.2.15] - 2026-01-23

### Changed

- Bundle @insforge/sdk with the CLI package to avoid missing dependency errors at runtime.

## [0.2.14] - 2026-01-19

### Changed

- Maintenance release; no CLI behavior changes.
- Align scheduled ops workflows to vibeusage endpoints.

## [0.2.12] - 2026-01-09

### Changed

- Default CLI dashboard URL now points to https://www.vibeusage.cc.

## [0.2.11] - 2026-01-07

### Fixed

- Count Opencode cache write tokens in input totals.
- Include Claude cache creation input tokens in input totals.
- Avoid cross-message fallback totals when Opencode message index is missing.
- Surface a clear error when @insforge/sdk is missing at runtime.

## [0.2.10] - 2026-01-06

### Added

- Local Opencode usage audit CLI for comparing local usage with server totals.

### Changed

- Opencode audit defaults to ignoring missing hourly slots (use `--include-missing` to enforce).

### Fixed

- Prevent Opencode message rewrites or re-saves from double counting tokens.
- Fall back to legacy file totals when Opencode state metadata is missing.
- Defer Opencode total usage updates until timestamps are present.
- Preserve Opencode totals when message files are temporarily empty.
- Rollup backfill uses timestamptz to avoid timezone ambiguity.

## [0.2.9] - 2026-01-04

### Changed

- Opencode plugin now triggers on session.updated for auto sync.
- Opencode parser falls back to model/modelId when modelID is missing.

### Fixed

- Opencode plugin acceptance checks now align with shared plugin constants.

## [0.2.6] - 2026-01-01

### Changed

- Refresh CLI init install flow copy (local report → auth transition → success).
- Update confirmation prompt and success box messaging.

## [0.2.4] - 2025-12-30

### Fixed

- Skip Codex notify install when Codex config is missing.
- Uninstall now respects CODEX_HOME when restoring Codex notify.

## [0.2.3] - 2025-12-30

### Added

- Install Gemini CLI SessionEnd hook and enable Gemini hooks automatically for auto sync.

### Fixed

- Opencode plugin command template no longer escapes the `$` command in the generated plugin.

## [0.2.2] - 2025-12-30

### Added

- Opencode CLI usage ingestion via global plugin and local message parsing.

### Changed

- Init installs the Opencode plugin even when the config directory does not yet exist.
- Dashboard install copy now surfaces the link-code init command and removes the Opencode hint.

## [0.2.1] - 2025-12-29

### Changed

- Dashboard install panel restores the copy button and link code fetch flow.
- Init now runs a drain sync to upload all queued buckets immediately.

### Fixed

- Link code exchange uses records API to avoid RPC gateway 404s.

## [0.2.0] - 2025-12-28

### Added

- One-login link code install flow (Dashboard copy + CLI `init --link-code`).
- Link code init/exchange edge functions + RPC for short-lived codes.
- Retry-safe link code exchange in CLI via persisted request_id.

### Changed

- Dashboard shows a non-blocking session-expired banner with copy actions.
- Link code expiry auto-refreshes and re-requests on expiry.

### Fixed

- Link code exchange payload now matches RPC parameter names.
- Link code inserts allow authenticated users without service role key.

### Release

- Published to npm as `vibeusage@0.2.0`.

## [0.1.2] - 2025-12-27

### Changed

- Backfill unknown totals into the dominant known model within the same source + half-hour bucket.
- Align every-code unknown buckets to the nearest codex dominant model with deterministic tie-breakers.
- Retract prior every-code alignments and unknown buckets when newer information changes attribution.

## [0.1.1] - 2025-12-26

### Fixed

- Preserve per-model half-hour buckets (avoid collapsing multi-model hours into `unknown`).

## [0.1.0] - 2025-12-26

### Added

- Gemini CLI session parsing from `~/.gemini/tmp/**/chats/session-*.json` with UTC half-hour aggregation.
- Gemini token mapping that includes tool tokens in `output_tokens` and captures model metadata.

### Documentation

- Document Gemini CLI log location and `GEMINI_HOME`.

### Release

- Published to npm as `vibeusage@0.1.0`.

## [0.0.7] - 2025-12-24

### Added

- Auto-configure Every Code notify when `~/.code/config.toml` (or `CODE_HOME`) exists; skip if missing.

### Changed

- Notify handler supports `--source=every-code`, chains the correct original notify, and avoids self-recursion.
- Diagnostics output includes Every Code notify status and paths.

### Compatibility

- No breaking changes.
