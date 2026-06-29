# DEPLOY — a2e-engine en VPS

Deploy reproducible del motor A2E (API-only, sobre partes MIT de Activepieces)
a un VPS Ubuntu 24.04. Este doc describe el deploy **real** que corre hoy en
`https://a2e.ardf.dev` y `https://a2e.ardf.dev/mcp`.

> **Sin secretos aquí.** Todas las credenciales son placeholders
> (`<SET_API_KEY>`, `<SET_MCP_TOKEN>`). Nunca commitear tokens reales.

---

## 1. Target

- **VPS:** Ubuntu 24.04 LTS, Node 22, npm.
- **Dominio:** `a2e.ardf.dev` (cert wildcard `*.ardf.dev`).
- **Servicios (pm2):**
  1. `product-api` — HTTP JSON API (entry `packages/product-api/src/index.ts`).
     Expuesto en `https://a2e.ardf.dev/` vía nginx.
  2. `a2e-mcp-http` — MCP sobre Streamable HTTP con Bearer auth
     (`packages/a2e-mcp-server/src/server-http.ts`). Expuesto en
     `https://a2e.ardf.dev/mcp` vía nginx.

Ambos bindean por defecto a `127.0.0.1` (ver `BIND_ADDR` / `MCP_BIND`); nginx
termina TLS y hace de reverse proxy. **No se exponen puertos directamente.**

---

## 2. Artefactos prebuilt (se envían al VPS, NO se commitean)

El repo no contiene los bundles generados (están en `.gitignore`:
`dist/`, `full-catalog/`, `custom-pieces*/dist/`, `node_modules/`). En el VPS
**no hay monorepo Activepieces** (`~/ap`), por lo que todo lo que necesita
esbuild se construye **en la máquina de build** y se envía ya compilado.

Construir en una máquina que SÍ tiene el monorepo AP (`~/ap` con
`node_modules` y esbuild):

```bash
cd ~/product
# 1) Engine bundle (CJS) — requiere ~/ap
node packages/engine-adapter/build-engine.mjs
#    -> packages/engine-adapter/dist/engine.cjs

# 2) Catálogo completo de pieces
node packages/engine-adapter/build-community.mjs
#    -> packages/engine-adapter/full-catalog/

# 3) Pieces custom (json, echo, hook, tick...) — cada uno con su node_modules
node packages/engine-adapter/build-piece.mjs        <pieceDir> ./custom-pieces
node packages/engine-adapter/build-piece-echo.mjs
node packages/engine-adapter/build-piece-hook.mjs
#    -> packages/engine-adapter/custom-pieces/...
```

### Qué enviar al VPS

Sync al VPS (ej. con `rsync` o `scp`), **excluyendo** lo que no debe viajar:

```bash
rsync -av --delete \
  --exclude='node_modules' \
  --exclude='**/node_modules' \
  --exclude='.git' \
  --exclude='.data' \
  --exclude='*.db' --exclude='*.db-*' \
  --exclude='vault.json' --exclude='store.json' \
  --exclude='*.log' \
  ~/product/  user@vps:/opt/a2e/
```

**Incluir sí:**
- `packages/` (código fuente + los `dist/` y `full-catalog/` generados arriba).
- `packages/engine-adapter/custom-pieces/` con el `node_modules` **interno de
  cada piece** (los bundles CJS los `require` en runtime). Por eso el exclude
  anterior es `node_modules` del workspace; el `node_modules` dentro de cada
  piece bajo `custom-pieces/.../node_modules/<piece>/` sí va.
- `package.json` y `package-lock.json` raíz.

**Excluir sí:** `node_modules` del workspace, `.git`, cualquier dato durable
(`.data/`, `*.db`, `vault.json`, `store.json`), logs.

> Nota: `build-piece.mjs` hace **lazy** el `require` de esbuild (dentro de
> `buildPiece`, no top-level), así que importar el módulo en el VPS no crashea
> aunque esbuild no esté presente. El build de pieces **no** se hace en el VPS
> (ver §6).

---

## 3. Setup en el VPS

```bash
# Node 22 (NodeSource) si no está
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# pm2
sudo npm install -g pm2

# Código + artefactos ya copiados en /opt/a2e
cd /opt/a2e
npm install            # instala deps de runtime del workspace (no dev)
```

---

## 4. Variables de entorno

`product-api` (`packages/product-api/src/index.ts`):

| Var | Default | Descripción |
|---|---|---|
| `PORT` | `8080` | Puerto del API. |
| `MOCK_PORT` | (auto) | Puerto del backend mock interno. |
| `BIND_ADDR` | `127.0.0.1` | Interfaz de bind. **Seguro por defecto.** |
| `AP_EXECUTION_MODE` | `UNSANDBOXED` | Modo de ejecución del engine. En VPS sin bwrap: `UNSANDBOXED`. |
| `DATA_DIR` | — | Directorio de datos durables. |
| `DATABASE` | — | Cadena/Path del backend durable (SQLite). |
| `API_KEYS` | — | Claves de API. Formato `<key>:default` (ver abajo). |

`API_KEYS` — lista separada por comas de `<key>:<scope>`, ej:
`<SET_API_KEY>:default`. El API valida el Bearer/Header contra estas claves.

`a2e-mcp-http` (`packages/a2e-mcp-server/src/server-http.ts`):

| Var | Default | Descripción |
|---|---|---|
| `MCP_PORT` | `8089` | Puerto del MCP HTTP. |
| `MCP_BIND` | `127.0.0.1` | Interfaz de bind. **Seguro por defecto.** |
| `A2E_MCP_TOKEN` | — | **Requerido.** Bearer token para `/mcp`. Sin él el proceso no arranca. |

> **`BIND_ADDR`/`MCP_BIND` por defecto `127.0.0.1`** — el servicio sólo escucha
> en loopback; nginx (en la misma máquina) es el único que lo alcanza. Para
> exponerlo hay que pasar por el reverse proxy, no cambiar el bind a `0.0.0.0`.

---

## 5. pm2 — `ecosystem.config.cjs`

Plantilla con **placeholders** — sustituir `<SET_API_KEY>` y `<SET_MCP_TOKEN>`
en el VPS (o inyectarlas desde el secret manager). **No commitear valores reales.**

```js
// /opt/a2e/ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'product-api',
      cwd: '/opt/a2e',
      script: 'packages/product-api/src/index.ts',
      interpreter: 'npx',
      interpreter_args: 'tsx',
      env: {
        NODE_ENV: 'production',
        PORT: '8080',
        BIND_ADDR: '127.0.0.1',
        AP_EXECUTION_MODE: 'UNSANDBOXED',
        DATA_DIR: '/opt/a2e/.data',
        DATABASE: '/opt/a2e/.data/a2e.db',
        API_KEYS: '<SET_API_KEY>:default',
      },
      max_restarts: 10,
      autorestart: true,
    },
    {
      name: 'a2e-mcp-http',
      cwd: '/opt/a2e',
      script: 'packages/a2e-mcp-server/src/server-http.ts',
      interpreter: 'npx',
      interpreter_args: 'tsx',
      env: {
        NODE_ENV: 'production',
        MCP_PORT: '8089',
        MCP_BIND: '127.0.0.1',
        A2E_MCP_TOKEN: '<SET_MCP_TOKEN>',
      },
      max_restarts: 10,
      autorestart: true,
    },
  ],
};
```

Arrancar:

```bash
cd /opt/a2e
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup        # habilita arranque en boot
```

---

## 6. nginx — reverse proxy + TLS

Cert wildcard `*.ardf.dev` (Lets Encrypt / el CA que se use) ya instalado.
`/etc/nginx/sites-available/a2e.ardf.dev`:

```nginx
# Upstreams locales (bind 127.0.0.1, ver BIND_ADDR/MCP_BIND)
upstream a2e_api { server 127.0.0.1:8080; }
upstream a2e_mcp { server 127.0.0.1:8089; }

server {
    listen 443 ssl http2;
    server_name a2e.ardf.dev;

    ssl_certificate     /etc/letsencrypt/live/ardf.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ardf.dev/privkey.pem;

    # MCP Streamable HTTP bajo /mcp
    location /mcp {
        proxy_pass         http://a2e_mcp;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        # Streamable HTTP: el cliente puede pedir text/event-stream
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 600s;
    }

    # API
    location / {
        proxy_pass         http://a2e_api;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

# redirect 80 -> 443
server {
    listen 80;
    server_name a2e.ardf.dev;
    return 301 https://$host$request_uri;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/a2e.ardf.dev /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 7. Verificación del deploy

```bash
# En el VPS (loopback):
ss -ltn | grep -E '8080|8089'    # ambos en 127.0.0.1

# API externo:
curl https://a2e.ardf.dev/health

# MCP externo con Bearer (Streamable HTTP):
curl -X POST https://a2e.ardf.dev/mcp \
  -H "Authorization: Bearer <SET_MCP_TOKEN>" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'

# MCP sin token -> 401
curl -X POST https://a2e.ardf.dev/mcp -o /dev/null -s -w '%{http_code}\n'
```

---

## 8. LO QUE NO SE DESPLIEGA

**`/sources/build` (build de pieces no confiables) NO se despliega en el VPS.**
Ese flujo construye bundles de pieces de terceros/no confiables y requiere:

- El **monorepo Activepieces** (`~/ap` con `node_modules` y `esbuild`).
- **`bwrap`** (bubblewrap) para el sandbox T2 — no disponible/seguro en el VPS
  de producción.

El build de pieces se hace **offline en la máquina de build** (§2) y los
bundles resultantes se envían como artefactos prebuilt. El VPS sólo ejecuta
`UNSANDBOXED` contra el catálogo y los pieces ya construidos.

---

## 9. Sync repo ↔ VPS

Los cambios de código viven en el repo (`git push`). Los artefactos prebuilt
(`dist/`, `full-catalog/`, `custom-pieces/`) se regeneran en la máquina de
build y se sync al VPS con el `rsync` de §2. No hay rebuild en el VPS.