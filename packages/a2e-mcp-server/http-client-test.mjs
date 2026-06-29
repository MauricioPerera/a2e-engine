// Local verification harness for the HTTP transport of a2e-mcp-server.
// Uses the official SDK client (StreamableHTTPClientTransport) with a Bearer
// header, performs initialize + tools/list, then a raw-fetch 401 probe, then an
// optional tools/call against the live product-api.
//
// Run from this package dir:
//   A2E_MCP_TOKEN=testtok MCP_PORT=8089 node http-client-test.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ListToolsResultSchema,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOKEN = process.env.A2E_MCP_TOKEN ?? "testtok";
const PORT = process.env.MCP_PORT ?? "8089";
const BASE = `http://127.0.0.1:${PORT}/`;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

function line(s) {
  console.log(s);
}

async function probe401() {
  // Raw POST with NO Authorization header -> must be 401 + {"error":"unauthorized"}.
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw-probe", version: "0.0.0" },
      },
    }),
  });
  const text = await res.text();
  line(`[401-probe] status=${res.status} body=${text}`);
  if (res.status !== 401) {
    line(`[401-probe] FAIL: expected 401, got ${res.status}`);
    process.exitCode = 1;
  } else {
    line("[401-probe] OK: 401 without Bearer");
  }
}

async function main() {
  line(`[client] connecting to ${BASE} with Bearer token`);

  const transport = new StreamableHTTPClientTransport(new URL(BASE), {
    requestInit: {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
    },
  });

  const client = new Client(
    { name: "a2e-http-harness", version: "0.0.0" },
    { capabilities: {} },
  );

  // initialize handshake happens inside connect().
  await client.connect(transport);
  line(`[client] connected. sessionId=${transport.sessionId ?? "<none/stateless>"}`);

  const toolsResult = await client.request(
    { method: "tools/list", params: {} },
    ListToolsResultSchema,
  );
  const names = toolsResult.tools.map((t) => t.name);
  line(`[client] tools/list -> count=${names.length}`);
  line(`[client] tools: ${names.join(", ")}`);
  if (names.length !== 11) {
    line(`[client] FAIL: expected 11 tools, got ${names.length}`);
    process.exitCode = 1;
  } else {
    line("[client] OK: 11 tools");
  }

  // Optional: callTool retrieve_catalog (requires a live product-api on :8080).
  if (process.env.SKIP_CALL_TOOL !== "1") {
    try {
      const callRes = await client.request(
        {
          method: "tools/call",
          params: { name: "retrieve_catalog", arguments: { query: "slack" } },
        },
        CallToolResultSchema,
      );
      const preview = callRes.content?.[0]?.text ?? "<no text>";
      const snippet =
        typeof preview === "string" ? preview.slice(0, 200) : String(preview);
      line(`[client] tools/call retrieve_catalog isError=${callRes.isError ?? false}`);
      line(`[client] preview: ${snippet.replace(/\n/g, " ")}`);
    } catch (e) {
      line(`[client] tools/call retrieve_catalog threw: ${e?.message ?? e}`);
    }
  }

  await client.close();
  line("[client] closed.");

  line("--- 401 probe ---");
  await probe401();
}

main().catch((e) => {
  console.error("[client] FATAL:", e);
  process.exit(1);
});