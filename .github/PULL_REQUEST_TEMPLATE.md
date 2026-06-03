## Summary

<!-- One sentence: what does this PR do, and why? -->

## Scope

- [ ] CLI (`src/`)
- [ ] Dashboard (`dashboard/`)
- [ ] macOS app (`TokenTrackerBar/`)
- [ ] Windows app (`TokenTrackerWin/`)
- [ ] Docs / CI / config

## Checklist

- [ ] `npm test` passes
- [ ] New user-facing strings go through `dashboard/src/content/copy.csv` (no hardcoded UI text)
- [ ] Commits follow conventional style (`feat:` / `fix:` / `refactor:` / `docs:` / `chore:` / `test:` / `ci:`)
- [ ] PR description explains *why*, not just *what*

---

<details>
<summary><strong>Risk layer addendum</strong> — expand if this PR touches any trigger below</summary>

### Risk layer triggers

- [ ] Public exposure / share links / unauthenticated access
- [ ] Auth / session / token handling
- [ ] Cross-endpoint invariants or shared logic
- [ ] External gateway / environment constraints

### Rules / invariants

-

### Boundary matrix (list at least 3)

-

### Public exposure checklist (if applicable)

- [ ] Public access rules defined (share token required, non-JWT handling, 401 behavior)
- [ ] Exposed fields explicitly listed and verified
- [ ] Avatar/image policy defined
- [ ] Regression tests cover invalid link and auth fallback

</details>

<details>
<summary><strong>Codex review context</strong> — fill when requesting <code>@codex</code> review</summary>

- **Delta since last Codex review:** (commits or summary)
- **Intended behavior / invariants:**
- **Edge cases covered:**
- **Tests run (command + result):**
- **Known gaps / out of scope:**

### Most likely regression surface

-

### Verification method (choose at least one)

-

### Uncovered scope

-

</details>
