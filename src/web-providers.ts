import type { AppConfig, WebProviderConfig } from "./config";
import {
  configuredDeepSeekWebBridgeUrl,
  DEEPSEEK_WEB_MODEL_PREFIX,
  DEEPSEEK_WEB_MODEL_SPECS,
} from "./deepseek-web-models";

type JsonObject = Record<string, unknown>;

/** One picker row served by a local browser bridge. */
export interface WebProviderModelSpec {
  slug: string;
  displayName: string;
  description: string;
  /** Model id the bridge exposes on /v1/models. */
  backendModel: string;
  contextWindow: number;
  autoCompactTokenLimit: number;
  thinking: boolean;
}

export interface WebProviderDefinition {
  id: string;
  label: string;
  /** Every model slug for this provider starts with this prefix. */
  modelPrefix: string;
  bridgeUrl: string;
  models: WebProviderModelSpec[];
}

type WebProviderConfigShape = Pick<AppConfig, "deepseekWebBridgeUrl" | "webProviders">;

function normalizePrefix(id: string): string {
  return `${id}/`;
}

function providerFromConfig(provider: WebProviderConfig): WebProviderDefinition {
  const label = provider.label ?? provider.id;
  return {
    id: provider.id,
    label,
    modelPrefix: normalizePrefix(provider.id),
    bridgeUrl: provider.bridgeUrl,
    models: provider.models.map(model => ({
      slug: `${provider.id}/${model.id}`,
      displayName: model.displayName ?? `${label} (${model.id})`,
      description: model.description ?? `${label} through its local browser bridge.`,
      backendModel: model.id,
      contextWindow: model.contextWindow ?? 131_072,
      autoCompactTokenLimit: model.autoCompactTokenLimit ?? Math.floor((model.contextWindow ?? 131_072) * 0.9),
      thinking: model.thinking === true,
    })),
  };
}

/**
 * Every web-AI bridge this installation can route to.
 *
 * DeepSeek Web stays a first-class built-in provider (its URL has its own persisted field and
 * environment override); `webProviders` carries any additional bridge, so Claude Web or Gemini Web
 * only need a bridge process plus configuration, not new core code.
 */
export function configuredWebProviders(
  config?: WebProviderConfigShape,
  env: NodeJS.ProcessEnv = process.env,
): WebProviderDefinition[] {
  const providers: WebProviderDefinition[] = [];
  const deepseekBridgeUrl = configuredDeepSeekWebBridgeUrl(config, env);
  if (deepseekBridgeUrl) {
    providers.push({
      id: "deepseek-web",
      label: "DeepSeek Web",
      modelPrefix: DEEPSEEK_WEB_MODEL_PREFIX,
      bridgeUrl: deepseekBridgeUrl,
      models: DEEPSEEK_WEB_MODEL_SPECS.map(model => ({
        slug: model.slug,
        displayName: model.displayName,
        description: model.description,
        backendModel: model.backendModel,
        contextWindow: model.contextWindow,
        autoCompactTokenLimit: model.autoCompactTokenLimit,
        thinking: model.thinking,
      })),
    });
  }
  for (const provider of config?.webProviders ?? []) {
    providers.push(providerFromConfig(provider));
  }
  return providers;
}

export function webProviderForModelId(
  config: WebProviderConfigShape | undefined,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): { provider: WebProviderDefinition; model: WebProviderModelSpec } | undefined {
  for (const provider of configuredWebProviders(config, env)) {
    if (!modelId.startsWith(provider.modelPrefix)) continue;
    const model = provider.models.find(candidate => candidate.slug === modelId);
    if (model) return { provider, model };
  }
  return undefined;
}

export function requiredWebProviderForModelId(
  config: WebProviderConfigShape | undefined,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): { provider: WebProviderDefinition; model: WebProviderModelSpec } {
  const found = webProviderForModelId(config, modelId, env);
  if (found) return found;
  const known = configuredWebProviders(config, env).flatMap(provider => provider.models.map(model => model.slug));
  throw new Error(`Unknown bridged model: ${modelId}. Configured: ${known.join(", ") || "none"}`);
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

/**
 * Build one picker row from a native Codex template. Only provider-owned fields are replaced;
 * Codex keeps its own instructions, shell type and multi-agent surface.
 */
export function buildBridgedWebModel(
  templateValue: unknown,
  provider: WebProviderDefinition,
  model: WebProviderModelSpec,
  config: AppConfig,
): JsonObject {
  const template = object(templateValue, "native Codex model template");
  const templateSlug = template.slug;
  if (typeof templateSlug !== "string" || !templateSlug || templateSlug.startsWith(provider.modelPrefix)) {
    throw new Error(`${provider.label} model template must be a native Codex model`);
  }
  const row: JsonObject = {
    ...structuredClone(template),
    slug: model.slug,
    display_name: model.displayName,
    description: model.description,
    input_modalities: ["text"],
    visibility: "list",
    supported_in_api: true,
    tool_mode: null,
    upgrade: null,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: model.displayName }],
    context_window: model.contextWindow,
    max_context_window: model.contextWindow,
    effective_context_window_percent: 95,
    auto_compact_token_limit: model.autoCompactTokenLimit,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
  if (config.subagentProtocol === "compatibility-v1") {
    row.multi_agent_version = "v1";
  } else if (typeof template.multi_agent_version === "string") {
    row.multi_agent_version = template.multi_agent_version;
  }
  delete row.comp_hash;
  delete row.availability_nux;
  return row;
}
