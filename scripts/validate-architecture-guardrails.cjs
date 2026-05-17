const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CLIENT_DIR_NAMES = ["src", "dashboard"];
const SQL_EXTENSIONS = new Set([".sql"]);
const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".code",
  "dist",
  "build",
  ".tmp",
  "archive",
  "edge-patches",
]);

const CLIENT_IMPORT_PATTERNS = [];
const CLIENT_INTERNAL_PATTERNS = [];
const SERVICE_ROLE_PATTERNS = ["SERVICE_ROLE_KEY", "service_role_key"];
const SDK_ALLOWLIST = new Set([]);

const SDK_PACKAGE = null;

function isSdkAllowlisted(file, root) {
  const relativePath = path.normalize(path.relative(root, file));
  return SDK_ALLOWLIST.has(relativePath);
}

function walkFiles(dir, options = {}, results = []) {
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, options, results);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (options.extensions && !options.extensions.has(ext)) continue;
    results.push(fullPath);
  }
  return results;
}

function stripSqlComments(line, state) {
  let i = 0;
  let out = "";
  while (i < line.length) {
    if (state.inBlock) {
      const end = line.indexOf("*/", i);
      if (end === -1) return "";
      i = end + 2;
      state.inBlock = false;
      continue;
    }
    const blockStart = line.indexOf("/*", i);
    const lineStart = line.indexOf("--", i);
    if (lineStart !== -1 && (blockStart === -1 || lineStart < blockStart)) {
      out += line.slice(i, lineStart);
      return out;
    }
    if (blockStart !== -1) {
      out += line.slice(i, blockStart);
      i = blockStart + 2;
      state.inBlock = true;
      continue;
    }
    out += line.slice(i);
    return out;
  }
  return out;
}

function scanClientFiles(root, errors) {
  const clientDirs = CLIENT_DIR_NAMES.map((dir) => path.join(root, dir));
  const files = clientDirs.flatMap((dir) => walkFiles(dir, { extensions: CODE_EXTENSIONS }));
  for (const file of files) {
    const sdkAllowed = isSdkAllowlisted(file, root);
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r\n|\r|\n/);
    lines.forEach((line, index) => {
      CLIENT_IMPORT_PATTERNS.forEach((pattern) => {
        if (line.includes(pattern)) {
          errors.push({
            code: "CLIENT_IMPORT",
            file,
            line: index + 1,
            message: `Client code must not reference ${pattern}.`,
          });
        }
      });
      CLIENT_INTERNAL_PATTERNS.forEach((pattern) => {
        if (line.includes(pattern)) {
          errors.push({
            code: "CLIENT_INTERNAL_URL",
            file,
            line: index + 1,
            message: `Client code must not reference ${pattern}.`,
          });
        }
      });
      SERVICE_ROLE_PATTERNS.forEach((pattern) => {
        if (line.includes(pattern)) {
          errors.push({
            code: "SERVICE_ROLE_KEY",
            file,
            line: index + 1,
            message: "Client code must not use service role credentials.",
          });
        }
      });
      if (SDK_PACKAGE && line.includes(SDK_PACKAGE) && !sdkAllowed) {
        errors.push({
          code: "CLIENT_SDK_IMPORT",
          file,
          line: index + 1,
          message: `Client code may only import ${SDK_PACKAGE} from approved wrapper files.`,
        });
      }
    });
  }
}

function scanSqlFiles(root, errors) {
  const files = walkFiles(root, { extensions: SQL_EXTENSIONS });
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r\n|\r|\n/);
    const state = { inBlock: false };
    lines.forEach((line, index) => {
      const stripped = stripSqlComments(line, state);
      if (!stripped) return;
      const lower = stripped.toLowerCase();
      if (/\bmoney\b/i.test(lower)) {
        errors.push({
          code: "SQL_MONEY",
          file,
          line: index + 1,
          message: "Avoid MONEY type; use numeric instead.",
        });
      }
      const hasTimestamp = /\btimestamp\b/i.test(lower);
      const hasTimestampWithTimeZone = /\btimestamp\s+with\s+time\s+zone\b/i.test(lower);
      const hasTimestampCastAtTimeZone =
        /::\s*timestamp\s+at\s+time\s+zone\b/i.test(lower) ||
        /\bcast\s*\([^)]*\bas\s+timestamp\s*\)\s+at\s+time\s+zone\b/i.test(lower);
      if (hasTimestamp && !hasTimestampWithTimeZone && !hasTimestampCastAtTimeZone) {
        errors.push({
          code: "SQL_TIMESTAMP",
          file,
          line: index + 1,
          message: "Avoid TIMESTAMP without time zone; use timestamptz instead.",
        });
      }
    });
  }
}

function runGuardrails({ root = ROOT } = {}) {
  const errors = [];
  const warnings = [];

  scanClientFiles(root, errors);
  scanSqlFiles(root, errors);

  return { errors, warnings };
}

function formatIssues(label, issues, root) {
  if (!issues.length) return;
  console.error(label);
  issues.forEach((issue) => {
    const rel = path.relative(root, issue.file);
    console.error(`- [${issue.code}] ${rel}:${issue.line} ${issue.message}`);
  });
}

function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : ROOT;
  const { errors, warnings } = runGuardrails({ root });

  if (warnings.length) {
    formatIssues("Guardrail warnings:", warnings, root);
  }

  if (errors.length) {
    formatIssues("Guardrail errors:", errors, root);
    process.exit(1);
  }

  console.log("Guardrails ok: no violations found.");
}

module.exports = { runGuardrails };

if (require.main === module) {
  main();
}
