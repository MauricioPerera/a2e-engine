# A2E engine (product-api): descubrir/componer/ejecutar workflows sobre pieces validadas.
FROM node:22-slim
WORKDIR /app
# Copia el workspace COMPLETO (incluye artefactos prebuilt: engine.cjs, full-catalog, custom-pieces).
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