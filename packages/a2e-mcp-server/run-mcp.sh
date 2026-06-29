#!/bin/bash
# Launcher for the A2E MCP server, designed to be invoked by LM Studio (Windows)
# via:  wsl.exe -d Ubuntu -e /home/administrador/product/packages/a2e-mcp-server/run-mcp.sh
#
# IMPORTANT: this script is invoked with a plain bash (no -l / no sourcing of
# .bashrc or .profile), so NOTHING writes to stdout except the MCP JSON-RPC
# transport. All diagnostics go to stderr. Do NOT add console.log / echo here.

export PATH=/home/administrador/.hermes/node/bin:/home/administrador/product/node_modules/.bin:$PATH
export A2E_API_BASE="${A2E_API_BASE:-http://localhost:8080}"
# A2E_API_KEY optional: if product-api runs with API_KEYS enabled, export it here,
# e.g.: export A2E_API_KEY=your-key

cd /home/administrador/product/packages/a2e-mcp-server
exec node --import tsx src/server.ts
