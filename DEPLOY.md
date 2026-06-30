# DEPLOY — a2e-engine (self-host)

Deploy reproducible del motor A2E (API-only, sobre partes MIT de Activepieces).

Hay **dos vías** de self-host, en orden de recomendación:

1. **Imagen pública (recomendada).** `docker run mauricioperera/a2e-engine`. No requiere monorepo Activepieces ni build. Es la vía del quickstart del `README.md`.
2. **Build-from-source en VPS (avanzado).** Artefactos prebuilt generados offline + `pm2` + `nginx`. Es el deploy **real** que corre hoy en `https://a2e.ardf.dev` y `https://a2e.ardf.dev/mcp`. Útil cuando necesitas el flujo **T2** (`/sources/build`, import de pieces no confiables) o control total del runtime.

> **Sin secretos aquí.** Todas las credenciales son placeholders (`<SET_API_KEY>`, `<SET_MCP_TOKEN>`, `<SET_ADMIN_TOKEN>`). Nunca commitear tokens reales.

---

## 1. Imagen pública (self-host recomendado)

La imagen [`mauricioperera/a2e-engine`](https://hub.docker.com/r/mauricioperera/a2e-engine) (`:0.1.0`, `:latest`) empaqueta el **product-api + engine + catálogo + custom-pieces + vault** (runtime confiable). **NO** incluye el flujo T2 `/sources/build` (build de pieces no confiables): requiere `bwrap` + toolchain Activepieces (~3GB). Ese flujo se ejecuta offline en la máquina de build y los artefactos resultantes se cargan como prebuilt (ver §4).

```bash
docker run -d --name a2e-engine \
  -p 8088:8088 \
  -e API_KEYS=<SET_API_KEY>:default \
  -e ADMIN_TOKEN=<SET_ADMIN_TOKEN> \
  -v a2e-data:/data \
  mauricioperera/a2e-engine
```

- API en `http://localhost:8088`. Estado durable (vault, store, SQLite) en el volumen `a2e-data` (`/data`).
- `API_KEYS` sin setear → **auth abierta** (solo dev). En producción setéala.
- `ADMIN_TOKEN` sin setear → **canal admin deshabilitado** (404 en `/admin/*` y `/sources/*`). Setéalo solo si necesitas cargar credenciales vía admin o importar pieces T2.
- La imagen fija `BIND_ADDR=0.0.0.0` (escucha en todas las interfaces) — usa un reverse proxy o firewall para no exponer el puerto directamente a Internet.

Combínalo con el cliente MCP [`@rckflr/a2e-mcp-server`](https://www.npmjs.com/package/@rckflr/a2e-mcp-server) (npm) o la imagen [`mauricioperera/a2e-mcp-server`](https://hub.docker.com/r/mauricioperera/a2e-mcp-server):

```bash
# stdio (local)
A2E_API_BASE=http://localhost:8088 A2E_API_KEY=<SET_API_KEY> npx @rckflr/a2e-mcp-server

# HTTP (remoto, Bearer) — bin a2e-mcp-http
A2E_MCP_TOKEN=<SET_MCP_TOKEN> MCP_PORT=8089 MCP_BIND=127.0.0.1 a2e-mcp-http
```

### Verificación rápida

```bash
# Catálogo (requiere API key si API_KEYS está seteado):
curl -H "X-API-Key: <SET_API_KEY>" http://localhost:8088/catalog | head

# Admin deshabilitado si no seteaste ADMIN_TOKEN -> 404:
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8088/admin/connections
```

---

## 2. Canal admin (`/admin/connections` + `ADMIN_TOKEN`)

El plano **admin** está separado del plano del **agente**:

- **Agente:** `X-API-Key` (env `API_KEYS`).
- **Admin:** `X-Admin-Token` (env `ADMIN_TOKEN`). **Distinto token** de las API keys — el `X-API-Key` del agente **nunca** autoriza `/admin/*`.

`POST /admin/connections` carga una credencial en el vault cifrado. La respuesta **solo ecoa la referencia** (nombre/piece/auth), nunca el secreto — el agente la usa vía `{{connections['name']}}` sin verla.

```bash
curl -X POST http://localhost:8088/admin/connections \
  -H "X-Admin-Token: <SET_ADMIN_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"name":"my-slack","pieceName":"@activepieces/piece-slack","credentials":{ /* ... */ }}'
```

Sin `ADMIN_TOKEN` seteado → todo `/admin/*` y `/sources/*` devuelve **404 admin disabled** (la superficie desaparece). Un deploy que no necesite operator-access puede dejarlo unset.

> `/sources/discover` y `/sources/build` (import T2) se gatean con el **mismo** `X-Admin-Token`, no con la API key del agente (ver §4).

---

## 3. Variables de entorno

`product-api` (`packages/product-api/src/index.ts`, `auth.ts`):

| Var | Default | Descripción |
|---|---|---|
| `API_KEYS` | — | Claves de API. Formato `<key>:<projectId>` separadas por comas. Sin setear → auth abierta (dev). |
| `PORT` | `8080` (source) / `8088` (imagen) | Puerto del API. |
| `MOCK_PORT` | `3997` (imagen) | Puerto del backend mock interno. |
| `BIND_ADDR` | `127.0.0.1` (source) / `0.0.0.0` (imagen) | Interfaz de bind. |
| `AP_EXECUTION_MODE` | `UNSANDBOXED` | Modo de ejecución del engine. En VPS sin bwrap: `UNSANDBOXED`. |
| `DATA_DIR` | `/data` (imagen) | Directorio de datos durables (vault, store, db). |
| `DATABASE` | `/data/a2e.db` (imagen) | Path del backend durable (SQLite). |
| `ADMIN_TOKEN` | — | Token del canal admin (`/admin/*`, `/sources/*`). Sin setear → admin deshabilitado. |

`a2e-mcp-http` (`packages/a2e-mcp-server/src/server-http.ts`):

| Var | Default | Descripción |
|---|---|---|
| `MCP_PORT` | `8089` | Puerto del MCP HTTP. |
| `MCP_BIND` | `127.0.0.1` | Interfaz de bind. **Seguro por defecto.** |
| `A2E_MCP_TOKEN` | — | **Requerido.** Bearer token para `/mcp`. Sin él el proceso no arranca. |

Cliente MCP (stdio / `client.ts`): `A2E_API_BASE` (URL del motor, default `http://localhost:8080`) y `A2E_API_KEY`.

> **`BIND_ADDR`/`MCP_BIND` por defecto `127.0.0.1`** en source — el servicio sólo escucha en loopback; nginx (en la misma máquina) es el único que lo alcanza. La **imagen Docker** pone `BIND_ADDR=0.0.0.0` porque el contenedor se publica detrás de un proxy/firewall.

---

## 4. Import T2 de pieces (`/sources/*`) — NO en la imagen

`/sources/discover` + `/sources/build` importan pieces de **repos no confiables** (T2). Requiere:

- El **monorepo Activepieces** (`~/ap` con `node_modules` y `esbuild`).
- **`bwrap`** (bubblewrap) para el sandbox T2 (sin red, FS confinado, límites CPU/mem).
- `npm install --ignore-scripts` para deps de terceros.

Por eso **no se incluye en la imagen Docker** (la toolchain AP pesa ~3GB y `bwrap` no es seguro en un contenedor L). Es capacidad de un **deploy avanzado en VPS** (vía build-from-source, §5) o de una **máquina de build** dedicada: el build T2 se hace offline, los bundles resultantes se cargan como prebuilt al catálogo del motor.

Ambos endpoints se gatean con `X-Admin-Token` (`ADMIN_TOKEN`), **no** con la API key del agente — un agente con `X-API-Key` nunca los alcanza.

**Capacidades declaradas en el build:** `/sources/build` lee el `piece-manifest.json` de cada piece (si existe) y lo pasa al `piece-sdk` para la validación. Así se respetan las capacidades **declaradas**: si la piece declara `executesCode` (ej. pieces de comando como `a2e-pieces-cmd`), el finding `executes-code` viaja como **warn no bloqueante** (`ok:true`) **en la respuesta del build** — el operador VE al importar la piece que ésta ejecuta comandos. Si ejecuta código **sin** declarar la capacidad → error `undeclared-executes-code` (`ok:false`, el build falla). Ídem para `egress`/`env`/`file`. El análisis estático es señal (evadible por ofuscación); la contención real del código no confiable la da el **sandbox bwrap** de este mismo flujo.

---

## 5. Build-from-source en VPS (avanzado)

> Esta vía no usa la imagen pública. Usa artefactos **prebuilt** generados en una máquina con el monorepo AP, sincronizados al VPS. Es el deploy real de `a2e.ardf.dev`.

### 5.1 Target

- **VPS:** Ubuntu 24.04 LTS, Node 22, npm.
- **Dominio:** `a2e.ardf.dev` (cert wildcard `*.ardf.dev`).
- **Servicios (pm2):**
  1. `product-api` — HTTP JSON API (entry `packages/product-api/src/index.ts`). Expuesto en `https://a2e.ardf.dev/` vía nginx.
  2. `a2e-mcp-http` — MCP sobre Streamable HTTP con Bearer auth (`packages/a2e-mcp-server/src/server-http.ts`). Expuesto en `https://a2e.ardf.dev/mcp` vía nginx.

Ambos bindean por defecto a `127.0.0.1` (`BIND_ADDR` / `MCP_BIND`); nginx termina TLS y hace de reverse proxy. **No se exponen puertos directamente.**

### 5.2 Artefactos prebuilt (se envían al VPS, NO se commitean)

El repo no contiene los bundles generados (`.gitignore`: `dist/`, `full-catalog/`, `custom-pieces*/dist/`, `node_modules/`). En el VPS **no hay monorepo AP** (`~/ap`), por lo que todo lo que necesita esbuild se construye **en la máquina de build** y se envía ya compilado.

Construir en una máquina que SÍ tiene el monorepo AP (`~/ap` con `node_modules` y esbuild):

```bash
cd ~/product
# 1) Engine bundle (CJS) — requiere ~/ap
node packages/engine-adapter/build-engine.mjs
#    -> packages/engine-adapter/dist/engine.cjs

# 2) Catálogo completo de pieces
node packages/engine-adapter/build-community.mjs
#    -> packages/engine-adapter/full-catalog/

# 3) Pieces custom (json, echo, hook, textkit...) — cada uno con su node_modules
node packages/engine-adapter/build-piece.mjs        <pieceDir> ./custom-pieces
node packages/engine-adapter/build-piece-echo.mjs
node packages/engine-adapter/build-piece-hook.mjs
#    -> packages/engine-adapter/custom-pieces/...
```

Sync al VPS (ej. con `rsync`), **excluyendo** lo que no debe viajar:

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

**Incluir sí:** `packages/` (código fuente + los `dist/` y `full-catalog/` generados arriba); `packages/engine-adapter/custom-pieces/` con el `node_modules` **interno de cada piece** (los bundles CJS los `require` en runtime); `package.json` y `package-lock.json` raíz.

**Excluir sí:** `node_modules` del workspace, `.git`, cualquier dato durable (`.data/`, `*.db`, `vault.json`, `store.json`), logs.

> Nota: `build-piece.mjs` hace **lazy** el `require` de esbuild (dentro de `buildPiece`, no top-level), así que importar el módulo en el VPS no crashea aunque esbuild no esté presente. El build de pieces **no** se hace en el VPS (salvo T2 — ver §4).

### 5.3 Setup en el VPS

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

### 5.4 pm2 — `ecosystem.config.cjs`

Plantilla con **placeholders** — sustituir `<SET_API_KEY>`, `<SET_MCP_TOKEN>` y `<SET_ADMIN_TOKEN>` en el VPS (o inyectarlas desde el secret manager). **No commitear valores reales.**

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
        ADMIN_TOKEN: '<SET_ADMIN_TOKEN>',
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

### 5.5 nginx — reverse proxy + TLS

Cert wildcard `*.ardf.dev` (Lets Encrypt / el CA que se use) ya instalado. `/etc/nginx/sites-available/a2e.ardf.dev`:

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

### 5.6 Verificación del deploy

```bash
# En el VPS (loopback):
ss -ltn | grep -E '8080|8089'    # ambos en 127.0.0.1

# API externo (catálogo — endpoint real):
curl -H "X-API-Key: <SET_API_KEY>" https://a2e.ardf.dev/catalog | head

# MCP externo con Bearer (Streamable HTTP):
curl -X POST https://a2e.ardf.dev/mcp \
  -H "Authorization: Bearer <SET_MCP_TOKEN>" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'

# MCP sin token -> 401
curl -X POST https://a2e.ardf.dev/mcp -o /dev/null -s -w '%{http_code}\n'

# Admin deshabilitado si ADMIN_TOKEN unset -> 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://a2e.ardf.dev/admin/connections
```

### 5.7 Sync repo ↔ VPS

Los cambios de código viven en el repo (`git push`). Los artefactos prebuilt (`dist/`, `full-catalog/`, `custom-pieces/`) se regeneran en la máquina de build y se sync al VPS con el `rsync` de §5.2. No hay rebuild en el VPS (salvo T2 — ver §4).