export const DEFAULT_MENU_BAR_ITEMS = ["todayTokens", "todayCost"];

export const FALLBACK_MENU_BAR_ITEMS = [
  { id: "todayTokens", label: "Today Tokens", shortLabel: "Tokens", category: "tokens" },
  { id: "todayCost", label: "Today Cost", shortLabel: "Cost", category: "cost" },
  { id: "last7dTokens", label: "Last 7 Days", shortLabel: "7d", category: "tokens" },
  { id: "totalTokens", label: "Total Tokens", shortLabel: "Total", category: "tokens" },
  { id: "totalCost", label: "Total Cost", shortLabel: "All $", category: "cost" },
  { id: "claude5h", label: "Claude 5h Limit", shortLabel: "Cl 5h", category: "limits" },
  { id: "claude7d", label: "Claude 7d Limit", shortLabel: "Cl 7d", category: "limits" },
  { id: "codex5h", label: "Codex 5h Limit", shortLabel: "Cx 5h", category: "limits" },
  { id: "codex7d", label: "Codex 7d Limit", shortLabel: "Cx 7d", category: "limits" },
  { id: "cursorPlan", label: "Cursor Plan Limit", shortLabel: "Cu Plan", category: "limits" },
  { id: "cursorAuto", label: "Cursor Auto Limit", shortLabel: "Cu Auto", category: "limits" },
  { id: "cursorAPI", label: "Cursor API Limit", shortLabel: "Cu API", category: "limits" },
  { id: "geminiPro", label: "Gemini Pro Limit", shortLabel: "Gm Pro", category: "limits" },
  { id: "geminiFlash", label: "Gemini Flash Limit", shortLabel: "Gm Flash", category: "limits" },
  { id: "geminiLite", label: "Gemini Lite Limit", shortLabel: "Gm Lite", category: "limits" },
  { id: "kimiWeekly", label: "Kimi Weekly Limit", shortLabel: "Km Wk", category: "limits" },
  { id: "kimi5h", label: "Kimi 5h Limit", shortLabel: "Km 5h", category: "limits" },
  { id: "kimiTotal", label: "Kimi Total Limit", shortLabel: "Km Tot", category: "limits" },
  { id: "kiroMonth", label: "Kiro Monthly Limit", shortLabel: "Kr Mo", category: "limits" },
  { id: "kiroBonus", label: "Kiro Bonus Limit", shortLabel: "Kr Bn", category: "limits" },
  { id: "copilotPremium", label: "Copilot Premium Limit", shortLabel: "Co Prem", category: "limits" },
  { id: "copilotChat", label: "Copilot Chat Limit", shortLabel: "Co Chat", category: "limits" },
  { id: "antigravityClaude", label: "Antigravity Claude Limit", shortLabel: "Ag Cl", category: "limits" },
  { id: "antigravityGPro", label: "Antigravity Gemini Pro Limit", shortLabel: "Ag GPro", category: "limits" },
  { id: "antigravityFlash", label: "Antigravity Flash Limit", shortLabel: "Ag Fl", category: "limits" },
];

export function normalizeMenuBarItems(ids, availableItems = FALLBACK_MENU_BAR_ITEMS, maxItems = 2) {
  const allowed = new Set(availableItems.map((item) => item.id));
  const seen = new Set();
  const normalized = Array.isArray(ids)
    ? ids.filter((id) => {
        if (!allowed.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
    : [];
  const fallback = normalized.length > 0 ? normalized : DEFAULT_MENU_BAR_ITEMS;
  return fallback.slice(0, Math.max(1, Number(maxItems) || 2));
}
