# Privacy Policy

_Last updated: 2026-07-27 · Applies to the `tokentracker-cli` npm package, the macOS app, the Windows app, and [www.tokentracker.cc](https://www.tokentracker.cc)._

TokenTracker reads the local logs that AI coding tools already write to your disk, and turns them into token counts and cost estimates. It is local-first: the dashboard, the parsers and the database all run on your machine.

This document lists **every** network request the software can make, what each one sends, and how to switch it off. If you find a request that is not listed here, that is a bug — please [open an issue](https://github.com/xiufengsun/TokenTracker/issues).

---

## 1. What never leaves your machine

TokenTracker's parsers extract numbers and timestamps only.

**Never read, never recorded anywhere:**

- **Prompts, responses, and conversation bodies**
- **File contents** from your projects
- **Commit messages and diffs** — Git attribution runs `git log` locally, uses the subject line only to detect reverts, and keeps nothing
- **API keys, cookies, and session tokens** belonging to your AI providers

**Recorded locally, never uploaded:**

- **File paths, project names, and repository names.** The Projects view needs to know which repo a session belonged to, so `project.queue.jsonl` stores a project key and git remote URL, and `session.queue.jsonl` stores each session's working directory. Both files stay on your machine — they are excluded from cloud sync (see §4) and the Projects view is computed entirely locally. Set `TOKENTRACKER_DISABLE_GIT_ATTRIBUTION=1` to stop deriving them at all.

You can verify this in [`src/lib/rollout.js`](../src/lib/rollout.js): every `parse*Incremental` function emits only the queue row shapes described below.

---

## 2. What is stored locally

Everything lives under `~/.tokentracker/` (`%USERPROFILE%\.tokentracker\` on Windows):

| Path | Contents |
|---|---|
| `tracker/queue.jsonl` | Append-only hourly buckets: source, model, token counts, timestamp |
| `tracker/project.queue.jsonl` | The same hourly buckets, split per project: git remote URL and `owner/repo` key. Never uploaded |
| `tracker/session.queue.jsonl` | Per-session token totals and timing for the Sessions view, plus each session's working directory. Never uploaded |
| `tracker/cursors.json` | Read offsets so parsing stays incremental |
| `tracker/config.json` | Your preferences |
| `tracker/*-usage-limits-cache.json` | Last successful quota reading per provider, so a timeout shows stale bars instead of an error |
| `pets/`, `skills/`, `cache/` | Desktop pet assets, skill index, misc caches |

To erase everything TokenTracker knows about you, delete that directory. `tokentracker uninstall` additionally removes the hooks it installed into your AI tools.

---

## 3. Network requests

### 3.1 Enabled by default

| Request | Destination | What is sent | Frequency |
|---|---|---|---|
| **Anonymous heartbeat** | `srctyff5.us-east.insforge.app` | A one-way hash of the machine id, app version, OS platform, and shell (`cli` / `mac` / `win`). Nothing else. | At most once per day |
| **Dashboard analytics** | `us.i.posthog.com` (PostHog) | Pageviews and explicitly instrumented feature events, plus which shell you use. Autocapture and session recording are **off**; browser Do-Not-Track is respected. | While the dashboard is open |
| **Provider quota reads** | The provider's own API (`api.anthropic.com`, `chatgpt.com`, `cursor.com`, `api.github.com`, `api.kimi.com`, `api.z.ai`, `qoder.com`, `qoder.com.cn`, `openapi.qoder.sh`, `openapi.qoder.com.cn`, `cloudcode-pa.googleapis.com`, …) | Whatever that provider's own endpoint requires, authenticated with the credentials **that provider already stored on your machine**. These requests go directly from your machine to the provider — they never pass through our servers, and we never see the response. | While quota bars are visible |
| **GitHub star count** | `api.github.com` | Nothing but the request itself (public repo metadata) | On dashboard load |
| **Update check** | `api.github.com` | Nothing but the request itself | Windows: once at launch. macOS: only when you click "Check for Updates" |

Both telemetry items are disabled together by a single switch:

```bash
export TOKENTRACKER_NO_TELEMETRY=1     # or DO_NOT_TRACK=1
```

You can also set `"telemetry": false` in `~/.tokentracker/tracker/config.json`. On localhost and inside the desktop apps, the dashboard asks the local server for this preference before initialising analytics — and if the answer cannot be confirmed, analytics stays **off** (fail-closed).

Audit: [`src/lib/telemetry.js`](../src/lib/telemetry.js), [`dashboard/src/lib/analytics.js`](../dashboard/src/lib/analytics.js).

### 3.2 Only after you opt in or click something

| Request | Destination | What is sent | Trigger |
|---|---|---|---|
| **Cloud sync / leaderboard** | `srctyff5.us-east.insforge.app` | Hourly buckets only — see §4 | Signing in to a TokenTracker account |
| **Exchange rates** | `open.er-api.com` | Nothing but the request itself | Selecting a non-USD display currency |
| **Desktop pet download** | `codex-pets.net` | The pet id you chose | Importing a pet from a link |
| **IP check page** | `ip.net.coffee`, `claude.ai`, `1.1.1.1` | Your IP address is, by design, what these endpoints observe — that page exists to tell you how providers see your network | Opening the IP Check page |
| **Service status page** | Provider status pages (`status.claude.com`, `status.openai.com`, `status.cursor.com`, …) | Nothing but the request itself | Opening the Service Status page |
| **Share card fonts** | `fonts.googleapis.com` | Standard web-font request; Google can see your IP address | Generating a share image |

### 3.3 Never

- No request contains prompt text, responses, file contents, paths, or project names.
- We operate no ad network, no data broker integration, and no cross-site tracking.
- We do not sell, rent, or share your data with third parties.

---

## 4. Cloud account and leaderboard

Signing in is **entirely optional**. TokenTracker is fully functional without an account; the leaderboard, cross-device aggregation, badges and public profiles are the only features that require one.

**Sent when signed in:**

- Hourly usage buckets, each containing exactly: `hour_start`, `source`, `model`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `cache_creation_input_tokens`, `reasoning_output_tokens`, `total_tokens`, `conversation_count`
- A machine id at device-registration time, so usage from several computers can be merged into one account without double-counting
- The email address and display name from your OAuth provider (GitHub or Google)

**Not sent, ever:**

- Prompts, responses, file contents, project or repository names, file paths
- Local session records — `session.queue.jsonl` stays on your machine
- Per-project breakdowns — `project.queue.jsonl` is never uploaded
- Any provider credential

**Public visibility:** your profile appears on the public leaderboard only while `Settings → Account → Public profile` is on. Turning it off removes you from the leaderboard and turns badges into a "private" placeholder.

**Deleting cloud data:** contact us via [GitHub issues](https://github.com/xiufengsun/TokenTracker/issues) and we will remove the account and its rows. Deleting `~/.tokentracker/` removes the local copy immediately.

---

## 5. Third parties

| Service | Role | Their policy |
|---|---|---|
| InsForge | Backend for accounts, cloud sync, leaderboard, heartbeat | [github.com/InsForge](https://github.com/InsForge) |
| PostHog | Anonymous product analytics | [posthog.com/privacy](https://posthog.com/privacy) |
| Vercel | Hosting for www.tokentracker.cc | [vercel.com/legal/privacy-policy](https://vercel.com/legal/privacy-policy) |
| GitHub | Source hosting, releases, OAuth, star counts | [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement) |
| Google | OAuth sign-in, fonts on share cards | [policies.google.com/privacy](https://policies.google.com/privacy) |

AI providers whose quota endpoints TokenTracker reads (Anthropic, OpenAI, Cursor, GitHub Copilot, Google, Moonshot, Z.ai, Qoder, …) are governed by their own policies. TokenTracker acts on your behalf with credentials already on your machine; it does not create any new relationship with them.

---

## 6. Turning things off

| Variable | Effect |
|---|---|
| `TOKENTRACKER_NO_TELEMETRY=1` | Disables the daily heartbeat **and** dashboard analytics |
| `DO_NOT_TRACK=1` | Same as above (respects the standard) |
| `TOKENTRACKER_DISABLE_GIT_ATTRIBUTION=1` | Stops TokenTracker running `git log` inside your project directories |

Signing out removes cloud sync. Not signing in means it never starts.

---

## 7. Children

TokenTracker is a developer tool and is not directed at children under 13. We do not knowingly collect personal information from children.

## 8. Changes

Material changes to this policy will be noted in the release notes and in the `Last updated` date above. The full history is in [this file's Git log](https://github.com/xiufengsun/TokenTracker/commits/main/docs/PRIVACY.md).

## 9. Contact

Questions, corrections, or deletion requests: [github.com/xiufengsun/TokenTracker/issues](https://github.com/xiufengsun/TokenTracker/issues)
