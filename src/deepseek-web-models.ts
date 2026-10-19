import type { AppConfig } from "./config";

type JsonObject = Record<string, unknown>;

export const DEEPSEEK_WEB_MODEL_PREFIX = "deepseek-web/";
export const DEEPSEEK_WEB_BRIDGE_ENV = "DEEPSEEK_WEB_BRIDGE_URL";
export const DEEPSEEK_WEB_DEFAULT_BRIDGE_URL = "http://127.0.0.1:8787";

export type DeepSeekWebBackendModel = "deepseek-web" | "deepseek-web-think";

export interface DeepSeekWebModelSpec {
  /** Slug Codex sees in the model picker. */
  slug: string;
  displayName: string;
  description: string;
  /** Model id the local bridge exposes on /v1/models. */
  backendModel: DeepSeekWebBackendModel;
  contextWindow: number;
  autoCompactTokenLimit: number;
  /** True when the site streams a separate reasoning channel. */
  thinking: boolean;
}

const CONTEXT_WINDOW = 131_072;
const AUTO_COMPACT_TOKEN_LIMIT = 118_000;

export const DEEPSEEK_WEB_MODEL_SPECS: readonly DeepSeekWebModelSpec[] = [
  {
    slug: `${DEEPSEEK_WEB_MODEL_PREFIX}chat`,
    displayName: "DeepSeek Web (Chat)",
    description: "DeepSeek web chat through the local browser bridge. Text only; tools use the bridge's text protocol.",
    backendModel: "deepseek-web",
    contextWindow: CONTEXT_WINDOW,
    autoCompactTokenLimit: AUTO_COMPACT_TOKEN_LIMIT,
    thinking: false,
  },
  {
    slug: `${DEEPSEEK_WEB_MODEL_PREFIX}think`,
    displayName: "DeepSeek Web (Think)",
    description: "DeepSeek web reasoning model through the local browser bridge. Thinking happens on the site.",
    backendModel: "deepseek-web-think",
    contextWindow: CONTEXT_WINDOW,
    autoCompactTokenLimit: AUTO_COMPACT_TOKEN_LIMIT,
    thinking: true,
  },
];

/** The configured bridge origin, or undefined when DeepSeek Web was not opted into. */
export function normalizeDeepSeekWebBridgeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`${DEEPSEEK_WEB_BRIDGE_ENV} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${DEEPSEEK_WEB_BRIDGE_ENV} must be an http(s) URL`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function deepSeekWebBridgeUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[DEEPSEEK_WEB_BRIDGE_ENV]?.trim();
  if (!raw) return undefined;
  return normalizeDeepSeekWebBridgeUrl(raw);
}

/** Persisted core configuration wins; the environment variable stays as an explicit override seam. */
export function configuredDeepSeekWebBridgeUrl(
  config?: { deepseekWebBridgeUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = config?.deepseekWebBridgeUrl?.trim();
  if (configured) return normalizeDeepSeekWebBridgeUrl(configured);
  return deepSeekWebBridgeUrl(env);
}

export function requiredConfiguredDeepSeekWebBridgeUrl(
  config?: { deepseekWebBridgeUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = configuredDeepSeekWebBridgeUrl(config, env);
  if (!url) {
    throw new Error(
      `DeepSeek Web is not configured. Start the local bridge and run `
        + `codex-chatgpt-web deepseek-web set --bridge-url ${DEEPSEEK_WEB_DEFAULT_BRIDGE_URL}.`,
    );
  }
  return url;
}

export function requiredDeepSeekWebBridgeUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = deepSeekWebBridgeUrl(env);
  if (!url) {
    throw new Error(
      `DeepSeek Web is not configured. Start the local bridge and set ${DEEPSEEK_WEB_BRIDGE_ENV} `
        + `(default ${DEEPSEEK_WEB_DEFAULT_BRIDGE_URL}).`,
    );
  }
  return url;
}

export function isDeepSeekWebModelId(modelId: string): boolean {
  return modelId.startsWith(DEEPSEEK_WEB_MODEL_PREFIX);
}

export function resolveDeepSeekWebModelSpec(modelId: string): DeepSeekWebModelSpec {
  const spec = DEEPSEEK_WEB_MODEL_SPECS.find(candidate => candidate.slug === modelId);
  if (!spec) {
    throw new Error(
      `Unknown DeepSeek Web model: ${modelId}. Known models: ${DEEPSEEK_WEB_MODEL_SPECS.map(item => item.slug).join(", ")}`,
    );
  }
  return spec;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

/**
 * Build one picker row from a native Codex template. Only the provider-owned fields are
 * replaced; Codex keeps its own instructions, shell type and multi-agent surface.
 */
export function buildDeepSeekWebModel(
  templateValue: unknown,
  spec: DeepSeekWebModelSpec,
  config: AppConfig,
): JsonObject {
  const template = object(templateValue, "native Codex model template");
  const templateSlug = template.slug;
  if (typeof templateSlug !== "string" || !templateSlug || templateSlug.startsWith(DEEPSEEK_WEB_MODEL_PREFIX)) {
    throw new Error("DeepSeek Web model template must be a native Codex model");
  }
  const model: JsonObject = {
    ...structuredClone(template),
    slug: spec.slug,
    display_name: spec.displayName,
    description: spec.description,
    input_modalities: ["text"],
    visibility: "list",
    // Served by this local Responses-compatible bridge, so Codex must keep the row in API mode.
    supported_in_api: true,
    tool_mode: null,
    upgrade: null,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: spec.displayName }],
    context_window: spec.contextWindow,
    max_context_window: spec.contextWindow,
    effective_context_window_percent: 95,
    auto_compact_token_limit: spec.autoCompactTokenLimit,
    // The DeepSeek web bridge has no Codex service tier.
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
  if (config.subagentProtocol === "compatibility-v1") {
    model.multi_agent_version = "v1";
  } else if (typeof template.multi_agent_version === "string") {
    model.multi_agent_version = template.multi_agent_version;
  }
  // Native compaction hashes describe OpenAI's contract, not this bridged model.
  delete model.comp_hash;
  delete model.availability_nux;
  return model;
}
