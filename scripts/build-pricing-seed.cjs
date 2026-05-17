#!/usr/bin/env node
// Fetch the live LiteLLM pricing JSON and write a slimmed snapshot used as the
// day-1 offline fallback. Runs from `npm prepublishOnly`; can also be invoked
// manually: `node scripts/build-pricing-seed.cjs`.

const fs = require("node:fs");
const path = require("node:path");

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OUT_PATH = path.resolve(__dirname, "../src/lib/pricing/seed-snapshot.json");
const TIMEOUT_MS = 30_000;

const KEEP_FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
];

async function main() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let raw;
  try {
    const res = await fetch(LITELLM_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    raw = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const slim = {};
  let kept = 0;
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const out = {};
    let hasAny = false;
    for (const f of KEEP_FIELDS) {
      const v = entry[f];
      if (typeof v === "number" && Number.isFinite(v)) {
        out[f] = v;
        hasAny = true;
      }
    }
    if (hasAny) {
      slim[name] = out;
      kept++;
    }
  }

  const meta = {
    _meta: {
      source: LITELLM_URL,
      generated_at: new Date().toISOString(),
      kept_models: kept,
    },
  };
  const final = { ...meta, ...slim };

  fs.writeFileSync(OUT_PATH, JSON.stringify(final) + "\n");
  const stat = fs.statSync(OUT_PATH);
  process.stdout.write(
    `[build-pricing-seed] wrote ${OUT_PATH} (${kept} models, ${stat.size} bytes)\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[build-pricing-seed] failed: ${err?.message || err}\n`);
  process.exitCode = 1;
});
