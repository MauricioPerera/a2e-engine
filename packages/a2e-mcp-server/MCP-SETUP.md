# A2E MCP Server — Setup for LM Studio (over wsl.exe / stdio)

The A2E MCP server exposes a bounded set of 11 tools over the product-api so a
tool-calling LLM can compose + execute A2E workflows, discover pieces, list
connection references (no secrets), and query knowledge/runs — without writing
code or seeing secrets.

It speaks **STDIO**: LM Studio spawns it as a child process and talks JSON-RPC
over its stdin/stdout. Therefore **stdout of the server process must be
exclusively the MCP JSON-RPC transport** — any log/banner on stdout breaks the
connection. All server diagnostics already go to **stderr** (`console.error`).

## 11 tools

`retrieve_catalog`, `get_piece`, `list_connections`, `execute_workflow`,
`save_workflow`, `list_workflows`, `run_saved_workflow`, `query_knowledge`,
`query_runs`, `retrieve_pieces`, `retrieve_actions`.

## Prerequisites

### 1. product-api must be running on :8080

The MCP tools call the product-api over HTTP. Start it **before** invoking any
tool (listTools does NOT need it; callTool does):

```bash
cd ~/product/packages/product-api
npx tsx src/index.ts   # listens on http://localhost:8080
```

- If product-api runs with API keys enabled, export the key in
  `run-mcp.sh` (`export A2E_API_KEY=your-key`) or in the LM Studio mcp.json
  `env` block.
- Override the base URL with `A2E_API_BASE` (default `http://localhost:8080`).

### 2. The LM Studio model must support tool-calling

Only models with native function/tool-calling will drive the MCP tools
correctly (e.g. Qwen2.5 instruct tool variants, Llama 3.x tool variants, etc.).
A plain chat model will see the tool list but never call them.

## Launcher

`run-mcp.sh` is the entry point LM Studio invokes. It is a plain `bash` script
(no `-l`, no sourcing of `.bashrc`/`.profile`) so **nothing pollutes stdout**:

```bash
#!/bin/bash
export PATH=/home/administrador/.hermes/node/bin:/home/administrador/product/node_modules/.bin:$PATH
export A2E_API_BASE="${A2E_API_BASE:-http://localhost:8080}"
cd /home/administrador/product/packages/a2e-mcp-server
exec node --import tsx src/server.ts
```

Make sure it is executable (`chmod +x run-mcp.sh`).

## mcp.json snippet for LM Studio

Add this server to LM Studio's MCP config (Tools tab → "Edit mcp.json"):

```json
{
  "mcpServers": {
    "a2e": {
      "command": "wsl.exe",
      "args": [
        "-d", "Ubuntu",
        "-e", "/home/administrador/product/packages/a2e-mcp-server/run-mcp.sh"
      ]
    }
  }
}
```

Notes:
- `-d Ubuntu` selects the WSL distro; adjust if yours is named differently
  (`wsl.exe -l -q` to list).
- `-e` runs the script directly with a plain bash, **not** `-l`, so no login
  shell init writes to stdout.
- If you need to pass `A2E_API_KEY` / `A2E_API_BASE`, add an `"env"` block to
  the server object.

## Verifying the handshake (no LM Studio needed)

`handshake-test.mjs` in this package spawns `bash run-mcp.sh` via
`StdioClientTransport` (exactly what LM Studio does) and runs `initialize` +
`listTools`. It also raw-captures the first stdout byte to prove there is no
noise before the JSON-RPC frame.

```bash
cd ~/product/packages/a2e-mcp-server
node handshake-test.mjs
```

Expected: `ALL PASS` — 11 tools listed, first stdout byte is `0x7B` (`{`),
`serverInfo` = `a2e-mcp-server` `0.1.0`. The line
`[a2e-mcp-server] listening on stdio (11 tools)` is printed to **stderr** and is
harmless.

> `listTools` works without product-api. `callTool` requires product-api on
> :8080 (see Prerequisites).