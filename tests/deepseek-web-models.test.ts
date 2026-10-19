import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import {
  buildDeepSeekWebModel,
  configuredDeepSeekWebBridgeUrl,
  DEEPSEEK_WEB_BRIDGE_ENV,
  DEEPSEEK_WEB_MODEL_SPECS,
  deepSeekWebBridgeUrl,
  isDeepSeekWebModelId,
  requiredDeepSeekWebBridgeUrl,
  resolveDeepSeekWebModelSpec,
} from "../src/deepseek-web-models";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { modelsRequest } from "../src/server";

function nativeCatalog(): Record<string, unknown> {
  return {
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        description: "native",
        priority: 2,
        visibility: "list",
        supported_in_api: true,
        multi_agent_version: "v2",
        base_instructions: "native harness",
        supported_reasoning_levels: [{ effort: "medium", description: "Medium native" }],
        tool_mode: "code_mode_only",
        context_window: 300_000,
        max_context_window: 320_000,
        auto_compact_token_limit: 270_000,
        comp_hash: "native-compaction-contract",
        additional_speed_tiers: [{ id: "fast" }],
        service_tiers: [{ id: "fast" }],
        default_service_tier: "fast",
        availability_nux: { message: "native" },
      },
    ],
  };
}

function withBridgeEnv<T>(url: string | undefined, run: () => T): T {
  const previous = process.env[DEEPSEEK_WEB_BRIDGE_ENV];
  if (url === undefined) delete process.env[DEEPSEEK_WEB_BRIDGE_ENV];
  else process.env[DEEPSEEK_WEB_BRIDGE_ENV] = url;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[DEEPSEEK_WEB_BRIDGE_ENV];
    else process.env[DEEPSEEK_WEB_BRIDGE_ENV] = previous;
  }
}

describe("DeepSeek Web model catalog", () => {
  test("is absent until the bridge is configured", () => {
    const catalog = withBridgeEnv(undefined, () => augmentNativeModelCatalog(nativeCatalog(), defaultConfig("full")));
    const models = catalog.models as Array<{ slug?: string }>;
    expect(models.some(model => model.slug?.startsWith("deepseek-web/"))).toBe(false);
  });

  test("adds both rows with provider-owned limits when the bridge is configured", () => {
    const catalog = withBridgeEnv("http://127.0.0.1:8787", () => augmentNativeModelCatalog(nativeCatalog(), defaultConfig("full")));
    const models = catalog.models as Array<Record<string, unknown> & { slug: string }>;
    const deepSeek = models.filter(model => model.slug.startsWith("deepseek-web/"));
    expect(deepSeek.map(model => model.slug)).toEqual(["deepseek-web/chat", "deepseek-web/think"]);
    for (const model of deepSeek) {
      expect(model.context_window).toBe(131_072);
      expect(model.max_context_window).toBe(131_072);
      expect(model.auto_compact_token_limit).toBe(118_000);
      expect(model.visibility).toBe("list");
      expect(model.supported_in_api).toBe(true);
      expect(model.tool_mode).toBeNull();
      expect(model.input_modalities).toEqual(["text"]);
      expect(model.default_reasoning_level).toBe("medium");
      expect(model.comp_hash).toBeUndefined();
      expect(model.availability_nux).toBeUndefined();
      expect(model.additional_speed_tiers).toEqual([]);
      expect(model.service_tiers).toEqual([]);
      expect(model.default_service_tier).toBeNull();
    }
  });

  test("builds a row from a native template and honors Compatibility V1", () => {
    const template = (nativeCatalog().models as Array<Record<string, unknown>>)[0]!;
    const nativeConfig = defaultConfig("full");
    nativeConfig.subagentProtocol = "native";
    const native = buildDeepSeekWebModel(template, DEEPSEEK_WEB_MODEL_SPECS[0]!, nativeConfig);
    expect(native.slug).toBe("deepseek-web/chat");
    expect(native.display_name).toBe("DeepSeek Web (Chat)");
    expect(native.multi_agent_version).toBe("v2");
    expect(native.base_instructions).toBe("native harness");

    const compatibility = defaultConfig("full");
    compatibility.subagentProtocol = "compatibility-v1";
    const pinned = buildDeepSeekWebModel(template, DEEPSEEK_WEB_MODEL_SPECS[1]!, compatibility);
    expect(pinned.multi_agent_version).toBe("v1");
    expect(pinned.slug).toBe("deepseek-web/think");
  });

  test("rejects a template that already belongs to the bridge", () => {
    expect(() => buildDeepSeekWebModel({ slug: "deepseek-web/chat" }, DEEPSEEK_WEB_MODEL_SPECS[0]!, defaultConfig("full")))
      .toThrow(/must be a native Codex model/);
  });

  test("persisted configuration enables the rows without an environment variable", () => {
    const config = defaultConfig("full");
    config.deepseekWebBridgeUrl = "http://127.0.0.1:9999";
    const catalog = withBridgeEnv(undefined, () => augmentNativeModelCatalog(nativeCatalog(), config));
    const models = catalog.models as Array<{ slug?: string }>;
    expect(models.filter(model => model.slug?.startsWith("deepseek-web/")).map(model => model.slug))
      .toEqual(["deepseek-web/chat", "deepseek-web/think"]);
  });

  test("persisted configuration wins over the environment variable", () => {
    expect(configuredDeepSeekWebBridgeUrl(
      { deepseekWebBridgeUrl: "http://127.0.0.1:1111" },
      { [DEEPSEEK_WEB_BRIDGE_ENV]: "http://127.0.0.1:2222" },
    )).toBe("http://127.0.0.1:1111");
    expect(configuredDeepSeekWebBridgeUrl(
      {},
      { [DEEPSEEK_WEB_BRIDGE_ENV]: "http://127.0.0.1:2222" },
    )).toBe("http://127.0.0.1:2222");
    expect(configuredDeepSeekWebBridgeUrl({}, {})).toBeUndefined();
  });

  test("GET /v1/models exposes the rows to Codex only when configured", async () => {
    const fetchNative = async () => Response.json(nativeCatalog());
    const request = () => new Request("http://127.0.0.1:17841/v1/models", {
      headers: { authorization: "Bearer codex-oauth-token" },
    });
    const previous = process.env[DEEPSEEK_WEB_BRIDGE_ENV];
    try {
      process.env[DEEPSEEK_WEB_BRIDGE_ENV] = "http://127.0.0.1:8787";
      const enabled = await modelsRequest(request(), defaultConfig("full"), fetchNative);
      const enabledBody = await enabled.json() as { models: Array<{ slug: string }> };
      expect(enabledBody.models.filter(model => model.slug.startsWith("deepseek-web/")).map(model => model.slug))
        .toEqual(["deepseek-web/chat", "deepseek-web/think"]);

      delete process.env[DEEPSEEK_WEB_BRIDGE_ENV];
      const disabled = await modelsRequest(request(), defaultConfig("full"), fetchNative);
      const disabledBody = await disabled.json() as { models: Array<{ slug: string }> };
      expect(disabledBody.models.some(model => model.slug.startsWith("deepseek-web/"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[DEEPSEEK_WEB_BRIDGE_ENV];
      else process.env[DEEPSEEK_WEB_BRIDGE_ENV] = previous;
    }
  });
});

describe("DeepSeek Web routing helpers", () => {
  test("recognizes its own slugs only", () => {
    expect(isDeepSeekWebModelId("deepseek-web/chat")).toBe(true);
    expect(isDeepSeekWebModelId("deepseek-web/think")).toBe(true);
    expect(isDeepSeekWebModelId("chatgpt-web/gpt-5.6-sol")).toBe(false);
    expect(isDeepSeekWebModelId("gpt-5.6-sol")).toBe(false);
  });

  test("resolves both specs and rejects unknown ids", () => {
    expect(resolveDeepSeekWebModelSpec("deepseek-web/chat").backendModel).toBe("deepseek-web");
    expect(resolveDeepSeekWebModelSpec("deepseek-web/think").backendModel).toBe("deepseek-web-think");
    expect(() => resolveDeepSeekWebModelSpec("deepseek-web/unknown")).toThrow(/Unknown DeepSeek Web model/);
  });

  test("validates and normalizes the bridge URL", () => {
    expect(withBridgeEnv(undefined, () => deepSeekWebBridgeUrl())).toBeUndefined();
    expect(withBridgeEnv("http://127.0.0.1:8787/", () => deepSeekWebBridgeUrl())).toBe("http://127.0.0.1:8787");
    expect(withBridgeEnv("https://bridge.local/base/", () => requiredDeepSeekWebBridgeUrl())).toBe("https://bridge.local/base");
    expect(() => withBridgeEnv("not-a-url", () => deepSeekWebBridgeUrl())).toThrow(/absolute http\(s\) URL/);
    expect(() => withBridgeEnv("ftp://bridge.local", () => deepSeekWebBridgeUrl())).toThrow(/http\(s\) URL/);
    expect(() => withBridgeEnv(undefined, () => requiredDeepSeekWebBridgeUrl()))
      .toThrow(/DeepSeek Web is not configured/);
  });
});
