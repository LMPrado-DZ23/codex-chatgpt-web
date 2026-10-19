import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config";

setDefaultTimeout(30_000);

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("deepseek-web command persists, reports and clears the bridge URL", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-deepseek-cli-"));
  const configPath = join(home, "config.json");
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  try {
    writeFileSync(configPath, JSON.stringify(defaultConfig("browser-only")));
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
  }
  const env = { ...process.env, CODEX_CHATGPT_WEB_HOME: home };
  try {
    const before = await runCli(["deepseek-web", "status", "--json"], env);
    expect(before.exitCode).toBe(0);
    expect(JSON.parse(before.stdout)).toEqual({ configured: false, bridgeUrl: null });

    const set = await runCli(["deepseek-web", "set", "--bridge-url", "http://127.0.0.1:8787/"], env);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain("http://127.0.0.1:8787");
    expect(JSON.parse(readFileSync(configPath, "utf8")).deepseekWebBridgeUrl)
      .toBe("http://127.0.0.1:8787");

    const after = await runCli(["deepseek-web", "status", "--json"], env);
    expect(after.exitCode).toBe(0);
    expect(JSON.parse(after.stdout)).toEqual({ configured: true, bridgeUrl: "http://127.0.0.1:8787" });

    const invalid = await runCli(["deepseek-web", "set", "--bridge-url", "ftp://bridge.local"], env);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("http(s) URL");

    const missing = await runCli(["deepseek-web", "set"], env);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("requires --bridge-url");

    const clear = await runCli(["deepseek-web", "clear"], env);
    expect(clear.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8")).deepseekWebBridgeUrl).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
