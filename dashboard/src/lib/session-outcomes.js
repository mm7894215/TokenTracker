const STORAGE_KEY = "tokentracker_session_outcomes_v1";

export const SESSION_OUTCOME_OPTIONS = [
  "productive",
  "exploratory",
  "blocked",
  "wasted",
];

export function getSessionOutcomes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function setSessionOutcome(id, outcome) {
  const next = { ...getSessionOutcomes() };
  if (!outcome) delete next[id];
  else next[id] = outcome;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function buildOutcomeCounts(entries, outcomes) {
  const counts = { all: Array.isArray(entries) ? entries.length : 0 };
  for (const option of SESSION_OUTCOME_OPTIONS) counts[option] = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const outcome = outcomes?.[entry.id];
    if (outcome && counts[outcome] != null) counts[outcome] += 1;
  }
  return counts;
}
