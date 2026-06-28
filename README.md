# Producto A2E (Agent to Execution) — README maestro

**Qué es:** un motor API-only (sin UI) donde un **agente compone y ejecuta workflows** reutilizando código validado (pieces de Activepieces), **sin escribir código**. Implementación de referencia del protocolo A2E.

**Marca:** Automators.work · **Namespace:** `@automators` · **Licencia:** MIT (deriva de Activepieces MIT — ver `NOTICE.md`).

**Ubicación del código:** `~/product` (WSL, ext4 — el engine solo corre ahí). Monorepo AP de origen en `~/ap`.

---

## Setup / Build

Requisitos: **bun** (AP fija `bun@1.3.3`), **node >= 20**, **git**, **npm**, ~6 GB libres y ~4 min para el `bun install` de Activepieces.

La ruta del monorepo de Activepieces es parametrizable via la variable `AP_REPO` (default `$HOME/ap`); todos los build scripts (`build-engine.mjs`, `build-piece*.mjs`, `gen-*.ts`, `load-one-piece.mjs`) la leen de ahí. El tag de AP fijado es **`0.85.4`** (override con `AP_TAG`).

Un solo paso:

```bash
bash scripts/setup.sh
```

Esto: clona Activepieces @ `0.85.4` en `$AP_REPO` si no existe · `bun install` en AP si falta `node_modules` · `npm install` en el producto (workspaces) si falta · build del engine -> `packages/engine-adapter/dist/engine.cjs` · build de las pieces demo (`piece-json`, `piece-echo-auth`, `piece-hook`). Al terminar imprime `SETUP OK` y la ruta del `engine.cjs`.

Arrancar la API después:

```bash
cd packages/product-api && npm start        # http://localhost:8080
```

Smoke (verifica build + ejecución end-to-end):

```bash
cd packages/product-api && npm run smoke
```

---

## 1. Premisa A2E

> El agente no escribe código. Escribe workflows que componen código ya validado (pieces). La corrección vive en las primitivas validadas y el runtime; la creatividad del agente, en la composición.

Spec completa: `ESPECIFICACION-A2E.md`.

---

## 2. Estado — feature matrix (todo verificado)

| Capacidad | Componente | Estado |
|---|---|---|
| Componer acciones (pieces reales) | engine-adapter + flow-builder | ✅ |
| Secuencia (encadenar pasos) | flow-builder `chainSteps` | ✅ |
| Condición (router, 24 operadores) | flow-builder `buildRouterStep` | ✅ |
| Iteración (loop sobre items) | flow-builder `buildLoopStep` | ✅ |
| Paso de datos entre pasos `{{step.output}}` | engine-adapter `collectStepNames` | ✅ |
| Validación de inputs del agente | flow-builder `validateActionInput` | ✅ |
| Credenciales por referencia (vault cifrado) | backend-mock `Vault` (AES-256-GCM) | ✅ |
| Descubrimiento OKF (sin RAG) — **710 conectores** | okf-generator + full-catalog | ✅ |
| Ejecución reactiva — polling con cron real | trigger-runtime `cron.ts` | ✅ |
| Ejecución reactiva — webhooks | product-api `/webhooks/:id` | ✅ |
| Dedup con cursor durable | trigger-runtime `FileCursorStore` | ✅ |
| API HTTP del producto | product-api | ✅ |

**Pendiente (opcional, compliance):** escaneo SCA (ScanCode/FOSSA) sobre el set final de pieces a comercializar.

---

## 3. Arquitectura de integración (Camino A — validado)

El engine de Activepieces se **bundlea con esbuild** (`build-engine.mjs` → `dist/engine.cjs`) aliando `@activepieces/*` a `~/ap/packages/*/src`, y se **importa in-process**. SIN socket, SIN fork, SIN isolated-vm (solo pieces, sin code node).

- `flowExecutor.execute({action, executionState, constants})` ejecuta el flow.
- `triggerHookOperation.execute(...)` ejecuta hooks de trigger (TEST/RUN/ON_ENABLE).
- Connections/store/files: el engine los pide por HTTP a `internalApiUrl` → **backend-mock** (vault + KV + files).

Detalle técnico y mecanismo del piece-loader: `ANEXO-ARQUITECTURA-MOTOR-API.md`.

---

## 4. Paquetes (`~/product/packages`)

| Paquete | Rol |
|---|---|
| `okf-generator` | `generateOkfCatalog(pieces)` → catálogo OKF (markdown+frontmatter); muestra todas las actions |
| `flow-builder` | `buildFlowFromRequest`, `buildPieceStep`, `buildRouterStep`, `buildLoopStep`, `connectionRef`, `validateActionInput` |
| `backend-mock` | `Vault` (cifrado), `MemoryStore`, `MemoryFileStore`, `createServer` → endpoints `v1/worker/*` que el engine consume |
| `engine-adapter` | `build-engine.mjs` (bundle), `execute-flow.cjs`, `build-piece.mjs` (bundler genérico de pieces), `gen-full-catalog.ts`+`load-one-piece.mjs`, `full-catalog/` (710 pieces), pieces propias (`@automators/piece-*`) |
| `trigger-runtime` | `dedup.ts` (`selectNewItems`), `poll-runner.ts` (`startReactivePoll` + modo cron), `cron.ts` (`nextRun`), `cursor-store.ts` (Memory/File) |
| `product-api` | servidor HTTP (node:http) que ata todo; arranca el mock interno |

---

## 5. API HTTP (product-api)

```
GET  /catalog                      → índice OKF de pieces (descubrimiento)
GET  /pieces/:name                 → OKF de una piece (actions/triggers/props)
POST /execute                      → { steps:[...] } → ejecuta; valida inputs (400 si inválido)
POST /triggers                     → registra trigger POLLING reactivo → { triggerId }
GET  /triggers/:id                 → estado + fired log
DELETE /triggers/:id               → detiene el loop
POST /webhook-triggers             → registra trigger WEBHOOK → { triggerId, webhookUrl }
GET/DELETE /webhook-triggers/:id   → estado / baja
POST /webhooks/:triggerId          → ingress: el evento dispara el flow
```

### Contrato del agente (ExecuteRequest)
```json
{ "steps": [
  { "name":"s1", "pieceName":"@automators/piece-x", "pieceVersion":"1.0.0",
    "actionName":"do", "input":{...}, "connection":{"name":"mi-cred"} },
  { "name":"r1", "type":"router", "branches":[{ "name":"b", "condition":{"firstValue":"a","operator":"TEXT_EXACTLY_MATCHES","secondValue":"a"}, "steps":[...] }], "fallback":{...} },
  { "name":"l1", "type":"loop", "items":"{{ [1,2,3] }}", "steps":[...] }
] }
```
El agente solo emite **referencias** de credenciales (`{{connections.<name>}}`), nunca secretos.

---

## 6. Cómo arrancar (en WSL)

```bash
export PATH=/home/administrador/.hermes/node/bin:$HOME/product/node_modules/.bin:$PATH
export AP_EXECUTION_MODE=UNSANDBOXED AP_PAUSED_FLOW_TIMEOUT_DAYS=1
cd ~/product/packages/product-api && npx tsx src/index.ts   # API en :8080, mock interno
```
`AP_CUSTOM_PIECES_PATHS` (separado por `:`) apunta a los roots de pieces que el loader debe resolver.

---

## 7. Legal (ver `ATRIBUCION-Y-LICENCIAS.md`)

- `LICENSE` (MIT): `Copyright (c) 2026 Automators.work` + `Copyright (c) 2020-2024 Activepieces Inc.` (obligación MIT — preservado).
- `NOTICE.md`: procedencia; **no** se incorpora código `ee/` (Enterprise).
- `DEP-AUDIT.md`: deps de las pieces bundleadas — **100% permisivas** (MIT/Apache/ISC/BSD), sin copyleft.
- Marca: namespace `@automators`; nada de nombre/logos "Activepieces".
- Pendiente al comercializar: auditar deps de cada conector concreto + (opcional) SCA.

---

## 8. Método de construcción

PM (Claude) **dirige y verifica**; toda la **implementación la escriben devs efímeros GLM-5.2** (`ollama launch claude`): lógica pura bajo **gate CCDD** determinista en Windows (tests congelados + complejidad bajo budget), e **integración acoplada al engine ejecutada por GLM en WSL**. Claude no escribe código de producción ni ejecuta.

---

## 9. Documentos del proyecto (`D:\Repo\activepieces\`)

- `AUDITORIA-LICENCIAS-ACTIVEPIECES.md` — qué de Activepieces es MIT-reutilizable vs Enterprise.
- `ANEXO-ARQUITECTURA-MOTOR-API.md` — arquitectura del motor, Camino A, piece-loader.
- `ESPECIFICACION-A2E.md` — el protocolo A2E (premisa, garantías, contrato, enforcement).
- `ATRIBUCION-Y-LICENCIAS.md` — LICENSE/NOTICE, checklist legal, método de auditoría de deps.
- `README-A2E-PRODUCTO.md` — este documento.
