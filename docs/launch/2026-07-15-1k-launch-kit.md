# TokenTracker 1K Launch Kit

Use this kit after the refreshed homepage and README are live. Publish in waves,
reply to every substantive comment, and adapt wording to each community. The
maintainer must be disclosed in every post.

## One-line positioning

TokenTracker turns real AI coding usage into a desktop companion: a pet, four
widgets, and achievements, backed by local-first tracking across 27 tools on
macOS, Windows, and the CLI.

## Proof points

- 27 supported AI coding tools.
- Native macOS menu bar and Windows system tray apps.
- Desktop pet driven by real token activity, streaks, and rest.
- Four widgets: usage, activity heatmap, top models, and rate limits.
- 15 achievement tracks.
- Local-first; prompts, responses, and code are never collected.
- One-command install: `npx --yes tokentracker-cli`.
- 14,300 npm downloads in the latest available 30-day window.
- Featured in 阮一峰科技爱好者周刊 #393.

## Primary assets

1. A 12–20 second video: pet types while usage rises, celebrates a streak,
   then reveal the widgets and an achievement unlock.
2. `docs/screenshots/pet.png`.
3. `docs/screenshots/widgets-overview.png`.
4. `docs/screenshots/achievements.png`.
5. `docs/screenshots/dashboard-dark.png` for the technical follow-up.

The pet is the first frame. Do not lead with another dashboard screenshot.

## Show HN

Title:

> Show HN: TokenTracker – a desktop pet powered by your AI coding usage

Body:

> Hi HN — I maintain TokenTracker, an open-source, local-first usage tracker
> for AI coding tools.
>
> The project started as a way to reconcile token counts across Claude Code,
> Codex, Cursor, Gemini, and the other tools I use. The useful part is still
> there: one normalized dashboard across 27 tools, provider-aware deduplication,
> cost estimates, project attribution, and rate-limit windows.
>
> But the part people remember is now the desktop experience. Your real token
> activity drives a pixel pet that codes, celebrates streaks, and sleeps when
> you stop. There are also four native widgets and an achievement system. It
> runs as a macOS menu bar app, a Windows tray app, or a cross-platform CLI.
>
> It never reads prompts, responses, or source code. The default path is fully
> local; cloud sync and the public leaderboard are optional.
>
> Try it: `npx --yes tokentracker-cli`
>
> Repo: https://github.com/mm7894215/TokenTracker
>
> I would especially value feedback on the pet/activity mapping and on token
> accounting edge cases from people who regularly switch between agents.

## linux.do

Title:

> 把 27 个 AI 编码工具的 Token 用量养成一只桌面宠物：TokenTracker

Body:

> 大家好，我是 TokenTracker 的维护者。这个项目最初只是想解决一个很
> 实际的问题：Claude Code、Codex、Cursor、Gemini、OpenCode 等工具各记
> 各的账，想看总用量、成本、项目归属和额度窗口非常麻烦。
>
> 现在它已经能本地聚合 27 款 AI 编码工具，但我不想再做一个冷冰冰的
> Dashboard，所以最近把真实用量做成了桌面体验：
>
> - 桌面宠物会根据真实 Token 活动写代码、庆祝 streak、休息；
> - 4 款桌面小组件常驻显示用量、热力图、常用模型和额度；
> - 15 条成就轨道记录你的使用习惯；
> - macOS 菜单栏、Windows 托盘和跨平台 CLI 都能用。
>
> 默认完全本地，只记录 Token 数和时间，不读取 prompt、回复或代码。
> 一条命令可以体验：`npx --yes tokentracker-cli`
>
> GitHub：https://github.com/mm7894215/TokenTracker
>
> 特别想听听大家对宠物状态和成就设计的建议：什么行为最值得奖励，
> 什么状态会让你愿意把它一直放在桌面上？

## V2EX

Title:

> [分享创造] 做了一个会根据 Claude Code / Codex 用量行动的桌面宠物

Body:

> 我是 TokenTracker 的作者。它可以把 Claude Code、Codex、Cursor、
> Gemini 等 27 款 AI 编码工具的 Token 用量和成本统一到本地 Dashboard。
>
> 最近加了三个我自己每天会看的东西：根据真实用量行动的桌面宠物、
> 4 款 macOS/Windows 桌面小组件、15 条成就轨道。宠物不是随机动画：有
> 新用量会工作，多模型并发会切状态，streak 会庆祝，停下来会休息。
>
> 默认不需要账号和 API Key，不读取 prompt、回复或代码；macOS、Windows
> 和 CLI 都支持。
>
> `npx --yes tokentracker-cli`
>
> https://github.com/mm7894215/TokenTracker
>
> 欢迎直接挑毛病，尤其是桌面常驻体验和数据准确性。

## Reddit: r/macapps

Title:

> I made a menu bar AI usage tracker with a desktop pet, widgets, and achievements

Body:

> I am the maintainer of TokenTracker, a free open-source menu bar app that
> tracks AI coding usage locally across 27 tools.
>
> The new part is deliberately less spreadsheet-like: a pixel pet reacts to
> your real coding activity, four native widgets show usage/heatmap/models/
> limits, and achievements turn your history into milestones. Prompts and code
> are never collected.
>
> There is a DMG and Homebrew cask, plus a Windows app and CLI. I would love
> feedback from people who keep utility apps visible all day.
>
> https://github.com/mm7894215/TokenTracker

## Reddit: AI coding communities

Title:

> I turned my Claude Code / Codex token history into a desktop pet

Body:

> Maintainer here. I built TokenTracker because I use several coding agents and
> could not get one trustworthy view of tokens, cost, cache usage, projects,
> and rate-limit windows.
>
> It now reads the local logs of 27 tools, normalizes them on-device, and drives
> a desktop pet, four widgets, and achievements from the same real activity.
> It does not read prompts, responses, or code.
>
> `npx --yes tokentracker-cli`
>
> https://github.com/mm7894215/TokenTracker
>
> I am interested in ugly accounting edge cases too — mirrored sessions,
> missing request IDs, cumulative counters, or anything that makes your
> provider dashboard disagree with local tools.

## X thread

1. I turned my AI coding usage into a desktop pet. It types when I use Claude
   Code/Codex, celebrates streaks, and sleeps when I stop. [video]
2. The same local data powers 4 widgets: usage, activity heatmap, top models,
   and rate limits — plus 15 achievement tracks.
3. Underneath, TokenTracker normalizes usage across 27 coding tools. Native
   macOS + Windows apps, and a cross-platform CLI.
4. Privacy rule: token counts only. No prompts, responses, or source code.
   Local-first; cloud features are optional.
5. Open source: https://github.com/mm7894215/TokenTracker
   Try it: `npx --yes tokentracker-cli`

## Product Hunt

Tagline:

> Your AI coding usage, brought to life on your desktop

Short description:

> A local-first token and cost tracker for 27 AI coding tools, with a desktop
> pet, four widgets, achievements, and native macOS/Windows apps.

## Publishing sequence

1. Ship the refreshed README/homepage and record the pet-led video.
2. Publish linux.do first because it is already a proven referrer.
3. Publish Show HN in a separate time window and stay available for replies.
4. Publish the macOS-native version to r/macapps with the widget image.
5. Publish one AI-coding community post with the pet video; do not duplicate it
   across subreddits on the same day.
6. Publish the X thread and Product Hunt page after real comment feedback has
   improved the wording.
7. Follow up the two existing mergeable awesome-list PRs with one concise,
   factual note only; do not repeatedly ping maintainers.

## Measurement

Record the timestamp and URL of every post. At +24h and +7d capture Stars,
repository unique visitors, top referrers, clones, and npm downloads. Keep the
channels that produce Stars, installs, or useful discussion; stop channels that
only create low-quality clicks.
