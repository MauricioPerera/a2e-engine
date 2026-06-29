// A2E MCP server (pattern B of A2E): exposes a bounded set of tools over the
// product-api so an agentic LLM can operate A2E without writing code or
// seeing secrets. Runs over STDIO with the official MCP SDK.
//
// We use the low-level Server (not the high-level McpServer) so each tool's
// inputSchema is a plain JSON Schema object (no Zod), exactly as defined in
// tools.ts. StdioServerTransport wires it to stdin/stdout.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools, handlerByName, listToolDescriptors } from "./tools.js";

const SERVER_NAME = "a2e-mcp-server";
const SERVER_VERSION = "0.1.0";

export function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: "A2E: compose+execute workflows, discover pieces, list connection references (no secrets), query knowledge and runs. You cannot write code." },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: listToolDescriptors() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    const handler = handlerByName[name];
    if (!handler) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `unknown tool: ${name}` }],
      };
    }
    // handler already returns { content, isError? } and never throws.
    return await handler(args);
  });

  return server;
}

// Exposed for the smoke test (part 2): the registry the server registers, so
// we can assert the server object has the tools without spawning a process.
export { tools };

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so stdout stays clean for the MCP protocol.
  console.error(`[a2e-mcp-server] listening on stdio (${tools.length} tools)`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}