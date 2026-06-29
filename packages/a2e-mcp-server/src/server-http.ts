// A2E MCP server, HTTP transport (Streamable HTTP, stateless) with Bearer auth.
// Sibling of server.ts (stdio). Same tool registry, same createServer(), so the
// surface is identical whether a client connects over stdio (local) or HTTP
// (remote/VPS). The stdio entry in server.ts is untouched.

import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createMcpServer } from "./server.js";

const MCP_PORT = parseInt(process.env.MCP_PORT ?? "8089", 10);
const MCP_BIND = process.env.MCP_BIND ?? "127.0.0.1";
const A2E_MCP_TOKEN = process.env.A2E_MCP_TOKEN;

if (!A2E_MCP_TOKEN) {
  console.error(
    "[a2e-mcp-http] FATAL: A2E_MCP_TOKEN env var is required (Bearer token for HTTP auth).",
  );
  process.exit(1);
}

type NodeReq = Parameters<Parameters<typeof createServer>[0]>[0];
type NodeRes = ReturnType<typeof createServer>;

// 401 JSON for any request missing/mismatching the Bearer token.
function unauthorized(res: NodeRes): void {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function methodNotAllowed(res: NodeRes): void {
  res.writeHead(405, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless: POST only)." },
      id: null,
    }),
  );
}

// Collect the request body (UTF-8) and parse as JSON. Returns undefined if no
// body or non-JSON; the SDK accepts parsedBody=undefined.
function readBody(req: NodeReq): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

const httpServer = createServer(async (req, res) => {
  // Auth gate: applies to every method/path. Bearer must match exactly.
  const auth = req.headers["authorization"] ?? "";
  const expected = "Bearer " + A2E_MCP_TOKEN;
  if (auth !== expected) {
    return unauthorized(res);
  }

  // Stateless Streamable HTTP: only POST carries JSON-RPC. GET/DELETE have no
  // meaning without a server-held session, so 405 them (matches the SDK's own
  // stateless example).
  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }

  const parsedBody = await readBody(req);

  // One fresh McpServer + transport per request: no session, no state.
  const mcp = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    console.error("[a2e-mcp-http] error handling request:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
      );
    }
  } finally {
    // Tear down per-request objects when the response finishes so we don't
    // leak transports across requests in a long-lived process.
    res.on("close", () => {
      transport.close().catch(() => {});
      mcp.close?.();
    });
  }
});

httpServer.listen(MCP_PORT, MCP_BIND, () => {
  // Log to stderr only; stdout stays clean.
  console.error("[a2e-mcp-http] listening on " + MCP_BIND + ":" + MCP_PORT);
});