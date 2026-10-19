import { afterAll, describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { DEEPSEEK_WEB_BRIDGE_ENV } from "../src/deepseek-web-models";
import { responseRequest } from "../src/server";

const originalBridgeUrl = process.env[DEEPSEEK_WEB_BRIDGE_ENV];

afterAll(() => {
  if (originalBridgeUrl === undefined) delete process.env[DEEPSEEK_WEB_BRIDGE_ENV];
  else process.env[DEEPSEEK_WEB_BRIDGE_ENV] = originalBridgeUrl;
});

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: "chatcmpl-route-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-web",
    choices: [{ index: 0, delta, finish_reason: finish }],
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
  process.env[DEEPSEEK_WEB_BRIDGE_ENV] = `http://127.0.0.1:${server.port}`;
  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    server.stop(true);
  }
}

function request(model: string, stream: boolean): Request {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: "hello", stream }),
  });
}

describe("DeepSeek Web route", () => {
  test("streams a routed turn through the local bridge as Responses SSE", async () => {
    await withBridge(() => sseResponse([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "olá" }),
      chunk({ content: " mundo" }),
      chunk({}, "stop"),
    ]), async () => {
      const response = await responseRequest(request("deepseek-web/chat", true), defaultConfig("full"));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("response.output_text.delta");
      expect(text).toContain("olá");
      expect(text).toContain(" mundo");
      expect(text).toContain("response.completed");
      expect(text).not.toContain("response.failed");
    });
  });

  test("returns a completed Responses object for non-streaming callers", async () => {
    await withBridge(() => sseResponse([
      chunk({ content: "resposta completa" }),
      chunk({}, "stop"),
    ]), async () => {
      const response = await responseRequest(request("deepseek-web/think", false), defaultConfig("full"));
      expect(response.status).toBe(200);
      const body = await response.json() as {
        status?: string;
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      };
      expect(body.status).toBe("completed");
      const text = (body.output ?? [])
        .flatMap(item => item.content ?? [])
        .filter(part => part.type === "output_text")
        .map(part => part.text ?? "")
        .join("");
      expect(text).toBe("resposta completa");
    });
  });

  test("routes with the persisted configuration URL even without the env var", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => sseResponse([chunk({ content: "via config" }), chunk({}, "stop")]),
    });
    const previous = process.env[DEEPSEEK_WEB_BRIDGE_ENV];
    delete process.env[DEEPSEEK_WEB_BRIDGE_ENV];
    const config = defaultConfig("full");
    config.deepseekWebBridgeUrl = `http://127.0.0.1:${server.port}`;
    try {
      const response = await responseRequest(request("deepseek-web/chat", false), config);
      const body = await response.json() as {
        status?: string;
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      };
      expect(body.status).toBe("completed");
      const text = (body.output ?? []).flatMap(item => item.content ?? [])
        .filter(part => part.type === "output_text").map(part => part.text ?? "").join("");
      expect(text).toBe("via config");
    } finally {
      server.stop(true);
      if (previous === undefined) delete process.env[DEEPSEEK_WEB_BRIDGE_ENV];
      else process.env[DEEPSEEK_WEB_BRIDGE_ENV] = previous;
    }
  });

  test("fails closed with an explicit message when the bridge is unreachable", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const closedUrl = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    process.env[DEEPSEEK_WEB_BRIDGE_ENV] = closedUrl;
    const response = await responseRequest(request("deepseek-web/chat", false), defaultConfig("full"));
    expect(response.status).toBe(200);
    const body = await response.json() as { status?: string; error?: { message?: string } };
    expect(body.status).toBe("failed");
    expect(body.error?.message ?? "").toContain("unreachable");
  });

  test("rejects DeepSeek routes when the bridge was never configured", async () => {
    delete process.env[DEEPSEEK_WEB_BRIDGE_ENV];
    const response = await responseRequest(request("deepseek-web/chat", false), defaultConfig("full"));
    expect(response.status).toBe(400);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("DeepSeek Web is not configured");
  });
});
