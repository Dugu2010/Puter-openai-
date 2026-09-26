// Live smoke test against the real Puter API using PUTER_API_KEY from env.
// Spawns a production server on a scratch port, exercises non-streaming and
// streaming chat completions end-to-end, then kills the server.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { once } from "node:events";

const PORT = 3131;
const BASE = `http://127.0.0.1:${PORT}`;

if (!process.env.PUTER_API_KEY) {
  console.error("PUTER_API_KEY not set in environment");
  process.exit(1);
}

const child = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
  env: { ...process.env, PORT: String(PORT), NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (d) => (logs += d));
child.stderr.on("data", (d) => (logs += d));

async function ready() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

let failed = 0;
const check = (n, c, x = "") => (c ? console.log(`  ok - ${n}`) : (failed++, console.error(`FAIL - ${n}${x ? ` (${x})` : ""}`)));

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get current weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

function parseSse(text) {
  const payloads = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
  const done = payloads[payloads.length - 1] === "[DONE]";
  return { done, objs: payloads.slice(0, -1).map((p) => JSON.parse(p)) };
}

try {
  check("server booted", await ready(), logs.slice(-500));

  // models
  const rm = await fetch(`${BASE}/v1/models`);
  const jm = await rm.json();
  check("/v1/models 200 with entries", rm.status === 200 && jm.data?.length > 0);

  // non-streaming (real Puter)
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Reply with exactly: PONG" }] }),
  });
  const j = await r.json();
  check("live chat 200", r.status === 200, JSON.stringify(j).slice(0, 300));
  check("live chat OpenAI shape", j.object === "chat.completion" && j.choices?.[0]?.message?.role === "assistant" && typeof j.choices[0].message.content === "string" && j.choices[0].finish_reason === "stop", JSON.stringify(j).slice(0, 300));
  check("live usage present", typeof j.usage?.total_tokens === "number");
  console.log("  content:", JSON.stringify(j.choices?.[0]?.message?.content));

  // streaming (real Puter)
  const rs = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "Count 1 to 3" }] }),
  });
  check("live stream 200 + SSE", rs.status === 200 && (rs.headers.get("content-type") || "").includes("text/event-stream"));
  const st = parseSse(await rs.text());
  check("live stream ends [DONE]", st.done);
  check("live chunks valid", st.objs.every((o) => o.object === "chat.completion.chunk"));
  const streamed = st.objs.flatMap((o) => (o.choices?.[0]?.delta?.content ? [o.choices[0].delta.content] : [])).join("");
  check("live streamed text non-empty", streamed.length > 0);
  console.log("  streamed:", JSON.stringify(streamed));

  // tool call round-trip (real Puter): assistant asks for tool, we answer it
  const rt = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Weather in Tokyo? Use the tool." }],
      tools: [WEATHER_TOOL],
      tool_choice: "required",
    }),
  });
  const jt = await rt.json();
  const calls = jt.choices?.[0]?.message?.tool_calls;
  check("live tool call 200 + finish tool_calls", rt.status === 200 && jt.choices?.[0]?.finish_reason === "tool_calls", JSON.stringify(jt).slice(0, 300));
  check("live tool call shape", calls?.[0]?.id && calls[0].function?.name === "get_weather" && JSON.parse(calls[0].function.arguments).city, JSON.stringify(calls).slice(0, 300));

  const rt2 = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "Weather in Tokyo? Use the tool." },
        jt.choices[0].message,
        { role: "tool", tool_call_id: calls[0].id, content: "22C sunny" },
      ],
      tools: [WEATHER_TOOL],
    }),
  });
  const jt2 = await rt2.json();
  check("live tool round-trip 200", rt2.status === 200, JSON.stringify(jt2).slice(0, 300));
  check("live tool result consumed", /22|sunny/i.test(jt2.choices?.[0]?.message?.content || ""), JSON.stringify(jt2.choices?.[0]?.message).slice(0, 200));
  console.log("  final:", JSON.stringify(jt2.choices?.[0]?.message?.content));

  // parallel tool calls (real Puter)
  const rp = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Weather in Tokyo AND Paris? Call the tool for each city." }],
      tools: [WEATHER_TOOL],
    }),
  });
  const jp = await rp.json();
  const pcalls = jp.choices?.[0]?.message?.tool_calls;
  check("live parallel tool_calls >= 2", Array.isArray(pcalls) && pcalls.length >= 2, JSON.stringify(pcalls).slice(0, 300));

  // tool call streaming (real Puter)
  const rts = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      stream: true,
      messages: [{ role: "user", content: "Weather in Tokyo? Use the tool." }],
      tools: [WEATHER_TOOL],
      tool_choice: "required",
    }),
  });
  const sts = parseSse(await rts.text());
  check("live tool stream ends [DONE]", sts.done);
  const toolDelta = sts.objs.find((o) => o.choices?.[0]?.delta?.tool_calls?.length);
  check("live tool stream delta present", !!toolDelta, JSON.stringify(sts.objs.filter((o) => o.choices?.[0]?.delta?.tool_calls)).slice(0, 300));
  check("live tool stream finish tool_calls", sts.objs.some((o) => o.choices?.[0]?.finish_reason === "tool_calls"));

  // reasoning streaming (real Puter, DeepSeek R1)
  const rr = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "infron:deepseek/deepseek-r1", stream: true, messages: [{ role: "user", content: "What is 17*23?" }] }),
  });
  const srr = parseSse(await rr.text());
  const reasoning = srr.objs.filter((o) => o.choices?.[0]?.delta?.reasoning).map((o) => o.choices[0].delta.reasoning).join("");
  const rcontent = srr.objs.filter((o) => o.choices?.[0]?.delta?.content).map((o) => o.choices[0].delta.content).join("");
  check("live reasoning stream ends [DONE]", srr.done);
  check("live reasoning deltas present", reasoning.length > 0);
  check("live think block stripped from content", !rcontent.includes("<think"));
  console.log("  reasoning (first 80):", JSON.stringify(reasoning.slice(0, 80)));
  console.log("  streamed answer:", JSON.stringify(rcontent.slice(0, 80)));

  // reasoning non-streaming
  const rrn = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "infron:deepseek/deepseek-r1", messages: [{ role: "user", content: "What is 12+12? Answer briefly." }] }),
  });
  const jrn = await rrn.json();
  check("live reasoning non-stream reasoning field", typeof jrn.choices?.[0]?.message?.reasoning === "string" && jrn.choices[0].message.reasoning.length > 0, JSON.stringify(jrn.choices?.[0]?.message).slice(0, 200));
  console.log("  non-stream reasoning (first 60):", JSON.stringify((jrn.choices?.[0]?.message?.reasoning || "").slice(0, 60)));
} finally {
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(2000)]);
}
process.exit(failed ? 1 : 0);
