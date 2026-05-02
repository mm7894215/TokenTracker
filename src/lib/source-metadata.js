const ACCOUNT_LEVEL_SOURCES = new Set(["cursor"]);

function normalizeSource(value) {
  return String(value || "").trim().toLowerCase();
}

function getSourceScope(source) {
  return ACCOUNT_LEVEL_SOURCES.has(normalizeSource(source)) ? "account" : "local";
}

function isAccountLevelSource(source) {
  return getSourceScope(source) === "account";
}

function normalizeUsageScope(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "all" || raw === "raw" ? "all" : "personal";
}

function filterRowsByUsageScope(rows, scope = "personal") {
  const normalizedScope = normalizeUsageScope(scope);
  if (normalizedScope === "all") return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter((row) => !isAccountLevelSource(row?.source));
}

function listExcludedSources(rows, scope = "personal") {
  const normalizedScope = normalizeUsageScope(scope);
  if (normalizedScope === "all") return [];
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const source = normalizeSource(row?.source);
    if (!source || seen.has(source) || !isAccountLevelSource(source)) continue;
    seen.add(source);
    out.push({ source, source_scope: getSourceScope(source), reason: "account_level_source" });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source));
}

module.exports = {
  getSourceScope,
  isAccountLevelSource,
  normalizeUsageScope,
  filterRowsByUsageScope,
  listExcludedSources,
};
