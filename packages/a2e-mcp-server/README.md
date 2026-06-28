# @a2e/mcp-server

A2E MCP server (pattern B of A2E). Exposes the **product-api** endpoints as a
bounded set of MCP **tools** so an agentic LLM (Claude with MCP, etc.) can
operate A2E: compose + execute workflows, discover pieces, list credential
**references** (never secrets), and query knowledge / runs.

The tool surface **is** the protocol. The agent **cannot** write code and
**cannot** see secrets — `list_connections` returns only `externalId`,
`displayName`, `pieceName`, `type`, which the agent references inside step
inputs as `{{connections.<externalId>}}`.

## Tools (9)

| Tool | Product-api | Purpose |
|---|---|---|
| `retrieve_catalog` | `GET /catalog/retrieve?q=&budget=` | Discover relevant pieces bounded by a token budget |
| `get_piece` | `GET /pieces/:name` | Full detail of one piece (actions/props) |
| `list_connections` | `GET /connections?projectId=` | Credential references (NO secrets) |
| `execute_workflow` | `POST /execute` | Compose + run piece steps now (no code step) |
| `save_workflow` | `POST /workflows` | Persist a named workflow |
| `list_workflows` | `GET /workflows` | List saved workflows |
| `run_saved_workflow` | `POST /workflows/:id/execute` | Re-run a saved workflow by id |
| `query_knowledge` | `GET /knowledge` | Operational learnings with freshness |
| `query_runs` | `GET /runs` | Run history |

## Run

```bash
# from the repo root (WSL)
export PATH=/home/administrador/.hermes/node/bin:$HOME/product/node_modules/.bin:$PATH
tsx packages/a2e-mcp-server/src/server.ts
```

Configuration via env:

- `A2E_API_BASE` — product-api base URL (default `http://localhost:8080`).
- `A2E_API_KEY` — if set, sent as `X-API-Key` (only needed when the product-api
  has `API_KEYS` configured).

## Register in an MCP client

### Claude Desktop / Claude Code (`mcpServers` config)

Point `command` at `tsx` and pass the server path. Set the env vars under `env`.

```jsonc
{
  "mcpServers": {
    "a2e": {
      "command": "node",
      "args": [
        "/home/administrador/.hermes/node/bin/tsx",
        "/home/administrador/product/packages/a2e-mcp-server/src/server.ts"
      ],
      "env": {
        "A2E_API_BASE": "http://localhost:8080",
        "A2E_API_KEY": ""
      }
    }
  }
}
```

> `tsx` runs the TypeScript directly (no build step). If you prefer a built
> binary, `tsc` the package and point `command`/`args` at `node dist/server.js`.

### Generic MCP client (stdio)

Any stdio MCP client: spawn the process above, then send `initialize` →
`tools/list` → `tools/call`. Transport is STDIO (`StdioServerTransport`).

## Smoke

```bash
tsx packages/a2e-mcp-server/smoke-mcp.mjs
```

Part 1 drives the tool handlers directly against a live product-api
(`retrieve_catalog`, `execute_workflow`, `list_connections` with a secret-leak
assertion). Part 2 wires the server to an in-memory MCP client and calls
`listTools()` + `retrieve_catalog` over the transport.

## Layout

```
src/client.ts   # thin HTTP client for product-api (base + X-API-Key)
src/tools.ts     # 9 A2E tools: name/description/inputSchema(JSON)/handler
src/server.ts    # low-level Server + StdioServerTransport (the binary)
smoke-mcp.mjs    # e2e smoke
```