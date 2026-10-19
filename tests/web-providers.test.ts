import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, type WebProviderConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { responseRequest } from "../src/server";
import { configuredWebProviders, webProviderForModelId } from "../src/web-providers";

function nativeCatalog(): Record<string, unknown> {
  return {
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "5.6 Sol",
      priority: 2,
      visibility: "list",
      supported_in_api: true,
      multi_agent_version: "v2",
      supported_reasoning_levels: [{ effort: "medium", description: "Medium native" }],
      tool_mode: "code_mode_only",
      context_window: 300_000,
      max_context_window: 320_000,
      auto_compact_token_limit: 270_000,
    }],
  };
}

function claudeProvider(overrides: Partial<WebProviderConfig> = {}): WebProviderConfig {
  return {
    id: "claude-web",
    label: "Claude Web",
    bridgeUrl: "http://127.0.0.1:8788",
    models: [{ id: "sonnet", displayName: "Claude Sonnet" }],
    ...overrides,
  };
}

function withConfig(raw: Record<string, unknown>, run: () => void): void {
  const home = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-web-provider-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify(raw));
    run();
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

function baseConfig(): Record<string, unknown> {
  return defaultConfig("browser-only") as unknown as Record<string, unknown>;
}

test("lists the built-in DeepSeek provider and any configured custom bridge", () => {
  const config = defaultConfig("browser-only");
  config.deepseekWebBridgeUrl = "http://127.0.0.1:8787";
  config.webProviders = [claudeProvider()];
  const providers = configuredWebProviders(config, {});
  expect(providers.map(provider => provider.id)).toEqual(["deepseek-web", "claude-web"]);
  const claude = providers.find(provider => provider.id === "claude-web")!;
  expect(claude.modelPrefix).toBe("claude-web/");
  expect(claude.models[0]).toMatchObject({
    slug: "claude-web/sonnet",
    displayName: "Claude Sonnet",
    backendModel: "sonnet",
    contextWindow: 131_072,
  });
  expect(claude.models[0]!.autoCompactTokenLimit).toBeLessThan(claude.models[0]!.contextWindow);
  expect(webProviderForModelId(config, "claude-web/sonnet", {})?.provider.bridgeUrl)
    .toBe("http://127.0.0.1:8788");
  expect(webProviderForModelId(config, "claude-web/unknown", {})).toBeUndefined();
});

test("adds custom provider rows to the Codex model catalog", () => {
  const config = defaultConfig("full");
  config.webProviders = [claudeProvider()];
  const catalog = augmentNativeModelCatalog(nativeCatalog(), config);
  const models = catalog.models as Array<Record<string, unknown> & { slug: string }>;
  const custom = models.filter(model => model.slug.startsWith("claude-web/"));
  expect(custom.map(model => model.slug)).toEqual(["claude-web/sonnet"]);
  expect(custom[0]).toMatchObject({
    display_name: "Claude Sonnet",
    visibility: "list",
    supported_in_api: true,
    input_modalities: ["text"],
    context_window: 131_072,
    max_context_window: 131_072,
    default_reasoning_level: "medium",
  });
});

test("validates custom web providers and rejects reserved or malformed entries", () => {
  withConfig({ ...baseConfig(), webProviders: [claudeProvider({ bridgeUrl: "http://127.0.0.1:8788/" })] }, () => {
    const config = loadConfig();
    expect(config.webProviders?.[0]?.bridgeUrl).toBe("http://127.0.0.1:8788");
    expect(config.webProviders?.[0]?.models[0]?.autoCompactTokenLimit).toBe(117_964);
  });

  const invalid: Array<[string, Partial<WebProviderConfig> | Record<string, unknown>]> = [
    ["reserved id", { id: "chatgpt-web" }],
    ["reserved deepseek id", { id: "deepseek-web" }],
    ["upper-case id", { id: "Claude Web" }],
    ["missing bridge", { bridgeUrl: "" }],
    ["non-http bridge", { bridgeUrl: "ftp://bridge.local" }],
    ["empty models", { models: [] }],
    ["bad model id", { models: [{ id: "Sonnet Model" }] }],
    ["invalid context", { models: [{ id: "sonnet", contextWindow: 0 }] }],
    ["compact beyond context", { models: [{ id: "sonnet", contextWindow: 100, autoCompactTokenLimit: 100 }] }],
  ];
  for (const [label, overrides] of invalid) {
    withConfig({ ...baseConfig(), webProviders: [{ ...claudeProvider(), ...overrides }] }, () => {
      expect(() => loadConfig()).toThrow();
      void label;
    });
  }

  withConfig({ ...baseConfig(), webProviders: [claudeProvider(), claudeProvider({ label: "Dup" })] }, () => {
    expect(() => loadConfig()).toThrow(/Duplicate webProviders id/);
  });
});

function chunk(content: string) {
  return {
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(text))}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function request(model: string): Request {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: "hello", stream: false }),
  });
}

test("routes a custom provider model to its own bridge", async () => {
  const claudeBridge = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => sseResponse("olá do Claude Web") });
  try {
    const config = defaultConfig("browser-only");
    config.webProviders = [claudeProvider({ bridgeUrl: `http://127.0.0.1:${claudeBridge.port}` })];
    const response = await responseRequest(request("claude-web/sonnet"), config);
    const body = await response.json() as {
      status?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    expect(body.status).toBe("completed");
    const text = (body.output ?? []).flatMap(item => item.content ?? [])
      .filter(part => part.type === "output_text").map(part => part.text ?? "").join("");
    expect(text).toBe("olá do Claude Web");
  } finally {
    claudeBridge.stop(true);
  }
});

test("rejects an unknown model behind a configured provider prefix", async () => {
  const config = defaultConfig("browser-only");
  config.webProviders = [claudeProvider()];
  const response = await responseRequest(request("claude-web/unknown"), config);
  expect(response.status).toBe(400);
  const body = await response.json() as { error?: { message?: string } };
  expect(body.error?.message ?? "").toContain("Unknown bridged model");
});
