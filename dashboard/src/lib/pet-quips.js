/**
 * Localized "quip" pools for the floating desktop pet's speak-on-tap bubble,
 * ported 1:1 from the macOS app (TokenTrackerBar/Utilities/Strings.swift). Kept as
 * a standalone data module — like Strings.swift — rather than the dashboard copy
 * registry, because the pet is a minimal standalone entry without the i18n provider.
 *
 * Tiering matches macOS: today's token volume picks a pool; personality lines are
 * always mixed in. (The "syncing" pool is omitted — the pet can't observe sync state.)
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

/** Pick a random quip for the given locale + today's token volume (syncing quips
 *  while a sync is in progress, matching macOS). */
export function pickQuip(locale, tokens, isSyncing = false) {
  const loc = normalizePetLocale(locale);
  if (isSyncing) {
    const s = SYNCING_QUIPS[loc] || SYNCING_QUIPS.en;
    return s[Math.floor(Math.random() * s.length)] || "";
  }
  const pool = QUIPS[loc] || QUIPS.en;
  const candidates = [...(pool[tierFor(tokens)] || []), ...pool.personality];
  return candidates[Math.floor(Math.random() * candidates.length)] || "";
}
