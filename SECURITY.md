# Security Policy

## Supported Versions

Only the **latest minor release** is supported with security fixes. This is a small project — please run a recent version.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security reports.**

Instead, use one of these private channels:

- **GitHub Private Vulnerability Reporting**: [Report a vulnerability](https://github.com/xiufengsun/TokenTracker/security/advisories/new)
- **Email**: open a GitHub issue asking the maintainer to enable an alternative private channel if you can't use GitHub Security Advisories

When reporting, please include:

- A clear description of the issue
- Steps to reproduce
- Affected version(s)
- Your assessment of impact (data exposure, privilege escalation, etc.)
- Any suggested mitigation, if you have one

You can expect an initial response within a few days. Once a fix is ready, it will ship in the next release with a credit to you (or anonymously if you prefer).

## Scope

TokenTracker is a local-first tool that reads AI CLI tool logs from your home directory. The most sensitive areas to consider when reviewing security:

- **`src/lib/rollout.js`** — parses logs from 8 different AI CLI tools. Privacy rule: only token counts and timestamps may be extracted, never prompt or response content.
- **`src/lib/cursor-config.js`** — reads Cursor's local SQLite to extract auth tokens for the Cursor usage API. Tokens must never leave the user's machine.
- **`src/lib/local-api.js`** — local HTTP server bound to `127.0.0.1`. Should not accept connections from other hosts.
- **`TokenTrackerBar/`** — macOS app, ad-hoc signed. Has filesystem access via macOS TCC permissions; should never write outside its own data directories or the documented snapshot/queue paths.
- **`insforge/`** — optional cloud edge functions. Only used if the user opts into the leaderboard.

## Out of Scope

- Issues only reproducible with arbitrary modifications to the user's local files outside the documented data paths
- Vulnerabilities in dependencies that have already been disclosed and patched upstream — please report those upstream first
- Social engineering, phishing, or other non-technical attack vectors

## Privacy Commitment

TokenTracker's foundational privacy rule: **token counts and timestamps only — never any prompt content, response content, or file contents from user code**. Any change that risks violating this is treated as a security issue.
