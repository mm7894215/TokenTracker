#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const COPY_PATH = path.join(ROOT, "dashboard", "src", "content", "copy.csv");
const I18N_ROOT = path.join(ROOT, "dashboard", "src", "content", "i18n");
const LOCALES = ["zh", "zh-TW"];
const LOCALE_FILES = ["core.json", "dashboard.json", "marketing.json"];
const REQUIRED_COLUMNS = ["key", "module", "page", "component", "slot", "text"];

// These values are deliberately language-neutral: commands, URLs, product
// and model names, protocol abbreviations, or formatting-only labels. Keep
// this key-based so a newly added English sentence cannot silently pass.
const SOURCE_IDENTICAL_KEY_ALLOWLIST = [
  /^landing[.]install[.]command$/,
  /^(landing|share)[.]meta[.]/,
  /^landing[.]cta[.]secondary$/,
  /^landing[.]v2[.]hero[.]title_line2$/,
  /^landing[.]v2[.]install[.]os_/,
  /^landing[.]v2[.]nav[.]github$/,
  /^heatmap[.]legend[.]utc$/,
  /^leaderboard[.]range(?:_loading)?$/,
  /^leaderboard[.]column[.]/,
  /^leaderboard[.]community[.]modal[.]global_spend_detail$/,
  /^leaderboard[.]community[.]modal[.]platform[.]/,
  /^dashboard[.]install[.]cmd[.]/,
  /^settings[.]menubar[.]iconStyle[.]clawd$/,
  /^settings[.]menubar[.]updates[.]footerCore$/,
  /^limits[.]provider[.]/,
  /^limits[.]label[.](?:cursor_api|zcode_glm52|zcode_glm5t|claude_opus|codex_spark_[57][hd]|gemini_(?:pro|flash|lite)|antigravity_)/,
  /^skills[.]mode[.]skillssh$/,
  /^skills[.]repo[.]placeholder$/,
  /^ipcheck[.]props[.]asn$/,
  /^ipcheck[.]security[.](?:vpn|tor)$/,
  /^shared[.]app_name$/,
  /^pet[.]character[.](?:clawd|sprout|byte|ember)$/,
];

// Generic product vocabulary should not leak through inside an otherwise
// Chinese sentence. Technical identifiers and brands (CLI, API, GitHub,
// model names, and skills.sh) are intentionally excluded from this list.
const UNLOCALIZED_UI_TERM_REGEX = /\b(?:skills?|agents?|providers?|dashboard|prompt|hook|core|app)\b/i;
const MIXED_TERM_KEY_ALLOWLIST = [
  /^skills[.]mode[.]skillssh$/,
  /^skills[.]browse[.](?:placeholder_skillssh|hint_skillssh)$/,
];

function parseCsv(raw) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
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
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      if (!row.every((cell) => String(cell).trim() === "")) rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  row.push(field);
  if (!row.every((cell) => String(cell).trim() === "")) rows.push(row);
  return rows;
}

function readCopyRegistry() {
  const rows = parseCsv(fs.readFileSync(COPY_PATH, "utf8"));
  const header = rows[0]?.map((cell) => String(cell).trim()) || [];
  const missingColumns = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missingColumns.length) {
    throw new Error(`Copy registry missing columns: ${missingColumns.join(", ")}`);
  }

  const index = Object.fromEntries(header.map((column, position) => [column, position]));
  return rows.slice(1).flatMap((cells, rowIndex) => {
    const key = String(cells[index.key] || "").trim();
    if (!key) return [];
    return [{
      key,
      module: String(cells[index.module] || "").trim(),
      page: String(cells[index.page] || "").trim(),
      text: String(cells[index.text] ?? "").trim(),
      row: rowIndex + 2,
    }];
  });
}

function readLocale(locale) {
  const values = new Map();
  const duplicateKeys = [];

  for (const filename of LOCALE_FILES) {
    const relativePath = path.join(locale, filename);
    const filePath = path.join(I18N_ROOT, relativePath);
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const fileKeys = new Set();
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*"((?:\\.|[^"\\])+)"\s*:/.exec(line);
      if (!match) continue;
      const key = JSON.parse(`"${match[1]}"`);
      if (fileKeys.has(key)) duplicateKeys.push(`${key} (${relativePath}, repeated)`);
      fileKeys.add(key);
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (values.has(key)) {
        duplicateKeys.push(`${key} (${values.get(key).file}, ${relativePath})`);
      }
      values.set(key, { value, file: relativePath });
    }
  }

  return { values, duplicateKeys };
}

function groupByPage(records) {
  const groups = new Map();
  for (const record of records) {
    const group = `${record.module}/${record.page}`;
    const values = groups.get(group) || [];
    values.push(record.key);
    groups.set(group, values);
  }
  return groups;
}

function printGrouped(label, records) {
  if (!records.length) return;
  console.error(`${label} (${records.length}):`);
  for (const [group, keys] of groupByPage(records)) {
    console.error(`- ${group}: ${keys.join(", ")}`);
  }
}

function placeholders(value) {
  return [...String(value).matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
}

function samePlaceholders(left, right) {
  return JSON.stringify(placeholders(left)) === JSON.stringify(placeholders(right));
}

function isAllowedSourceIdentical(record) {
  return SOURCE_IDENTICAL_KEY_ALLOWLIST.some((pattern) => pattern.test(record.key));
}

function hasUnlocalizedUiTerm(record, localized) {
  if (MIXED_TERM_KEY_ALLOWLIST.some((pattern) => pattern.test(record.key))) return false;
  const visibleText = String(localized)
    .replace(/\{\{\w+\}\}/g, "")
    .replace(/https?:\/\/\S+/g, "");
  return UNLOCALIZED_UI_TERM_REGEX.test(visibleText);
}

function main() {
  const showDetails = process.argv.includes("--details");
  const localeArg = process.argv.find((argument) => argument.startsWith("--locale="));
  const locales = localeArg ? [localeArg.slice("--locale=".length)] : LOCALES;
  const unknownLocales = locales.filter((locale) => !LOCALES.includes(locale));
  if (unknownLocales.length) {
    throw new Error(`Unsupported locale: ${unknownLocales.join(", ")}`);
  }
  const registry = readCopyRegistry();
  const registryByKey = new Map(registry.map((record) => [record.key, record]));
  let failed = false;

  for (const locale of locales) {
    const { values, duplicateKeys } = readLocale(locale);
    const missing = registry.filter((record) => {
      const localized = values.get(record.key)?.value;
      return typeof localized !== "string" || localized.trim() === "";
    });
    const extra = [...values.keys()].filter((key) => !registryByKey.has(key));
    const placeholderMismatches = registry.filter((record) => {
      const localized = values.get(record.key)?.value;
      return typeof localized === "string" && !samePlaceholders(record.text, localized);
    });
    const identicalText = registry.filter((record) => {
      const localized = values.get(record.key)?.value;
      const fixedText = record.text.replace(/\{\{\w+\}\}/g, "");
      return (
        localized === record.text &&
        /[A-Za-z]{2,}/.test(fixedText) &&
        !isAllowedSourceIdentical(record)
      );
    });
    const mixedUnlocalizedText = registry.filter((record) => {
      const localized = values.get(record.key)?.value;
      return typeof localized === "string" && hasUnlocalizedUiTerm(record, localized);
    });

    console.log(
      `${locale}: ${registry.length - missing.length}/${registry.length} copy keys localized ` +
        `(${((registry.length - missing.length) / registry.length * 100).toFixed(1)}%).`,
    );

    if (duplicateKeys.length) {
      failed = true;
      console.error(`${locale} duplicate keys (${duplicateKeys.length}):`);
      duplicateKeys.forEach((entry) => console.error(`- ${entry}`));
    }
    if (extra.length) {
      failed = true;
      console.error(`${locale} keys absent from copy.csv (${extra.length}):`);
      extra.forEach((key) => console.error(`- ${key}`));
    }
    if (missing.length) {
      failed = true;
      printGrouped(`${locale} missing translations`, missing);
      if (showDetails) {
        console.error(`${locale} source text:`);
        missing.forEach((record) => console.error(`- ${record.key} = ${JSON.stringify(record.text)}`));
      }
    }
    if (placeholderMismatches.length) {
      failed = true;
      console.error(`${locale} placeholder mismatches (${placeholderMismatches.length}):`);
      placeholderMismatches.forEach((record) => {
        const localized = values.get(record.key).value;
        console.error(
          `- ${record.key}: source=${JSON.stringify(placeholders(record.text))} ` +
            `localized=${JSON.stringify(placeholders(localized))}`,
        );
      });
    }
    if (identicalText.length) {
      failed = true;
      console.error(`${locale} source-identical UI text (${identicalText.length}):`);
      identicalText.forEach((record) => console.error(`- ${record.key} = ${JSON.stringify(record.text)}`));
    }
    if (mixedUnlocalizedText.length) {
      failed = true;
      console.error(`${locale} mixed untranslated UI terms (${mixedUnlocalizedText.length}):`);
      mixedUnlocalizedText.forEach((record) => {
        console.error(`- ${record.key} = ${JSON.stringify(values.get(record.key).value)}`);
      });
    }
  }

  if (failed) process.exit(1);
  console.log("Chinese locale coverage ok.");
}

main();
