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

test("web-provider command persists, lists and removes custom bridges", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-web-provider-cli-"));
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
    const empty = await runCli(["web-provider", "list", "--json"], env);
    expect(empty.exitCode).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual([]);

    const add = await runCli([
      "web-provider", "add",
      "--id", "claude-web",
      "--label", "Claude Web",
      "--bridge-url", "http://127.0.0.1:8788/",
      "--model", "sonnet",
      "--model", "opus",
    ], env);
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain("claude-web");
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as {
      webProviders?: Array<{ id: string; label?: string; bridgeUrl: string; models: Array<{ id: string }> }>;
    };
    expect(persisted.webProviders?.[0]).toMatchObject({
      id: "claude-web",
      label: "Claude Web",
      bridgeUrl: "http://127.0.0.1:8788",
      models: [{ id: "sonnet" }, { id: "opus" }],
    });

    const listed = await runCli(["web-provider", "list", "--json"], env);
    expect(listed.exitCode).toBe(0);
    const providers = JSON.parse(listed.stdout) as Array<{ id: string; models: Array<{ id: string }> }>;
    expect(providers).toHaveLength(1);
    expect(providers[0]?.models.map(model => model.id)).toEqual(["sonnet", "opus"]);

    const reserved = await runCli([
      "web-provider", "add",
      "--id", "chatgpt-web",
      "--bridge-url", "http://127.0.0.1:8788",
      "--model", "sonnet",
    ], env);
    expect(reserved.exitCode).toBe(1);
    expect(reserved.stderr).toContain("reserved");

    const duplicate = await runCli([
      "web-provider", "add",
      "--id", "gemini-web",
      "--bridge-url", "http://127.0.0.1:8789",
      "--model", "pro",
      "--model", "pro",
    ], env);
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr).toContain("Duplicate");

    const missingUrl = await runCli(["web-provider", "add", "--id", "gemini-web", "--model", "pro"], env);
    expect(missingUrl.exitCode).toBe(1);
    expect(missingUrl.stderr).toContain("requires --bridge-url");

    const remove = await runCli(["web-provider", "remove", "claude-web"], env);
    expect(remove.exitCode).toBe(0);
    expect((JSON.parse(readFileSync(configPath, "utf8")) as { webProviders?: unknown }).webProviders)
      .toBeUndefined();

    const removeMissing = await runCli(["web-provider", "remove", "claude-web"], env);
    expect(removeMissing.exitCode).toBe(1);
    expect(removeMissing.stderr).toContain("Unknown web provider");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
