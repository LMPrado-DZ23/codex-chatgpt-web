import { describe, expect, test } from "bun:test";
import { createDeepSeekWebAdapter } from "../src/adapters/deepseek-web";
import { DEEPSEEK_WEB_MODEL_SPECS } from "../src/deepseek-web-models";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

const chatSpec = DEEPSEEK_WEB_MODEL_SPECS[0]!;

function parsedRequest(overrides: Partial<CodexParsedRequest> = {}): CodexParsedRequest {
  return {
    modelId: chatSpec.slug,
    stream: true,
    context: {
      messages: [{ role: "user", content: "olá", timestamp: Date.now() }],
    },
    options: {},
    ...overrides,
  };
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-web",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  };
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function withBridge(
  handler: (request: Request) => Response | Promise<Response>,
  run: (bridgeUrl: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    server.stop(true);
  }
}

async function runTurn(
  bridgeUrl: string,
  request: CodexParsedRequest = parsedRequest(),
  signal?: AbortSignal,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  const adapter = createDeepSeekWebAdapter({ bridgeUrl, spec: chatSpec });
  await adapter.runTurn(request, { headers: new Headers(), abortSignal: signal }, event => {
    events.push(event);
  });
  return events;
}

describe("DeepSeek Web adapter", () => {
  test("streams text deltas, maps usage and ends the turn", async () => {
    await withBridge(() => sseResponse([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "olá" }),
      chunk({ content: " mundo" }),
      chunk({}, "stop", { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
    ]), async (bridgeUrl) => {
      const events = await runTurn(bridgeUrl);
      const text = events.filter(event => event.type === "text_delta").map(event => event.text).join("");
      expect(text).toBe("olá mundo");
      const done = events.find(event => event.type === "done");
      expect(done?.type).toBe("done");
      if (done?.type === "done") {
        expect(done.stopReason).toBe("stop");
        expect(done.endTurn).toBe(true);
        expect(done.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
      }
    });
  });

  test("relays the reasoning channel as thinking deltas", async () => {
    await withBridge(() => sseResponse([
      chunk({ reasoning_content: "pensando…" }),
      chunk({ content: "resposta" }),
      chunk({}, "stop"),
    ]), async (bridgeUrl) => {
      const events = await runTurn(bridgeUrl);
      expect(events.filter(event => event.type === "thinking_delta").map(event => event.thinking).join(""))
        .toBe("pensando…");
    });
  });

  test("relays bridge tool calls as start/delta/end events", async () => {
    await withBridge(() => sseResponse([
      chunk({
        tool_calls: [{
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "mcp__fs__read", arguments: '{"path":"a.txt"}' },
        }],
      }),
      chunk({}, "tool_calls", { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
    ]), async (bridgeUrl) => {
      const events = await runTurn(bridgeUrl);
      const start = events.find(event => event.type === "tool_call_start");
      expect(start).toMatchObject({ type: "tool_call_start", id: "call_1", name: "mcp__fs__read" });
      const args = events.filter(event => event.type === "tool_call_delta").map(event => event.arguments).join("");
      expect(args).toBe('{"path":"a.txt"}');
      expect(events.some(event => event.type === "tool_call_end")).toBe(true);
      const done = events.find(event => event.type === "done");
      if (done?.type === "done") expect(done.stopReason).toBe("tool_calls");
    });
  });

  test("translates Codex context and tools into a chat-completions request", async () => {
    let captured: Record<string, unknown> | undefined;
    await withBridge(async (request) => {
      captured = await request.json() as Record<string, unknown>;
      return sseResponse([chunk({ content: "ok" }), chunk({}, "stop")]);
    }, async (bridgeUrl) => {
      await runTurn(bridgeUrl, parsedRequest({
        context: {
          systemPrompt: ["You are Codex."],
          messages: [
            { role: "user", content: "olá", timestamp: 1 },
            { role: "developer", content: "dev rule", timestamp: 2 },
            {
              role: "assistant",
              content: [
                { type: "text", text: "lendo" },
                { type: "toolCall", id: "call_0", name: "read", namespace: "mcp__fs", arguments: { path: "a.txt" } },
              ],
              timestamp: 3,
            },
            { role: "toolResult", toolCallId: "call_0", toolName: "read", toolNamespace: "mcp__fs", content: "conteúdo", isError: false, timestamp: 4 },
            { role: "user", content: "continue", timestamp: 5 },
          ],
          tools: [{ name: "read", namespace: "mcp__fs", description: "Read a file", parameters: { type: "object", properties: {} } }],
        },
        options: { toolChoice: { name: "mcp__fs__read" } },
      }));

      expect(captured?.model).toBe("deepseek-web");
      expect(captured?.stream).toBe(true);
      const messages = captured?.messages as Array<Record<string, unknown>>;
      expect(messages[0]).toEqual({ role: "system", content: "You are Codex." });
      expect(messages[1]).toEqual({ role: "user", content: "olá" });
      expect(messages[2]).toEqual({ role: "system", content: "dev rule" });
      expect(messages[3]).toMatchObject({
        role: "assistant",
        content: "lendo",
        tool_calls: [{ id: "call_0", type: "function", function: { name: "mcp__fs__read" } }],
      });
      expect(messages[4]).toEqual({ role: "tool", tool_call_id: "call_0", content: "conteúdo" });
      expect(messages[5]).toEqual({ role: "user", content: "continue" });
      const tools = captured?.tools as Array<Record<string, unknown>>;
      expect(tools[0]).toEqual({
        type: "function",
        function: {
          name: "mcp__fs__read",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      });
      expect(captured?.tool_choice).toEqual({ type: "function", function: { name: "mcp__fs__read" } });
    });
  });

  test("rejects image content instead of silently dropping it", async () => {
    await withBridge(() => sseResponse([chunk({ content: "ok" })]), async (bridgeUrl) => {
      const request = parsedRequest({
        context: {
          messages: [{
            role: "user",
            content: [{ type: "text", text: "look" }, { type: "image", imageUrl: "data:image/png;base64,AA==" }],
            timestamp: 1,
          }],
        },
      });
      await expect(runTurn(bridgeUrl, request)).rejects.toThrow(/does not support image content/);
    });
  });

  test("reports bridge HTTP failures and unreachable bridges explicitly", async () => {
    await withBridge(() => new Response("bridge is signed out", { status: 503 }), async (bridgeUrl) => {
      await expect(runTurn(bridgeUrl)).rejects.toThrow(/HTTP 503.*bridge is signed out/s);
    });

    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const closedUrl = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    await expect(runTurn(closedUrl)).rejects.toThrow(/unreachable/);
  });

  test("aborts the bridge request with the caller's signal", async () => {
    await withBridge(() => sseResponse([chunk({ content: "never" })]), async (bridgeUrl) => {
      const controller = new AbortController();
      controller.abort();
      const error = await runTurn(bridgeUrl, parsedRequest(), controller.signal).catch(caught => caught as Error);
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
    });
  });
});
