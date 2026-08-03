# Contributing to TokenTracker

Thanks for considering a contribution! TokenTracker is a small project, so the process is intentionally lightweight.

## Setup

```bash
git clone https://github.com/xiufengsun/TokenTracker.git
cd TokenTracker
npm install

# Build the dashboard once so the CLI can serve it
cd dashboard && npm install && npm run build && cd ..
```

## Run the CLI locally

```bash
node bin/tracker.js              # Start the local dashboard server (default: http://localhost:7680)
node bin/tracker.js sync         # Manual sync
node bin/tracker.js status       # Check hook status
node bin/tracker.js doctor       # Health check
```

## Tests

```bash
npm test                                     # Full suite (96 test files, node --test)
node --test test/rollout-parser.test.js      # A single test file
npm run ci:local                             # Tests + validations + builds (everything CI runs)
```

If you're touching the dashboard:

```bash
npm run dashboard:dev                        # Vite dev server with mocked API
npm run dashboard:build                      # Production build (output: dashboard/dist/)
npm run validate:copy                        # Validate copy registry completeness
```

## Pull Request Checklist

- [ ] Tests pass (`npm test`)
- [ ] If you added user-facing strings, add them to `dashboard/src/content/copy.csv`
- [ ] If you changed Swift, run `xcodegen generate` after editing `TokenTrackerBar/project.yml`
- [ ] Conventional commit style: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `ci:`, `test:`
- [ ] PR description explains *why*, not just *what*

## Adding a New AI Tool Integration

This is the most common kind of contribution. The pattern:

1. **Add a parser to `src/lib/rollout.js`** — most tools write JSONL or SQLite logs. The parser should normalize tokens into the canonical shape: `{input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, total_tokens, model, source, hour_start}`.
2. **Add a hook installer in `src/commands/init.js`** — most tools support a config file or hook script you can patch. Make it idempotent (safe to re-run).
3. **Add a status check in `src/commands/status.js`** — show whether the hook is installed and whether data has been collected.
4. **Add a parser test in `test/rollout-parser.test.js`** — use a real (anonymized) sample log fixture.
5. **Update `README.md` Supported AI Tools table** with the new row.

Look at how Claude Code, Codex, or Gemini are wired in for reference — they're the simplest examples.

## Code Style

- **CLI (`src/`)**: CommonJS, Node 20+, no transpilation. Match the existing style.
- **Dashboard (`dashboard/`)**: TypeScript strict, React 18, ESM, Tailwind. Match the existing style.
- **macOS (`TokenTrackerBar/`)**: Swift 5.9, SwiftUI + AppKit. Match the existing style.
- No linter wars. Be reasonable.

## Privacy Rule (non-negotiable)

TokenTracker tracks **only token counts and timestamps**. Never log, store, transmit, or print any prompt content, response content, file paths from user code, or anything that could leak what the user is working on. If your change touches a parser, double-check this.

## Releasing (maintainers only)

See the "Release Workflow" section in [CLAUDE.md](CLAUDE.md).
