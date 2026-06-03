/**
 * Localized "quip" pools for the floating desktop pet's speak-on-tap bubble,
 * ported 1:1 from the macOS app (TokenTrackerBar/Utilities/Strings.swift). Kept as
 * a standalone data module — like Strings.swift — rather than the dashboard copy
 * registry, because the pet is a minimal standalone entry without the i18n provider.
 *
 * Full macOS parity: `buildQuipPool` reproduces the macOS companion's `quipPool`
 * ordering 1:1 — today data (tokens + cost + tier) → 7d/30d rolling → heatmap
 * streak/active days → top models → conversation count → personality. The native host
 * now pushes ALL of these figures (window.__ttPetStats), the same ones macOS reads from
 * its DashboardViewModel, so the Windows pet is no longer limited to today's numbers.
 * The caller rotates through the pool by index on each tap (like macOS `quipIndex`):
 * because the data-rich lines outnumber the handful of personality lines, most taps
 * surface real numbers and personality stays a natural minority — no random weighting.
 */

const QUIPS = {
  "en": {
    empty: [
      "😴 No tokens yet today", "💬 Start chatting to wake me up!", "🌙 Quiet day so far...",
      "⌨️ Waiting for your first prompt", "💤 Zzz... nothing to count", "🌅 The calm before the storm?",
      "✨ I'm ready when you are!",
    ],
    warmup: ["☕ Just warming up!", "🌱 A gentle start"],
    flow: ["🎯 Getting into the flow!", "💪 Solid progress today"],
    busy: ["🔥 Busy day!", "⚡ You're on a roll!"],
    heavy: ["🚀 Heavy usage today!", "🖨️ Token machine goes brrr"],
    massive: ["🤯 MASSIVE day!", "🔥 Token counter on fire!"],
    personality: [
      "👆 Tap me for more!", "📋 I count so you don't have to", "✨ Every token tells a story",
      "🤝 Your AI spending buddy", "👋 Hey there~",
    ],
  },
  "zh-CN": {
    empty: [
      "😴 今天还没有 tokens", "💬 发起一次对话来唤醒我！", "🌙 今天暂时很安静...",
      "⌨️ 等待你的第一个 prompt", "💤 Zzz... 还没有可统计内容", "🌅 风暴前的平静？", "✨ 我已经准备好了！",
    ],
    warmup: ["☕ 刚刚热身！", "🌱 温和开局"],
    flow: ["🎯 开始进入状态！", "💪 今天进展不错"],
    busy: ["🔥 今天很忙！", "⚡ 状态正佳！"],
    heavy: ["🚀 今天用量很高！", "🖨️ Token 机器启动"],
    massive: ["🤯 今天用量爆表！", "🔥 Token 计数器燃起来了！"],
    personality: ["👆 点我查看更多！", "📋 我来帮你计数", "✨ 每个 token 都有故事", "🤝 你的 AI 花费伙伴", "👋 你好呀~"],
  },
  "zh-TW": {
    empty: [
      "😴 今天還沒有 tokens", "💬 發起一次對話來喚醒我！", "🌙 今天暫時很安靜...",
      "⌨️ 等待你的第一個 prompt", "💤 Zzz... 還沒有可統計內容", "🌅 風暴前的平靜？", "✨ 我已經準備好了！",
    ],
    warmup: ["☕ 剛剛熱身！", "🌱 溫和開局"],
    flow: ["🎯 開始進入狀態！", "💪 今天進展不錯"],
    busy: ["🔥 今天很忙！", "⚡ 狀態正佳！"],
    heavy: ["🚀 今天用量很高！", "🖨️ Token 機器啟動"],
    massive: ["🤯 今天用量爆表！", "🔥 Token 計數器燃起來了！"],
    personality: ["👆 點我檢視更多！", "📋 我來幫你計數", "✨ 每個 token 都有故事", "🤝 你的 AI 花費夥伴", "👋 你好呀~"],
  },
  "ja": {
    empty: [
      "😴 今日はまだトークンなし", "💬 話しかけて起こして！", "🌙 今のところ静かな一日...",
      "⌨️ 最初のプロンプトを待っています", "💤 Zzz... 数えるものがありません", "🌅 嵐の前の静けさ？", "✨ いつでも準備OK！",
    ],
    warmup: ["☕ ウォームアップ中！", "🌱 穏やかな滑り出し"],
    flow: ["🎯 調子が出てきた！", "💪 今日は順調"],
    busy: ["🔥 忙しい一日！", "⚡ 絶好調！"],
    heavy: ["🚀 今日は使用量が多い！", "🖨️ トークンマシン全開"],
    massive: ["🤯 爆発的な一日！", "🔥 トークンカウンター炎上中！"],
    personality: ["👆 タップして詳細表示！", "📋 数えるのは私にお任せ", "✨ どのトークンにも物語がある", "🤝 あなたの AI 支出の相棒", "👋 やあ~"],
  },
  "ko": {
    empty: [
      "😴 오늘은 아직 토큰이 없어요", "💬 말을 걸어 깨워주세요!", "🌙 아직은 조용한 하루...",
      "⌨️ 첫 프롬프트를 기다리는 중", "💤 Zzz... 셀 게 없네요", "🌅 폭풍 전의 고요?", "✨ 준비됐어요!",
    ],
    warmup: ["☕ 이제 막 시동 중!", "🌱 잔잔한 출발"],
    flow: ["🎯 흐름을 타는 중!", "💪 오늘 순조로워요"],
    busy: ["🔥 바쁜 하루!", "⚡ 물 올랐어요!"],
    heavy: ["🚀 오늘 사용량 많네요!", "🖨️ 토큰 머신 풀가동"],
    massive: ["🤯 폭발적인 하루!", "🔥 토큰 카운터 불났어요!"],
    personality: ["👆 더 보려면 탭하세요!", "📋 세는 건 제가 할게요", "✨ 모든 토큰엔 이야기가 있죠", "🤝 당신의 AI 지출 친구", "👋 안녕하세요~"],
  },
};

// Usage-aware "today data" quips — ported 1:1 from the macOS companion's quipPool
// (tokensToday / tokensSpentToday / aiInvestedToday / billToday / aiTabToday). The
// `{tokens}` / `{cost}` placeholders are filled with the SAME formatted figures the
// hover bubble shows. `tokens` is always eligible; the `cost` lines only when today's
// cost rounds above zero (matching macOS, which skips them at $0.00).
const TODAY_QUIPS = {
  "en": {
    tokens: ["📊 Today: {tokens} tokens"],
    cost: [
      "📈 {tokens} tokens — {cost} spent today",
      "💰 {cost} invested in AI so far",
      "🧾 Today's bill: {cost} for {tokens} tokens",
      "💳 AI tab today: {cost}",
    ],
  },
  "zh-CN": {
    tokens: ["📊 今日：{tokens} tokens"],
    cost: [
      "📈 今日 {tokens} tokens，花费 {cost}",
      "💰 今日 AI 投入：{cost}",
      "🧾 今日账单：{cost}，{tokens} tokens",
      "💳 今日 AI 账单：{cost}",
    ],
  },
  "zh-TW": {
    tokens: ["📊 今日：{tokens} tokens"],
    cost: [
      "📈 今日 {tokens} tokens，花費 {cost}",
      "💰 今日 AI 投入：{cost}",
      "🧾 今日賬單：{cost}，{tokens} tokens",
      "💳 今日 AI 賬單：{cost}",
    ],
  },
  "ja": {
    tokens: ["📊 今日：{tokens} tokens"],
    cost: [
      "📈 今日 {tokens} tokens、{cost} 使用",
      "💰 これまでの AI 投資：{cost}",
      "🧾 今日の請求：{cost}（{tokens} tokens）",
      "💳 今日の AI 利用料：{cost}",
    ],
  },
  "ko": {
    tokens: ["📊 오늘: {tokens} tokens"],
    cost: [
      "📈 오늘 {tokens} tokens, {cost} 지출",
      "💰 지금까지 AI 투자: {cost}",
      "🧾 오늘 청구: {cost}, {tokens} tokens",
      "💳 오늘 AI 비용: {cost}",
    ],
  },
};

// Rolling / heatmap / top-model / conversation quips — ported 1:1 from the macOS
// companion's quipPool (Strings.sevenDayTotal / activeDaysThisWeek / perfectStreak /
// thirtyDayTotal / averagingPerDay / streakDays / activeDaysAllTime / topModel /
// runnerUp / modelCount / multiToolSetup / conversationsToday / busyTalker). The native
// host pushes these figures (window.__ttPetStats) — the same ones macOS reads from its
// DashboardViewModel. Placeholders: {tokens} compact token count, {n} a count, {name}
// model name, {percent} share (one decimal, no % — matching macOS), {names} provider
// list, {s} English plural suffix.
const STATS_QUIPS = {
  "en": {
    sevenDayTotal: "📅 7-day total: {tokens} tokens",
    activeDaysThisWeek: "{n} active days this week",
    perfectStreak: "🏆 7/7 active days — perfect streak!",
    thirtyDayTotal: "📆 30-day total: {tokens} tokens",
    averagingPerDay: "📊 Averaging ~{tokens}/day this month",
    streakDays: "🔥 {n}-day streak! Keep it going",
    activeDaysAllTime: "📈 {n} active days all-time!",
    topModel: "🥇 Top model: {name} ({percent})",
    runnerUp: "🥈 Runner-up: {name} at {percent}",
    modelCount: "🧰 Using {n} different models",
    multiToolSetup: "🔀 Multi-tool setup: {names}",
    conversationsToday: "💬 {n} conversation{s} today",
    busyTalker: "🗣️ {n} chats! Busy talker today",
  },
  "zh-CN": {
    sevenDayTotal: "📅 7 天总计：{tokens} tokens",
    activeDaysThisWeek: "本周 {n} 个活跃日",
    perfectStreak: "🏆 7/7 活跃日，完美连续！",
    thirtyDayTotal: "📆 30 天总计：{tokens} tokens",
    averagingPerDay: "📊 本月平均约 {tokens}/天",
    streakDays: "🔥 连续 {n} 天！继续保持",
    activeDaysAllTime: "📈 累计 {n} 个活跃日！",
    topModel: "🥇 最常用模型：{name}（{percent}）",
    runnerUp: "🥈 第二名：{name}，{percent}",
    modelCount: "🧰 使用了 {n} 个不同模型",
    multiToolSetup: "🔀 多工具组合：{names}",
    conversationsToday: "💬 今日 {n} 次对话",
    busyTalker: "🗣️ {n} 次聊天，今天很忙",
  },
  "zh-TW": {
    sevenDayTotal: "📅 7 天總計：{tokens} tokens",
    activeDaysThisWeek: "本週 {n} 個活躍日",
    perfectStreak: "🏆 7/7 活躍日，完美連續！",
    thirtyDayTotal: "📆 30 天總計：{tokens} tokens",
    averagingPerDay: "📊 本月平均約 {tokens}/天",
    streakDays: "🔥 連續 {n} 天！繼續保持",
    activeDaysAllTime: "📈 累計 {n} 個活躍日！",
    topModel: "🥇 最常用模型：{name}（{percent}）",
    runnerUp: "🥈 第二名：{name}，{percent}",
    modelCount: "🧰 使用了 {n} 個不同模型",
    multiToolSetup: "🔀 多工具組合：{names}",
    conversationsToday: "💬 今日 {n} 次對話",
    busyTalker: "🗣️ {n} 次聊天，今天很忙",
  },
  "ja": {
    sevenDayTotal: "📅 7日間合計：{tokens} tokens",
    activeDaysThisWeek: "今週 {n} アクティブ日",
    perfectStreak: "🏆 7/7 アクティブ日 — 完璧な連続記録！",
    thirtyDayTotal: "📆 30日間合計：{tokens} tokens",
    averagingPerDay: "📊 今月は平均約 {tokens}/日",
    streakDays: "🔥 {n}日連続！この調子で",
    activeDaysAllTime: "📈 累計 {n} アクティブ日！",
    topModel: "🥇 最も使用したモデル：{name}（{percent}）",
    runnerUp: "🥈 2位：{name}（{percent}）",
    modelCount: "🧰 {n} 種類のモデルを使用中",
    multiToolSetup: "🔀 マルチツール構成：{names}",
    conversationsToday: "💬 今日 {n} 件の会話",
    busyTalker: "🗣️ {n} 回のチャット！今日はおしゃべり",
  },
  "ko": {
    sevenDayTotal: "📅 7일 합계: {tokens} tokens",
    activeDaysThisWeek: "이번 주 활동일 {n}일",
    perfectStreak: "🏆 7/7 활동일 — 완벽한 연속 기록!",
    thirtyDayTotal: "📆 30일 합계: {tokens} tokens",
    averagingPerDay: "📊 이번 달 하루 평균 ~{tokens}",
    streakDays: "🔥 {n}일 연속! 계속 가요",
    activeDaysAllTime: "📈 누적 활동일 {n}일!",
    topModel: "🥇 최다 사용 모델: {name} ({percent})",
    runnerUp: "🥈 2위: {name}, {percent}",
    modelCount: "🧰 서로 다른 모델 {n}개 사용 중",
    multiToolSetup: "🔀 멀티 툴 구성: {names}",
    conversationsToday: "💬 오늘 대화 {n}건",
    busyTalker: "🗣️ 채팅 {n}회! 오늘 수다스럽네요",
  },
};

// Shown (and used for tap quips) while a sync is in progress — ported from the
// macOS app's syncingQuips.
const SYNCING_QUIPS = {
  "en": ["⏳ Crunching numbers...", "📡 Fetching latest data!", "🔄 One moment, syncing...", "🧮 Counting your tokens~"],
  "zh-CN": ["⏳ 正在计算数据...", "📡 正在获取最新数据！", "🔄 稍等，正在同步...", "🧮 正在统计 tokens~"],
  "zh-TW": ["⏳ 正在計算資料...", "📡 正在獲取最新資料！", "🔄 稍等，正在同步...", "🧮 正在統計 tokens~"],
  "ja": ["⏳ 計算中...", "📡 最新データを取得中！", "🔄 少々お待ちを、同期中...", "🧮 トークンを数えています~"],
  "ko": ["⏳ 계산 중...", "📡 최신 데이터 가져오는 중!", "🔄 잠시만요, 동기화 중...", "🧮 토큰을 세는 중~"],
};

// Hover-bubble labels (the dynamic usage line is composed in pet.jsx).
const PET_LABELS = {
  "en": { today: "Today", noUsage: "No usage yet today", offline: "Offline · can't reach the server", syncing: "Syncing…" },
  "zh-CN": { today: "今日", noUsage: "今天还没有用量", offline: "离线 · 连不上服务", syncing: "正在同步…" },
  "zh-TW": { today: "今日", noUsage: "今天還沒有用量", offline: "離線 · 連不上服務", syncing: "正在同步…" },
  "ja": { today: "今日", noUsage: "今日はまだ使用なし", offline: "オフライン · サーバーに接続できません", syncing: "同期中…" },
  "ko": { today: "오늘", noUsage: "오늘 사용 없음", offline: "오프라인 · 서버에 연결할 수 없음", syncing: "동기화 중…" },
};

/** Localized hover-bubble labels for the given locale. */
export function petLabels(locale) {
  return PET_LABELS[normalizePetLocale(locale)] || PET_LABELS.en;
}

function tierFor(tokens) {
  if (tokens <= 0) return "empty";
  if (tokens < 50_000) return "warmup";
  if (tokens < 200_000) return "flow";
  if (tokens < 500_000) return "busy";
  if (tokens < 2_000_000) return "heavy";
  return "massive";
}

/** Map any locale tag / preference to one of the supported quip locales. */
export function normalizePetLocale(raw) {
  const tag = String(raw || "").toLowerCase();
  if (!tag || tag === "system") return systemPetLocale();
  if (tag.startsWith("zh")) {
    return /(tw|hk|mo|hant)/.test(tag) ? "zh-TW" : "zh-CN";
  }
  if (tag.startsWith("ja")) return "ja";
  if (tag.startsWith("ko")) return "ko";
  return "en";
}

function systemPetLocale() {
  try {
    return normalizePetLocale(navigator.language || "en");
  } catch {
    return "en";
  }
}

/** Fill {key} placeholders from a vars map; unmatched braces are left as-is. */
function fillVars(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Capitalize the first letter (matches macOS `String.capitalized` for single words). */
function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Compact token formatter (1 decimal K/M/B) — matches the tray's UsagePoller.FormatTokens
 * and the macOS TokenFormatter.formatCompact so every surface reads the same number.
 */
export function formatCompactTokens(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/**
 * Build the full tap-quip pool for the given locale — a faithful port of the macOS
 * companion's `quipPool` (ClawdCompanionView.swift): today data → 7d/30d rolling →
 * heatmap streak/active → top models → conversations → personality. The caller rotates
 * through the returned list by index on each tap (matching macOS `quipIndex`), so the
 * data-rich lines (the majority of the pool) dominate and the generic personality lines
 * stay a natural minority — no random down-weighting needed.
 *
 * `ctx` (all optional): tokens, tokensText, costText, costValue, isSyncing (today);
 * conversations; last7dTokens, last7dActiveDays; last30dTokens, last30dAvgPerDay;
 * streakDays, activeDaysAllTime; topModels [{ name, percent, source }].
 */
export function buildQuipPool(locale, ctx = {}) {
  const {
    tokens = 0, tokensText = "", costText = "", costValue = 0, isSyncing = false,
    conversations = 0,
    last7dTokens = 0, last7dActiveDays = 0,
    last30dTokens = 0, last30dAvgPerDay = 0,
    streakDays = 0, activeDaysAllTime = 0,
    topModels = [],
  } = ctx;
  const loc = normalizePetLocale(locale);
  if (isSyncing) return SYNCING_QUIPS[loc] || SYNCING_QUIPS.en;

  const pool = QUIPS[loc] || QUIPS.en;
  const today = TODAY_QUIPS[loc] || TODAY_QUIPS.en;
  const stats = STATS_QUIPS[loc] || STATS_QUIPS.en;
  const todayVars = { tokens: tokensText, cost: costText };
  const out = [];

  // === Today data ===
  if (tokens <= 0) {
    out.push(...pool.empty);
  } else {
    out.push(...today.tokens.map((t) => fillVars(t, todayVars)));
    if (costValue >= 0.005) out.push(...today.cost.map((t) => fillVars(t, todayVars)));
    out.push(...(pool[tierFor(tokens)] || []));
  }

  // === 7-day / 30-day rolling ===
  if (last7dTokens > 0) {
    out.push(fillVars(stats.sevenDayTotal, { tokens: formatCompactTokens(last7dTokens) }));
    if (last7dActiveDays > 0) {
      // macOS prepends the 🗓️ at the call site, not in the string.
      out.push("🗓️ " + fillVars(stats.activeDaysThisWeek, { n: last7dActiveDays }));
      if (last7dActiveDays >= 7) out.push(stats.perfectStreak);
    }
  }
  if (last30dTokens > 0) {
    out.push(fillVars(stats.thirtyDayTotal, { tokens: formatCompactTokens(last30dTokens) }));
    if (last30dAvgPerDay > 0) {
      out.push(fillVars(stats.averagingPerDay, { tokens: formatCompactTokens(last30dAvgPerDay) }));
    }
  }

  // === Heatmap (streak / all-time active days) ===
  if (streakDays > 1) out.push(fillVars(stats.streakDays, { n: streakDays }));
  if (activeDaysAllTime > 30) out.push(fillVars(stats.activeDaysAllTime, { n: activeDaysAllTime }));

  // === Top models ===
  if (topModels.length > 0) {
    const top = topModels[0];
    out.push(fillVars(stats.topModel, { name: top.name, percent: top.percent }));
    if (topModels.length >= 2) {
      out.push(fillVars(stats.runnerUp, { name: topModels[1].name, percent: topModels[1].percent }));
    }
    if (topModels.length >= 3) out.push(fillVars(stats.modelCount, { n: topModels.length }));
    const sources = [...new Set(topModels.map((m) => m.source).filter(Boolean))];
    if (sources.length >= 2) {
      out.push(fillVars(stats.multiToolSetup, { names: sources.map(cap).sort().join(" + ") }));
    }
  }

  // === Conversation count ===
  if (conversations > 0) {
    out.push(fillVars(stats.conversationsToday, { n: conversations, s: conversations === 1 ? "" : "s" }));
    if (conversations >= 10) out.push(fillVars(stats.busyTalker, { n: conversations }));
  }

  // === Personality (always) ===
  out.push(...pool.personality);

  return out.length ? out : pool.personality;
}
