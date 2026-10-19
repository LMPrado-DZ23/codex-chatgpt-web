import { createWebBridgeAdapter } from "./adapters/deepseek-web";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import type { AppConfig } from "./config";
import { AsyncEventQueue } from "./event-queue";
import { COMPACT_PROMPT } from "./responses/compaction";
import { toolBridgeMaps } from "./tool-bridge-maps";
import type { AdapterEvent, CodexParsedRequest } from "./types";
import type { WebProviderDefinition, WebProviderModelSpec } from "./web-providers";

export interface WebBridgeRouteOptions {
  /** In-process DEV harnesses observe the exact adapter stream. */
  onAdapterEvent?: (event: AdapterEvent) => void;
}

/**
 * Serve one turn through a local web-AI bridge (DeepSeek Web, Claude Web, Gemini Web, ...).
 *
 * The wire format stays the Responses API, so Codex sees a normal routed model; only the adapter
 * behind it differs from the ChatGPT Web browser worker.
 */
export async function webBridgeResponseRequest(
  parsed: CodexParsedRequest,
  config: AppConfig,
  provider: WebProviderDefinition,
  model: WebProviderModelSpec,
  options: WebBridgeRouteOptions = {},
): Promise<Response> {
  if (parsed._opaqueMultiAgentV2Payload) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      `${provider.label} cannot read this encrypted cross-backend subagent payload. `
        + "Start a new Compatibility V1 task, or delegate from a routed model whose collaboration call uses plaintext delivery.",
    );
  }

  const compaction = parsed._compactionRequest === true;
  const compactionItem = compaction && parsed._compactionResponseFormat !== "message";
  if (compaction) {
    // History compaction is a dedicated summarization turn and must not bind tools.
    delete parsed.context.tools;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  const adapter = createWebBridgeAdapter({ bridgeUrl: provider.bridgeUrl, spec: model });
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();
  const run = async (): Promise<void> => {
    try {
      await adapter.runTurn(parsed, { headers: new Headers(), abortSignal: abort.signal }, event => {
        options.onAdapterEvent?.(event);
        queue.push(event);
      });
    } catch (error) {
      const event: AdapterEvent = {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
      options.onAdapterEvent?.(event);
      queue.push(event);
    } finally {
      queue.close();
    }
  };

  const maps = toolBridgeMaps(parsed);
  if (parsed.stream) {
    void run();
    const stream = bridgeToResponsesSSE(
      queue,
      parsed.modelId,
      maps.toolNsMap,
      maps.freeformToolNames,
      maps.toolSearchToolNames,
      () => abort.abort(),
      2_000,
      {
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(config.stallTimeoutSec !== undefined ? { stallTimeoutSec: config.stallTimeoutSec } : {}),
        ...(compactionItem ? { compaction: true } : {}),
      },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  await run();
  const events = await queue.collect();
  const json = buildResponseJSON(events, parsed.modelId, {
    hideThinkingSummary: parsed.options.hideThinkingSummary,
    toolNsMap: maps.toolNsMap,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
    ...(compactionItem ? { compaction: true } : {}),
  });
  return Response.json(json);
}
