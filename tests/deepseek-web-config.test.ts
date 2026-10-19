import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, saveConfig } from "../src/config";

function withHome(run: (home: string, configPath: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-deepseek-config-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  try {
    mkdirSync(home, { recursive: true });
    run(home, join(home, "config.json"));
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

function configWith(value: unknown): Record<string, unknown> {
  const config = defaultConfig("browser-only") as unknown as Record<string, unknown>;
  if (value !== undefined) config.deepseekWebBridgeUrl = value;
  return config;
}

test("loadConfig validates, normalizes and preserves the DeepSeek bridge URL", () => {
  withHome((_home, configPath) => {
    writeFileSync(configPath, JSON.stringify(configWith("http://127.0.0.1:8787/")));
    expect(loadConfig().deepseekWebBridgeUrl).toBe("http://127.0.0.1:8787");

    writeFileSync(configPath, JSON.stringify(configWith(undefined)));
    expect(loadConfig().deepseekWebBridgeUrl).toBeUndefined();
  });
});

test("loadConfig rejects malformed DeepSeek bridge URLs", () => {
  withHome((_home, configPath) => {
    writeFileSync(configPath, JSON.stringify(configWith("not-a-url")));
    expect(() => loadConfig()).toThrow(/Invalid deepseekWebBridgeUrl/);

    writeFileSync(configPath, JSON.stringify(configWith("ftp://bridge.local")));
    expect(() => loadConfig()).toThrow(/http\(s\) URL/);

    writeFileSync(configPath, JSON.stringify(configWith("   ")));
    expect(() => loadConfig()).toThrow(/Invalid deepseekWebBridgeUrl/);
  });
});

test("saveConfig persists the DeepSeek bridge URL for the launcher-owned daemon", () => {
  withHome((_home, configPath) => {
    const config = defaultConfig("browser-only");
    config.deepseekWebBridgeUrl = "http://127.0.0.1:9999";
    saveConfig(config);
    expect(JSON.parse(readFileSync(configPath, "utf8")).deepseekWebBridgeUrl)
      .toBe("http://127.0.0.1:9999");
    expect(loadConfig().deepseekWebBridgeUrl).toBe("http://127.0.0.1:9999");
  });
});
