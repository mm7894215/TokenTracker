// patch-api.js — Build-time patch for dashboard/src/lib/api.ts
// Adds auth headers to fetchLocalJson so the nginx→InsForge proxy works.
const fs = require("fs");
const file = "src/lib/api.ts";
let code = fs.readFileSync(file, "utf8");

// 1. Add import for InsForge client
code = code.replace(
  'import { getInsforgeRemoteUrl, getInsforgeAnonKey } from "./insforge-config";',
  'import { getInsforgeRemoteUrl, getInsforgeAnonKey, getOrCreateInsforgeClient } from "./insforge-config";'
);

// 2. Replace fetchLocalJson to include auth headers
code = code.replace(
  `  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    cache: "no-store",
    ...options,
  });`,
  `  const _headers: Record<string, string> = { Accept: "application/json" };
  const _ak = getInsforgeAnonKey();
  if (_ak) _headers.apikey = _ak;
  try {
    const _c = getOrCreateInsforgeClient();
    if (_c) { const _t = await _c.getAccessToken(); if (_t) _headers.Authorization = "Bearer " + _t; }
  } catch {}
  const response = await fetch(url.toString(), {
    headers: _headers,
    cache: "no-store",
    ...options,
  });`
);

fs.writeFileSync(file, code);
console.log("Patched api.ts with auth headers");
