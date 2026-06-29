# A2E MCP server (stdio) — adaptador MCP hacia el product-api de A2E.
FROM node:22-slim
LABEL org.opencontainers.image.title="A2E MCP Server" \
      org.opencontainers.image.description="MCP server adapter: connects an agent to an A2E engine to discover pieces and execute workflows over them." \
      org.opencontainers.image.source="https://github.com/MauricioPerera/a2e-engine" \
      org.opencontainers.image.url="https://hub.docker.com/r/mauricioperera/a2e-mcp-server" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.authors="Mauricio Perera"
RUN npm install -g @rckflr/a2e-mcp-server@0.1.0 && npm cache clean --force
ENTRYPOINT ["a2e-mcp-server"]
