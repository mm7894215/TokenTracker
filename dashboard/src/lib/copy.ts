import copyRaw from "../content/copy.csv?raw";
import zhCore from "../content/i18n/zh/core.json";
import zhDashboard from "../content/i18n/zh/dashboard.json";
import zhMarketing from "../content/i18n/zh/marketing.json";
import {
  getInitialLocalePreference,
  normalizeResolvedLocale,
  resolvePreferredLocale,
  ZH_CN_LOCALE,
} from "./locale";

const REQUIRED_COLUMNS = ["key", "module", "page", "component", "slot", "text"];
const LOCALE_REGISTRIES: Record<string, TranslationRegistry> = {
  [ZH_CN_LOCALE]: {
    ...zhCore,
    ...zhDashboard,
    ...zhMarketing,
  },
};

type AnyRecord = Record<string, any>;
type TranslationRegistry = Record<string, string>;

let cachedRegistry: any = null;
let currentLocale = resolvePreferredLocale(getInitialLocalePreference());

function parseCsv(raw: any) {
  const rows: any[] = [];
  let row: any[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = raw[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      field = "";
      if (!row.every((cell) => cell.trim() === "")) rows.push(row);
      row = [];
      continue;
    }

    if (ch === "\r") continue;
    field += ch;
  }

  row.push(field);
  if (!row.every((cell) => cell.trim() === "")) rows.push(row);
  return rows;
}

function buildRegistry(raw: any) {
  const rows = parseCsv(raw || "");
  if (!rows.length) return { map: new Map(), rows: [] };

  const header = rows[0].map((cell: any) => String(cell).trim());
  const missing = REQUIRED_COLUMNS.filter((col) => !header.includes(col));
  if (missing.length) {
    if (import.meta?.env?.DEV) {
      console.error("Copy registry missing columns:", missing.join(", "));
    }
    return { map: new Map(), rows: [] };
  }

  const idx = Object.fromEntries(header.map((col: any, index: number) => [col, index]));
  const entries: any[] = [];
  const map = new Map();

  rows.slice(1).forEach((cells: any[], rowIndex: number) => {
    const record = {
      key: String(cells[idx.key] || "").trim(),
      module: String(cells[idx.module] || "").trim(),
      page: String(cells[idx.page] || "").trim(),
      component: String(cells[idx.component] || "").trim(),
      slot: String(cells[idx.slot] || "").trim(),
      text: String(cells[idx.text] ?? "").trim(),
    };

    if (!record.key) return;
    if (map.has(record.key) && import.meta?.env?.DEV) {
      console.warn(`Duplicate copy key: ${record.key} (row ${rowIndex + 2})`);
    }

    map.set(record.key, record);
    entries.push(record);
  });

  return { map, rows: entries };
}

function getRegistry() {
  if (!cachedRegistry) cachedRegistry = buildRegistry(copyRaw);
  return cachedRegistry;
}

function getLocaleRegistry() {
  return (LOCALE_REGISTRIES[currentLocale] || {}) as TranslationRegistry;
}

function getTranslatedText(key: any) {
  const value = getLocaleRegistry()[String(key)];
  return typeof value === "string" && value.trim() ? value : null;
}

function interpolate(text: any, params?: AnyRecord) {
  if (!params) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (match: string, key: string) => {
    if (params[key] == null) return match;
    return String(params[key]);
  });
}

function normalizeText(text: any) {
  return String(text).replace(/\\n/g, "\n");
}

function resolveCopyValue(record: any, key: any) {
  return getTranslatedText(key) || record?.text || key;
}

export function setCopyLocale(locale: any) {
  currentLocale = normalizeResolvedLocale(locale);
}

export function copy(key: any, params?: AnyRecord) {
  const registry = getRegistry();
  const record = registry.map.get(key);
  if (!record && import.meta?.env?.DEV) {
    console.warn(`Missing copy key: ${key}`);
  }
  return interpolate(normalizeText(resolveCopyValue(record, key)), params);
}

export function getCopyRegistry() {
  return getRegistry();
}
