# A2E engine (product-api): descubrir/componer/ejecutar workflows sobre pieces validadas.
FROM node:22-slim
LABEL org.opencontainers.image.title="A2E Engine" \
      org.opencontainers.image.description="Agent-first workflow engine: discover validated pieces, compose declarative JSON workflows, and execute them. The agent never writes code." \
      org.opencontainers.image.source="https://github.com/MauricioPerera/a2e-engine" \
      org.opencontainers.image.url="https://hub.docker.com/r/mauricioperera/a2e-engine" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.authors="Mauricio Perera"
WORKDIR /app
COPY . .
RUN npm install --no-audit --no-fund && npm cache clean --force
ENV AP_EXECUTION_MODE=UNSANDBOXED \
    PORT=8088 \
    MOCK_PORT=3997 \
    BIND_ADDR=0.0.0.0 \
    DATA_DIR=/data \
    DATABASE=/data/a2e.db
VOLUME /data
EXPOSE 8088
WORKDIR /app/packages/product-api
CMD ["npx","tsx","src/index.ts"]
