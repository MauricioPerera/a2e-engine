# Producto A2E (Agent to Execution) — README maestro

**Qué es:** un motor API-only (sin UI) donde un **agente compone y ejecuta workflows** reutilizando código validado (pieces de Activepieces), **sin escribir código**. Implementación de referencia del protocolo A2E.

**Marca:** Automators.work · **Namespace:** `@automators` · **Licencia:** MIT (deriva de Activepieces MIT — ver `NOTICE.md`).

**Ubicación del código:** `~/product` (WSL, ext4 — el engine solo corre ahí). Monorepo AP de origen en `~/ap`.

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
| **Run history** (OKF+git, audit/reproduce) | run-logger | ✅ |
| **Registro de workflows** (guardar/descubrir/re-ejecutar, versionado) | workflow-registry | ✅ |
| **Base de conocimiento** (freshness TTL + vigencia humana) | knowledge-base | ✅ |
| **Provider `okf_catalog`** (catálogo acotado a budget, sin RAG) | okf-retriever | ✅ |
| **Provider `connection_refs`** (referencias del vault, sin fuga) | connection-provider | ✅ |
| **Contrato CCDD** (slots firmados + gate CI L1/L2) | `contract/` + `.github/workflows/ccdd-gate.yml` | ✅ |
| **L3 — runtime assembly** (contrato→contexto acotado+guardrails) | context-assembler + `POST /agent/context` | ✅ |
| **Backend durable** (vault/store/files sobreviven reinicio) | backend-mock `Durable*` (env `DATA_DIR`) | ✅ |
| Auth por API-key (en progreso) | product-api (env `API_KEYS`) | 🔄 |

**Stack de governance (4 capas):** OKF+git (catálogo·flows·runs·conocimiento) · CCDD (contrato firmado + gate) · freshness (TTL) · vigencia (attestation humana). Ver `ESPECIFICACION-A2E.md`, `ESTANDAR-SEGURIDAD-CATALOGOS-A2E.md`, `CONTRATO-CCDD-A2E.md`.

**Pendiente (opcional):** escaneo SCA sobre el set final de pieces; backend durable a DB/Redis/S3 (hoy file-backed); L3 parseo real de `context.yaml`.

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
| `run-logger` | `run-store.ts` — cada ejecución como `run-<id>.md` OKF + commit git; endpoints `/runs` |
| `workflow-registry` | `workflow-store.ts` — workflows como OKF+git (guardar/descubrir/re-ejecutar, versionado) |
| `knowledge-base` | `knowledge-store.ts` — aprendizajes OKF+git con freshness TTL + vigencia (`attestEntry`); bucle run-failure→stub |
| `okf-retriever` | `retrieve(pieces, query, {maxTokens})` — provider `okf_catalog`: catálogo acotado a budget, estructural (sin RAG) |
| `connection-provider` | `renderConnectionRefs` — provider `connection_refs`: referencias del vault, nunca secretos |
| `context-assembler` | `assembleContext(slots, {totalBudget})` + guardrails — L3 runtime assembly |
| `product-api` | servidor HTTP (node:http) que ata todo; arranca el mock interno; auth por `API_KEYS` |

**Fuera de `packages/`:** `contract/` (contrato CCDD firmado: context.yaml + slots + `policies/*.md` OKF + expected-hashes.json) · `.github/workflows/ccdd-gate.yml` (gate L1/L2).

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
POST /webhooks/:triggerId          → ingress: el evento dispara el flow (no requiere API-key)
GET  /catalog/retrieve?q=&budget=  → subconjunto del catálogo acotado a budget (provider okf_catalog)
GET  /connections?projectId=&format= → referencias de credenciales (nunca secretos)
POST /workflows · GET /workflows · GET /workflows/:id · POST /workflows/:id/execute  → registro de workflows
GET  /runs · GET /runs/:date/:runId                    → run history (OKF+git)
POST /knowledge · GET /knowledge · GET /knowledge/:id · POST /knowledge/:id/attest   → base de conocimiento
POST /agent/context                → L3: ensambla el contexto del agente según el contrato CCDD
```

Todas las rutas (salvo `POST /webhooks/:id`) exigen `X-API-Key` cuando `API_KEYS` está configurado; sin esa env, modo dev abierto.

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
