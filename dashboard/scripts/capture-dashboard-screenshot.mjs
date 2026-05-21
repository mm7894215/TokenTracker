import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

function readArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return fallback;
  return value;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

const url =
  readArg("--url", process.env.TOKENTRACKER_SCREENSHOT_URL) || "http://localhost:5173/?screenshot=1";
const out =
  readArg("--out", path.resolve("docs", "screenshots", "dashboard-screenshot.png")) ||
  path.resolve("docs", "screenshots", "dashboard-screenshot.png");
const width = toNumber(readArg("--width", "1512"), 1512);
const height = toNumber(readArg("--height", "997"), 997);
const dpr = toNumber(readArg("--dpr", "2"), 2);
const waitMs = toNumber(readArg("--wait", "1200"), 1200);
const fullPage = !hasFlag("--no-full-page");

const resolvedOut = path.isAbsolute(out) ? out : path.resolve(out);

async function run() {
  await fs.mkdir(path.dirname(resolvedOut), { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: dpr,
  });

  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.addStyleTag({
      content: `
        html, body { background: #050505 !important; }
        [data-screenshot-exclude="true"] { display: none !important; }
      `,
    });
    await page.evaluate(() => {
      document.documentElement.classList.add("screenshot-capture");
      document.body?.classList.add("screenshot-capture");
    });
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    await page.screenshot({
      path: resolvedOut,
      fullPage,
      animations: "disabled",
    });

    console.log(`Saved screenshot: ${resolvedOut}`);
  } finally {
    await page.close();
    await browser.close();
  }
}

run().catch((error) => {
  console.error("Failed to capture screenshot", error);
  process.exitCode = 1;
});
