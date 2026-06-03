# npm publish checklist

This fork publishes the CLI as `@ipv9/tokentracker-cli`. Keep the binary aliases
unchanged: `tokentracker`, `tracker`, and `tokentracker-cli`.

Run these checks before publishing:

```bash
npm ci
npm --prefix dashboard ci
npm --prefix dashboard run build
npm test
npm --prefix dashboard test
npm pack --dry-run --json
npm publish --access public --dry-run
npm publish --access public
```

The dry-run pack output must include `dashboard/dist/index.html` and the macOS
service scripts under `scripts/`.

Privacy boundary for local services:

- `scripts/install-local-service.sh` installs a local dashboard LaunchAgent and a
  five-minute local sync LaunchAgent.
- The local sync wrapper exits successfully without syncing when
  `TOKENTRACKER_DEVICE_TOKEN` or `~/.tokentracker/tracker/config.json`
  `deviceToken` is configured.
- Local dashboard mode must not preload or display leaderboard navigation on
  `localhost`.
