/**
 * Browser-level end-to-end check for the launcher renderer.
 *
 * Usage:
 *   1. Start the DEV launcher:  cd launcher && bun run dev
 *   2. Find its CDP port:       <dev-home>/launcher/logs/launcher.jsonl -> launcher.window_created.cdpPort
 *   3. Run:                     bun run e2e:launcher --port <cdpPort>
 *
 * The script attaches over CDP (Playwright), walks every launcher page, flips every
 * launcher language, runs the doctor, reloads to prove persistence, and fails on
 * renderer errors or empty pages. It never sends a ChatGPT prompt and never types
 * credentials; the embedded ChatGPT surface is only checked for a loaded target.
 */
import { chromium, type Page } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyFor } from "../launcher/src/i18n";
import type { Language } from "../launcher/src/types";

const english = copyFor("en");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const fail = (name: string, detail: string) => checks.push({ name, ok: false, detail });
const pass = (name: string, detail = "") => checks.push({ name, ok: true, detail });

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number(argValue("--port") ?? process.env.LAUNCHER_CDP_PORT ?? "0");
if (!Number.isInteger(port) || port <= 0) throw new Error("Pass the launcher CDP port with --port <port>");

const outDir = argValue("--out") ?? join(process.cwd(), ".e2e-launcher");
mkdirSync(outDir, { recursive: true });

const BENIGN_CONSOLE = [
  /Content Security Policy directive 'frame-ancestors'/,
  /Download the React DevTools/,
  /\[vite\] connect/,
];

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pages = browser.contexts().flatMap((context) => context.pages());
const launcherPage = pages.find((page) => /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(page.url()));
if (!launcherPage) {
  await browser.close();
  throw new Error(`launcher renderer page not found among: ${pages.map((page) => page.url()).join(", ")}`);
}
// Bind after the guard so nested helpers keep the narrowed `Page` type.
const launcher: Page = launcherPage;

const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const record = (page: Page) => {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!BENIGN_CONSOLE.some((pattern) => pattern.test(text))) consoleErrors.push(text);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
};
// Only the launcher renderer is ours: the embedded ChatGPT page logs its own CSP
// violations and third-party errors, which are not launcher regressions.
record(launcher);

const bodyText = () => launcher.evaluate(() => document.body.innerText ?? "");
const hasCrashText = (value: string) => /something went wrong|unhandled|application error|white screen/i.test(value);
const home = () => new URL("/", launcher.url()).toString();

async function currentLanguage(): Promise<Language> {
  const value = await launcher.evaluate(() => document.querySelector("[data-language]")?.getAttribute("data-language"));
  return (value ?? "en") as Language;
}

async function selectLanguage(option: string) {
  const trigger = launcher.locator(".language-menu-trigger").first();
  await trigger.waitFor({ state: "visible", timeout: 10_000 });
  await trigger.click();
  await launcher.waitForTimeout(350);
  const entry = launcher.locator('[role="listbox"] [role="option"]').filter({ hasText: option }).first();
  if (await entry.count() === 0) throw new Error(`option ${option} not found in language menu`);
  await entry.click();
  await launcher.waitForTimeout(700);
}

// The launcher persists the last language, so a previous run may leave it localized.
// Normalize to English first; every assertion below then uses the English copy.
async function ensureEnglish() {
  const language = await currentLanguage();
  if (language === "en") return;
  await launcher.getByRole("button", { name: copyFor(language).settings, exact: true }).first().click();
  await launcher.waitForTimeout(500);
  await selectLanguage("English");
  await launcher.goto(home(), { waitUntil: "domcontentloaded" });
  await launcher.waitForTimeout(2_000);
}

async function visit(name: string, expected: string[]) {
  const nav = launcher.getByRole("button", { name, exact: true });
  if (await nav.count() === 0) return fail(`page:${name}`, "navigation button missing");
  await nav.first().click();
  // Page transitions animate; wait for the destination content instead of a fixed delay.
  await launcher.waitForFunction(
    (texts: string[]) => texts.some((text) => (document.body.innerText ?? "").includes(text)),
    expected,
    { timeout: 10_000 },
  ).catch(() => {});
  await launcher.waitForTimeout(900);
  const body = await bodyText();
  const matched = expected.find((text) => body.includes(text));
  if (!launcher.url().startsWith("http://127.0.0.1:")) fail(`page:${name}`, `renderer left its origin: ${launcher.url()}`);
  else if (hasCrashText(body)) fail(`page:${name}`, "renderer showed a crash/error screen");
  else if (!matched) fail(`page:${name}`, `none of ${JSON.stringify(expected)} found`);
  else pass(`page:${name}`, matched);
  await launcher.screenshot({ path: join(outDir, `page-${name.toLowerCase()}.png`), fullPage: true }).catch(() => {});
}

// Normalize the persisted language, then walk every launcher page.
await ensureEnglish();

// 1. Every launcher page renders its own content.
// The Browser page shows the sign-in card, the embedded-surface toolbar, or an
// in-progress identity-provider sign-in surface.
await visit("Browser", [
  "Sign in to ChatGPT",
  "chatgpt.com",
  "Open ChatGPT",
  "Hide ChatGPT",
  "Show ChatGPT",
  "100%",
]);
await visit("Setup", ["Set up the isolated DEV profile"]);
await visit("MCP", ["Simulated tools over MCP"]);
await visit("Activity", ["Runtime activity"]);
await visit("Limits", ["Public ChatGPT limits"]);
await visit("Settings", ["DEV profile settings"]);

// 2. Language round-trip through every supported locale.
const locales = [
  { option: "日本語", marker: "ブラウザ" },
  { option: "한국어", marker: "브라우저" },
  { option: "简体中文", marker: "浏览器" },
  { option: "繁體中文", marker: "瀏覽器" },
  { option: "Português (Brasil)", marker: "Navegador" },
  { option: "English", marker: "Browser" },
];

for (const locale of locales) {
  try {
    await selectLanguage(locale.option);
    const body = await bodyText();
    if (body.includes(locale.marker)) pass(`language:${locale.option}`, `nav marker ${locale.marker}`);
    else fail(`language:${locale.option}`, `marker ${JSON.stringify(locale.marker)} missing after switch`);
  } catch (error) {
    fail(`language:${locale.option}`, error instanceof Error ? error.message : String(error));
    await launcher.locator(".language-menu-scrim").click({ timeout: 2_000 }).catch(() => {});
  }
}
await launcher.screenshot({ path: join(outDir, "language-english.png"), fullPage: true }).catch(() => {});

// 3. Reload must restore persisted state instead of showing a blank window.
await launcher.goto(home(), { waitUntil: "domcontentloaded" });
await launcher.waitForTimeout(2_500);
const afterReload = await bodyText();
if (!hasCrashText(afterReload) && afterReload.includes(english.settings)) pass("reload:persistence", "launcher restored after reload");
else fail("reload:persistence", "launcher did not render after reload");

// 4. Doctor runs through the real IPC/runtime path and renders its report.
await launcher.getByRole("button", { name: english.settings, exact: true }).first().click();
await launcher.waitForTimeout(500);
try {
  await launcher.locator("button.diagnostic-row").filter({ hasText: english.runDoctor }).first().click({ timeout: 5_000 });
  await launcher.locator(".doctor-summary").first().waitFor({ timeout: 90_000 });
  const report = await launcher.locator(".doctor-summary").first().innerText();
  pass("doctor:report", report.replace(/\s+/g, " ").slice(0, 120));
} catch (error) {
  fail("doctor:report", error instanceof Error ? error.message.slice(0, 160) : String(error));
}
await launcher.screenshot({ path: join(outDir, "doctor.png"), fullPage: true }).catch(() => {});

// 5. The embedded ChatGPT surface is a real, loaded page target.
const embedded = browser.contexts()
  .flatMap((context) => context.pages())
  .filter((page) => page !== launcher)
  .filter((page) => !page.url().startsWith("http://127.0.0.1:"));
if (embedded.length > 0) {
  const summary: string[] = [];
  for (const page of embedded) {
    const url = page.url();
    const title = await page.title().catch(() => "");
    summary.push(`${new URL(url).host}${title ? ` (${title.slice(0, 32)})` : ""}`);
  }
  pass("browser:embedded-surface", summary.join(", "));
} else {
  fail("browser:embedded-surface", "no embedded ChatGPT/browser target found");
}

// 6. Renderer health across the whole walk.
if (consoleErrors.length === 0) pass("console:errors", "no renderer console errors");
else fail("console:errors", consoleErrors.slice(0, 5).join(" | "));
if (pageErrors.length === 0) pass("page:errors", "no uncaught page errors");
else fail("page:errors", pageErrors.slice(0, 5).join(" | "));

await launcher.screenshot({ path: join(outDir, "final.png"), fullPage: true }).catch(() => {});
await browser.close();

const result = {
  port,
  at: new Date().toISOString(),
  passed: checks.filter((check) => check.ok).length,
  failed: checks.filter((check) => !check.ok).length,
  checks,
};
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
for (const check of checks) {
  process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? ` — ${check.detail}` : ""}\n`);
}
process.stdout.write(`\nE2E_LAUNCHER ${result.failed === 0 ? "OK" : "FAILED"} (${result.passed} passed, ${result.failed} failed)\n`);
process.exitCode = result.failed === 0 ? 0 : 1;
