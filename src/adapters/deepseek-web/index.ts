import type { ProviderAdapter } from "../base";
import type {
  AdapterEvent,
  CodexContentPart,
  CodexParsedRequest,
  CodexTool,
  CodexToolChoice,
  CodexUsage,
} from "../../types";
import { namespacedToolName } from "../../types";

/** Minimal model description any local web bridge adapter needs. */
export interface WebBridgeAdapterModel {
  /** Model id the bridge exposes on /v1/models. */
  backendModel: string;
}

export interface DeepSeekWebAdapterConfig {
  /** Local bridge origin, e.g. http://127.0.0.1:8787 (no trailing slash). */
  bridgeUrl: string;
  spec: WebBridgeAdapterModel;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

type JsonRecord = Record<string, unknown>;

/**
 * Provider adapter for the local `deepseek-web-bridge` server, which drives chat.deepseek.com
 * through a real browser session and exposes OpenAI chat-completions endpoints.
 *
 * This adapter only translates the Codex Responses contract to and from that bridge. It never
 * touches the ChatGPT browser worker, the tunnel, or ChatGPT session state.
 */
export function createDeepSeekWebAdapter(config: DeepSeekWebAdapterConfig): ProviderAdapter {
  return createWebBridgeAdapter(config);
}

/** Generic alias: every local web bridge speaks the same chat-completions contract. */
export function createWebBridgeAdapter(config: DeepSeekWebAdapterConfig): ProviderAdapter {  return {
    name: "deepseek-web",
    async runTurn(parsed, incoming, emit) {
      const requestBody = buildChatCompletionRequest(parsed, config.spec);
      const response = await requestChatCompletion(config.bridgeUrl, requestBody, incoming.abortSignal);
      await consumeChatCompletionStream(response, emit, incoming.abortSignal);
    },
  };
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function abortError(): Error {
  return new DOMException("DeepSeek Web turn aborted", "AbortError");
}

function textContent(content: string | CodexContentPart[], label: string): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part.text);
      continue;
    }
    throw new Error(`${label}: DeepSeek Web does not support image content yet`);
  }
  return parts.join("\n");
}

function assistantMessage(parts: import("../../types").CodexAssistantContentPart[]): ChatMessage {
  const text: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      text.push(part.text);
      continue;
    }
    if (part.type === "toolCall") {
      toolCalls.push({
        id: part.id,
        type: "function",
        function: {
          name: namespacedToolName(part.namespace, part.name),
          arguments: JSON.stringify(part.arguments ?? {}),
        },
      });
      continue;
    }
    // Signed/opaque reasoning cannot be replayed to the DeepSeek web session.
  }
  const message: ChatMessage = { role: "assistant", content: text.join("\n") };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

function chatTool(tool: CodexTool): ChatTool {
  return {
    type: "function",
    function: {
      name: namespacedToolName(tool.namespace, tool.name),
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function chatToolChoice(choice: CodexToolChoice | undefined): unknown {
  if (choice === undefined) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if ("name" in choice) {
    return { type: "function", function: { name: choice.name } };
  }
  // An allowed-tools subset cannot be enforced by the browser bridge; keep automatic selection.
  return "auto";
}

export function buildChatCompletionRequest(parsed: CodexParsedRequest, spec: WebBridgeAdapterModel): JsonRecord {
  const messages: ChatMessage[] = [];
  const systemPrompt = parsed.context.systemPrompt?.filter(part => part.trim().length > 0).join("\n\n");
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  for (const message of parsed.context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: textContent(message.content, "user message") });
      continue;
    }
    if (message.role === "developer") {
      messages.push({ role: "system", content: textContent(message.content, "developer message") });
      continue;
    }
    if (message.role === "agentMessage") {
      const author = message.author ?? "agent";
      const recipient = message.recipient ?? "agent";
      const content = textContent(message.content, "agent message");
      messages.push({ role: "user", content: `[${author} → ${recipient}]\n${content}` });
      continue;
    }
    if (message.role === "assistant") {
      messages.push(assistantMessage(message.content));
      continue;
    }
    messages.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: textContent(message.content, "tool result"),
    });
  }
  const body: JsonRecord = {
    model: spec.backendModel,
    messages,
    stream: true,
  };
  const tools = parsed.context.tools ?? [];
  if (tools.length > 0) {
    body.tools = tools.map(chatTool);
    const choice = chatToolChoice(parsed.options.toolChoice);
    if (choice !== undefined) body.tool_choice = choice;
  }
  return body;
}

async function requestChatCompletion(bridgeUrl: string, body: JsonRecord, signal: AbortSignal | undefined): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${bridgeUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The local bridge ignores authentication; it only needs to be reachable.
        authorization: "Bearer deepseek-web-bridge",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DeepSeek Web bridge is unreachable at ${bridgeUrl} (${message}). Start the bridge and sign in again.`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `DeepSeek Web bridge rejected the turn (HTTP ${response.status})`
        + `${detail.trim() ? `: ${detail.trim().slice(0, 600)}` : ""}`,
    );
  }
  if (!response.body) throw new Error("DeepSeek Web bridge returned an empty response body");
  return response;
}

function usageFrom(value: unknown): CodexUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  const total = usage.total_tokens;
  const reasoning = asRecord(usage.completion_tokens_details)?.reasoning_tokens;
  const mapped: CodexUsage = { inputTokens: input, outputTokens: output };
  if (typeof total === "number") mapped.totalTokens = total;
  if (typeof reasoning === "number") mapped.reasoningOutputTokens = reasoning;
  return mapped;
}

async function consumeChatCompletionStream(
  response: Response,
  emit: (event: AdapterEvent) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!response.body) throw new Error("DeepSeek Web bridge returned an empty response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: CodexUsage | undefined;
  let stopReason: string | undefined;
  let produced = false;
  let finished = false;

  const handleLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    // SSE comments (: keep-alive) and blank separators carry no payload.
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      finished = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const chunk = asRecord(parsed);
    if (!chunk) return;
    if (chunk.usage !== undefined) usage = usageFrom(chunk.usage) ?? usage;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choiceValue of choices) {
      const choice = asRecord(choiceValue);
      if (!choice) continue;
      const delta = asRecord(choice.delta);
      if (delta) {
        const thinking = asString(delta.reasoning_content);
        if (thinking) {
          produced = true;
          emit({ type: "thinking_delta", thinking });
        }
        const content = asString(delta.content);
        if (content) {
          produced = true;
          emit({ type: "text_delta", text: content });
        }
        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const callValue of toolCalls) {
          const call = asRecord(callValue);
          if (!call) continue;
          const fn = asRecord(call.function);
          const name = asString(fn?.name);
          if (!name) continue;
          const id = asString(call.id) ?? `deepseek_call_${call.index ?? 0}`;
          const args = asString(fn?.arguments) ?? "";
          produced = true;
          emit({ type: "tool_call_start", id, name });
          emit({ type: "tool_call_delta", arguments: args });
          emit({ type: "tool_call_end" });
        }
      }
      const finish = asString(choice.finish_reason);
      if (finish) stopReason = finish;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (finished) break;
  }
  if (buffer.trim().length > 0) handleLine(buffer);

  if (signal?.aborted) throw abortError();
  if (!produced && !finished) {
    throw new Error("DeepSeek Web bridge closed the stream before producing an answer.");
  }
  emit({
    type: "done",
    stopReason: stopReason ?? "stop",
    endTurn: true,
    ...(usage ? { usage } : {}),
  });
}
