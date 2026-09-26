import { ALIASES } from "@/lib/models";

const MODELS = Object.keys(ALIASES);

export default function Home() {
  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: "48px 20px 80px" }}>
      <header style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 32 }}>⇄</span>
          <h1 style={{ margin: 0, fontSize: 28 }}>Puter ⇄ OpenAI Gateway</h1>
        </div>
        <p style={{ color: "#9aa4b2", marginTop: 10 }}>
          An OpenAI-compatible API gateway backed by Puter's free user-pays AI path. Point any OpenAI SDK or tool at
          this host — no code changes beyond the base URL.
        </p>
      </header>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 18, borderBottom: "1px solid #1e2430", paddingBottom: 8 }}>Endpoints</h2>
        <ul style={{ paddingLeft: 18, color: "#c3cad5" }}>
          <li>
            <code>POST /v1/chat/completions</code> — chat completions; supports <code>stream: true</code> (SSE,{" "}
            <code>chat.completion.chunk</code> objects, ends with <code>data: [DONE]</code>)
          </li>
          <li>
            <code>GET /v1/models</code> — OpenAI-style model list
          </li>
          <li>
            <code>GET /</code> — this page
          </li>
        </ul>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 18, borderBottom: "1px solid #1e2430", paddingBottom: 8 }}>Supported features</h2>
        <ul style={{ paddingLeft: 18, color: "#c3cad5" }}>
          <li>
            <strong>Streaming</strong> — <code>&quot;stream&quot;: true</code> returns Server-Sent Events in OpenAI's
            chunk format, forwarded incrementally
          </li>
          <li>
            <strong>Tool / function calling</strong> — pass <code>tools</code> and <code>tool_choice</code>; responses
            carry <code>tool_calls</code> with <code>finish_reason: &quot;tool_calls&quot;</code>, including parallel
            calls; stream deltas use <code>delta.tool_calls</code> with indexes; send results back as{" "}
            <code>role: &quot;tool&quot;</code> messages
          </li>
          <li>
            <strong>Reasoning models</strong> — thinking is exposed as <code>message.reasoning</code> (non-streaming)
            and <code>delta.reasoning</code> (streaming); inline <code>&lt;think&gt;</code> blocks are extracted
            automatically
          </li>
          <li>
            <strong>Sampling &amp; controls</strong> — <code>temperature</code>, <code>top_p</code>,{" "}
            <code>max_tokens</code>, <code>stop</code>, <code>seed</code>, <code>response_format</code>,{" "}
            <code>reasoning_effort</code> pass through to the upstream model
          </li>
          <li>
            <strong>OpenAI error format</strong> — upstream failures map to OpenAI-style error JSON (401/402/429/502/504)
          </li>
        </ul>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 18, borderBottom: "1px solid #1e2430", paddingBottom: 8 }}>Quick start (curl)</h2>
        <pre>{`curl http://localhost:3000/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}</pre>
        <p style={{ color: "#9aa4b2", fontSize: 14 }}>
          Tools: add <code>&quot;tools&quot;</code> with JSON-schema function definitions. Reasoning: pick a model like{" "}
          <code>infron:deepseek/deepseek-r1</code>.
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 18, borderBottom: "1px solid #1e2430", paddingBottom: 8 }}>Models</h2>
        <p style={{ color: "#9aa4b2", fontSize: 14 }}>
          <code>GET /v1/models</code> returns the authoritative list. Any vendor-qualified Puter id
          (e.g. <code>openai:openai/gpt-4o-mini</code>, full catalog at{" "}
          <a href="https://api.puter.com/puterai/chat/models">api.puter.com/puterai/chat/models</a>) also passes
          through. Common aliases:
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {MODELS.map((m) => (
            <code key={m} style={{ background: "#11151f", border: "1px solid #1e2430", borderRadius: 6, padding: "3px 8px", fontSize: 12 }}>
              {m}
            </code>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 18, borderBottom: "1px solid #1e2430", paddingBottom: 8 }}>Environment variables</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#9aa4b2" }}>
              <th style={{ padding: "6px 12px 6px 0" }}>Variable</th>
              <th style={{ padding: "6px 12px 6px 0" }}>Required</th>
              <th style={{ padding: "6px 0" }}>Purpose</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["PUTER_API_KEY", "yes", "Puter auth token (puter.com/dashboard → Create token)"],
              ["PUTER_MODE", "no", "driver (default, free user-pays) or official (paid plans)"],
              ["PUTER_API_BASE", "no", "Override the Puter API base URL"],
              ["GATEWAY_API_KEY", "no", "When set, clients must send Authorization: Bearer <key>"],
              ["PUTER_TIMEOUT_MS", "no", "Upstream timeout (default 120000)"],
            ].map(([k, r, d]) => (
              <tr key={k} style={{ borderTop: "1px solid #1e2430" }}>
                <td style={{ padding: "8px 12px 8px 0" }}>
                  <code>{k}</code>
                </td>
                <td style={{ padding: "8px 12px 8px 0", color: r === "yes" ? "#f7768e" : "#9aa4b2" }}>{r}</td>
                <td style={{ padding: "8px 0", color: "#c3cad5" }}>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer style={{ color: "#5b6472", fontSize: 13, borderTop: "1px solid #1e2430", paddingTop: 16 }}>
        Not affiliated with Puter or OpenAI. Upstream:{" "}
        <a href="https://docs.puter.com/AI/chat/">docs.puter.com/AI/chat</a>
      </footer>
    </main>
  );
}
