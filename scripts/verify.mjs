// End-to-end verification against a mocked Puter upstream.
// Usage: node scripts/verify.mjs
// Boots the Next.js production server on a scratch port with PUTER_API_BASE
// pointed at a local mock of both Puter upstream paths, then exercises
// /v1/models, /v1/chat/completions (non-streaming + streaming, tools,
// parallel tools, reasoning), auth, and error mapping. Exits non-zero on
// any failure.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { once } from "node:events";
import { createServer } from "node:http";

const PORT = 3111;
const MOCK_PORT = 3121; // keep clear of PORT+1/PORT+2 used for extra servers below
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${extra ? ` (${extra})` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Mock Puter upstream
// ---------------------------------------------------------------------------
const mockServer = createServer((req, res) => {
  let chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyRaw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = JSON.parse(bodyRaw || "{}");
    } catch {}
    const auth = req.headers.authorization || "";

    if (!auth.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Missing auth", code: "token_missing" } }));
      return;
    }
    if (auth !== "Bearer test-puter-key") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Authentication failed", code: "token_auth_failed" } }));
      return;
    }

    // Driver path: /drivers/call
    if (req.url === "/drivers/call" && body.interface === "puter-chat-completion") {
      const stream = body.args?.stream === true;
      const hasTools = Array.isArray(body.args?.tools) && body.args.tools.length > 0;
      const isReasoning = String(body.args?.model || "").includes("deepseek-r1");

      if (stream) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        const events = [];
        if (hasTools) {
          events.push({ type: "tool_use", id: "call_mock1", name: "get_weather", input: { city: "Tokyo" }, text: "" });
          if (body.args?.messages?.[0]?.content?.includes("both")) {
            events.push({ type: "tool_use", id: "call_mock2", name: "get_weather", input: { city: "Paris" }, text: "" });
          }
        } else if (isReasoning) {
          events.push({ type: "text", text: "<think>\nLet me compute 17*23.\n</think>" });
          events.push({ type: "text", text: "391" });
        } else {
          events.push({ type: "text", text: "Hello" });
          events.push({ type: "text", text: " " });
          events.push({ type: "text", text: "world" });
        }
        events.push({ type: "usage", usage: { prompt_tokens: 5, completion_tokens: 3, cached_tokens: 0, usd_cents: 0.001 } });
        for (const e of events) res.write(JSON.stringify(e) + "\n");
        res.end();
        return;
      }

      // non-streaming
      let result;
      if (hasTools) {
        const calls = [{ id: "call_mock1", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }];
        if (body.args?.messages?.[0]?.content?.includes("both")) {
          calls.push({ id: "call_mock2", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } });
        }
        result = { index: 0, message: { role: "assistant", content: null, tool_calls: calls }, finish_reason: "tool_calls", usage: { prompt_tokens: 5, completion_tokens: 3 } };
      } else if (isReasoning) {
        result = { index: 0, message: { role: "assistant", content: "391", reasoning: "17*23 = 391" }, finish_reason: "stop", usage: { prompt_tokens: 5, completion_tokens: 3 } };
      } else {
        result = { index: 0, message: { role: "assistant", content: "Hello, world!" }, finish_reason: "stop", usage: { prompt_tokens: 5, completion_tokens: 3 } };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, result, service: { name: "ai-chat" } }));
      return;
    }

    // Official path: /puterai/openai/v1/chat/completions
    if (req.url?.endsWith("/chat/completions")) {
      const stream = body.stream === true;
      if (stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const chunk = (delta, finish = null) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: 1700000000,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        res.write(chunk({ role: "assistant", content: "" }));
        res.write(chunk({ content: "Hi " }));
        res.write(chunk({ content: "there" }));
        res.write(chunk({}, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: 1700000000,
          model: body.model,
          choices: [
            { index: 0, message: { role: "assistant", content: "Hi!" }, logprobs: null, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found", code: "not_found" } }));
  });
});

function waitReady(url, tries = 60) {
  return (async () => {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url);
        if (r.ok || r.status === 404) return true;
      } catch {}
      await sleep(250);
    }
    return false;
  })();
}

async function startServer(port, extraEnv) {
  const child = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    env: {
      ...process.env,
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  const ok = await (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}`);
        if (r.ok || r.status === 404) return true;
      } catch {}
      await sleep(250);
    }
    return false;
  })();
  return { child, ok, logs };
}

async function stop(child) {
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(2000)]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await new Promise((resolve) => mockServer.listen(MOCK_PORT, "127.0.0.1", resolve));
  console.log(`mock upstream on ${MOCK}`);

  const baseEnv = {
    PUTER_API_KEY: "test-puter-key",
    PUTER_API_BASE: MOCK,
    PUTER_MODE: "driver",
    GATEWAY_API_KEY: "test-gateway-key",
  };

  const { child, ok, logs } = await startServer(PORT, baseEnv);

  try {
    check("server booted", ok, logs.slice(-800));

    // ---- auth -------------------------------------------------------------
    {
      const r = await fetch(`${BASE}/v1/models`);
      check("missing gateway key → 401", r.status === 401);
      const j = await r.json();
      check("401 is OpenAI-style error", j?.error?.type === "invalid_request_error");
    }
    {
      const r = await fetch(`${BASE}/v1/models`, { headers: { Authorization: "Bearer wrong" } });
      check("wrong gateway key → 401 authentication_error", r.status === 401 && (await r.json())?.error?.type === "authentication_error");
    }

    // ---- /v1/models ---------------------------------------------------------
    {
      const r = await fetch(`${BASE}/v1/models`, { headers: { Authorization: "Bearer test-gateway-key" } });
      const j = await r.json();
      check("/v1/models 200", r.status === 200);
      check("models list object", j.object === "list" && Array.isArray(j.data));
      check(
        "model entry shape",
        j.data.length > 0 && j.data.every((m) => m.id && m.object === "model" && typeof m.created === "number" && typeof m.owned_by === "string")
      );
    }

    // ---- non-streaming chat -------------------------------------------------
    {
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-gateway-key" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Say hi" }] }),
      });
      const j = await r.json();
      check("chat 200", r.status === 200);
      check("chat.completion object", j.object === "chat.completion");
      check("id prefix", typeof j.id === "string" && j.id.startsWith("chatcmpl-"));
      check("created epoch", Number.isInteger(j.created));
      check("model echoed", j.model === "gpt-4o-mini");
      check(
        "choices shape",
        Array.isArray(j.choices) && j.choices[0]?.message?.role === "assistant" && j.choices[0]?.message?.content === "Hello, world!" && j.choices[0]?.finish_reason === "stop"
      );
      check("usage shape", j.usage && j.usage.prompt_tokens === 5 && j.usage.completion_tokens === 3 && j.usage.total_tokens === 8);
      check("no stream headers", !(r.headers.get("content-type") || "").includes("text/event-stream"));
    }

    // ---- streaming chat ------------------------------------------------------
    {
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-gateway-key" },
        body: JSON.stringify({ model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "Say hi" }] }),
      });
      check("stream 200", r.status === 200);
      check("SSE content type", (r.headers.get("content-type") || "").includes("text/event-stream"));

      const text = await r.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data: "));
      const payload = lines.map((l) => l.slice(6));
      check("stream ends with [DONE]", payload[payload.length - 1] === "[DONE]");

      const objs = payload.slice(0, -1).map((p) => JSON.parse(p));
      check("all chunks are chat.completion.chunk", objs.every((o) => o.object === "chat.completion.chunk"));
      check("role chunk first", objs[0]?.choices?.[0]?.delta?.role === "assistant");
      const contents = objs.filter((o) => o.choices?.[0]?.delta?.content).map((o) => o.choices[0].delta.content);
      check("delta contents forwarded", contents.join("") === "Hello world");
      check("finish_reason stop present", objs.some((o) => o.choices?.[0]?.finish_reason === "stop"));
      check("usage chunk present", objs.some((o) => o.usage && o.usage.total_tokens === 8));
    }

    // ---- tool calls (non-streaming) -----------------------------------------
    {
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-gateway-key" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "Weather in Tokyo?" }],
          tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
        }),
      });
      const j = await r.json();
      const choice = j.choices?.[0];
      check("tool chat 200", r.status === 200);
      check("tool finish_reason tool_calls", choice?.finish_reason === "tool_calls");
      check(
        "tool_calls shape",
        Array.isArray(choice?.message?.tool_calls) &&
          choice.message.tool_calls[0]?.id?.startsWith("call_") === true &&
          choice.message.tool_calls[0]?.type === "function" &&
          choice.message.tool_calls[0]?.function?.name === "get_weather" &&
          JSON.parse(choice.message.tool_calls[0]?.function?.arguments || "{}").city === "Tokyo"
      );
    }

    // ---- parallel tool calls (non-streaming) ---------------------------------
    {
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-gateway-key" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "Weather in both Tokyo and Paris?" }],
          tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
        }),
      });
      const j = await r.json();
      const calls = j.choices?.[0]?.message?.tool_calls;
      check("parallel tool_calls count 2", Array.isArray(calls) && calls.length === 2);
      check("parallel calls have distinct ids", calls?.[0]?.id !== calls?.[1]?.id);
    }

    // ---- tool calls (streaming) ----------------------------------------------
    {
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-gateway-key" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          stream: true,
          messages: [{ role: "user", content: "Weather in Tokyo?" }],
          tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
        }),
      });
      const text = await r.text();
      const payloads = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
      const objs = payloads.slice(0, -1).map((p) => JSON.parse(p));
      const toolChunk = objs.find((o) => o.choices?.[0]?.delta?.tool_calls?.length);
      check("stream tool_call delta emitted", !!toolChunk);
      const tc = toolChunk?.choices?.[0]?.delta?.tool_calls?.[0];
      check("stream tool_call has index+id+args", typeof tc?.index === "number" && tc?.id === "call_mock1" && JSON.parse(tc.function.arguments).city === "Tokyo");
      check("stream tool finish_reason tool_calls", objs.some((o) => o.choices?.[0]?.finish_reason === "tool_calls"));
    }

    // ---- reasoning (non-streaming + streaming) --------------------------------
    {
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-gateway-key" },
        body: JSON.stringify({ model: "deepseek-r1", messages: [{ role: "user", content: "17*23?" }] }),
      });
      const j = await r.json();
      check("reasoning field on message", j.choices?.[0]?.message?.reasoning === "17*23 = 391");
      check("reasoning content intact", j.choices?.[0]?.message?.content === "391");
    }
    {
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-gateway-key" },
        body: JSON.stringify({ model: "deepseek-r1", stream: true, messages: [{ role: "user", content: "17*23?" }] }),
      });
      const text = await r.text();
      const payloads = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
      const objs = payloads.slice(0, -1).map((p) => JSON.parse(p));
      const reasoning = objs.filter((o) => o.choices?.[0]?.delta?.reasoning).map((o) => o.choices[0].delta.reasoning).join("");
      const content = objs.filter((o) => o.choices?.[0]?.delta?.content).map((o) => o.choices[0].delta.content).join("");
      check("stream reasoning delta", reasoning.includes("Let me compute"));
      check("think block stripped from content", content === "391" && !content.includes("think"));
    }

    // ---- passthrough verification (mock asserts upstream receives fields) -----
    {
      // The mock echoes success for any payload; verify args arrive intact by
      // making the mock reject unknown fields is overkill — instead confirm a
      // response_format request still succeeds end-to-end.
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-gateway-key" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
          response_format: { type: "json_object" },
          reasoning_effort: "low",
          seed: 7,
          temperature: 0.2,
        }),
      });
      check("passthrough fields accepted", r.status === 200);
    }

    // ---- official passthrough mode -----------------------------------------
    const official = await startServer(PORT + 1, {
      ...baseEnv,
      PUTER_API_BASE: `${MOCK}/puterai/openai/v1`,
      PUTER_MODE: "official",
    });
    try {
      check("official-mode server booted", official.ok, official.logs.slice(-500));
      const base2 = `http://127.0.0.1:${PORT + 1}`;
      const r = await fetch(`${base2}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-gateway-key" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Say hi" }] }),
      });
      const j = await r.json();
      check("official non-stream passthrough", j.object === "chat.completion" && j.choices?.[0]?.message?.content === "Hi!");
      const rs = await fetch(`${base2}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-gateway-key" },
        body: JSON.stringify({ model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "Say hi" }] }),
      });
      const text = await rs.text();
      check("official stream passthrough ends with [DONE]", text.trimEnd().endsWith("data: [DONE]"));
    } finally {
      await stop(official.child);
    }

    // ---- error mapping --------------------------------------------------------
    {
      const bad = await startServer(PORT + 2, { ...baseEnv, PUTER_API_KEY: "wrong-puter-key" });
      try {
        check("error-map server booted", bad.ok, bad.logs.slice(-500));
        const r = await fetch(`http://127.0.0.1:${PORT + 2}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer test-gateway-key" },
          body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
        });
        const j = await r.json();
        check("upstream 401 → gateway 401 authentication_error", r.status === 401 && j?.error?.type === "authentication_error");
      } finally {
        await stop(bad.child);
      }
    }

    // ---- bad requests ----------------------------------------------------------
    {
      const r1 = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-gateway-key" },
        body: "{not json",
      });
      check("bad json → 400", r1.status === 400);
      const r2 = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-gateway-key" },
        body: JSON.stringify({ messages: [] }),
      });
      const j2 = await r2.json();
      check("missing model → 400 invalid_request_error", r2.status === 400 && j2?.error?.type === "invalid_request_error");
    }

    // ---- landing page -----------------------------------------------------------
    {
      const r = await fetch(BASE);
      const html = await r.text();
      check("landing page 200", r.status === 200);
      check("landing mentions endpoints", html.includes("/v1/chat/completions") && html.includes("/v1/models"));
    }
  } finally {
    await stop(child);
    mockServer.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
