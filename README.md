# A2E — Agent to Execution

**Qué es:** un motor **API-only** (sin UI) donde un **agente compone y ejecuta workflows** reutilizando código validado (pieces de Activepieces), **sin escribir código**. Implementación de referencia del protocolo A2E. El humano pasa de **autor a auditor**: la creatividad del agente vive en la composición; la corrección, en las primitivas validadas y el runtime.

**Marca:** Automators.work · **Namespace:** `@automators` · **Licencia:** MIT (deriva de Activepieces MIT — ver `NOTICE.md`).

> **Premisa:** el agente no escribe código; compone workflows declarativos (JSON) sobre piezas ya validadas y los ejecuta. Reusa paquetes MIT de Activepieces (motor de ejecución + framework de pieces). **No es un fork**; es un motor nuevo que aprovecha esas partes.

Spec completa: `docs/ESPECIFICACION-A2E.md`.

---

## Quickstart (self-host en 2 comandos)

```bash
# 1) MOTOR: product-api + engine + catálogo + custom-pieces + vault (runtime confiable)
docker run -d --name a2e-engine \
  -p 8088:8088 \
  -e API_KEYS=mi-key:default \
  -v a2e-data:/data \
  mauricioperera/a2e-engine

# 2) CLIENTE MCP: conecta tu agente al motor (stdio)
A2E_API_BASE=http://localhost:8088 A2E_API_KEY=mi-key npx @rckflr/a2e-mcp-server
```

- El primer comando levanta el **motor** (API HTTP en `:8088`, auth por `API_KEYS`, estado durable en el volumen `a2e-data`).
- El segundo es el **cliente MCP** que el agente (LM Studio, Claude, etc.) usa para descubrir pieces, componer y ejecutar workflows — sin escribir código ni ver secretos.
- Sin `API_KEYS` el motor queda en **auth abierta (solo dev)**. En producción, setea `API_KEYS=clave:scope,otra:scope`.

> ¿Prefieres el MCP sobre **HTTP** (remoto, con Bearer)? → §Integración con LM Studio. ¿Deploy en VPS con nginx/pm2 o build T2 de pieces? → `DEPLOY.md`.

---

## Distribución pública

| Artefacto | Dónde | Qué es |
|---|---|---|
| **Imagen del motor** | Docker Hub [`mauricioperera/a2e-engine`](https://hub.docker.com/r/mauricioperera/a2e-engine) (`:0.1.0`, `:latest`) | product-api + engine + catálogo + custom-pieces + vault. Vía recomendada de self-host. |
| **Cliente MCP (npm)** | npm [`@rckflr/a2e-mcp-server`](https://www.npmjs.com/package/@rckflr/a2e-mcp-server) | bins `a2e-mcp-server` (stdio) y `a2e-mcp-http` (Streamable HTTP). |
| **Cliente MCP (imagen)** | Docker Hub [`mauricioperera/a2e-mcp-server`](https://hub.docker.com/r/mauricioperera/a2e-mcp-server) | misma imagen del cliente MCP, lista para `docker run`. |
| **PR al catálogo MCP de Docker** | [docker/mcp-registry#4104](https://github.com/docker/mcp-registry/pull/4104) | registro oficial Docker MCP (pendiente de review). |
| **Repo** | [github.com/MauricioPerera/a2e-engine](https://github.com/MauricioPerera/a2e-engine) | código fuente (público). |

> El `docker build` desde un clon limpio **no funciona** sin generar antes los artefactos prebuilt (`engine.cjs`, `full-catalog/`, `custom-pieces/` — están gitignored y requieren el monorepo Activepieces). Por eso la vía recomendada es la **imagen publicada**, no el build-from-source. Detalle en `DEPLOY.md`.

---

## Arquitectura (componentes reales en `packages/`)

El engine de Activepieces se **bundlea con esbuild** (`engine-adapter/build-engine.mjs` → `dist/engine.cjs`) aliando `@activepieces/*` a `~/ap/packages/*/src`, y se **ejecuta in-process** via `flowExecutor` (`execute-flow.cjs`). **Sin socket, sin fork, sin isolated-vm** — solo pieces, sin nodo `code`. Catálogo de **710 conectores** (`full-catalog/`, gitignored).

Detalle técnico y mecanismo del piece-loader: `docs/ANEXO-ARQUITECTURA-MOTOR-API.md`.

| Paquete | Rol |
|---|---|
| `engine-adapter` | `build-engine.mjs` (bundle esbuild → `dist/engine.cjs`), `execute-flow.cjs` (flowExecutor in-process), `build-piece.mjs` (bundler genérico), `gen-full-catalog.ts`+`load-one-piece.mjs`, `full-catalog/` (710 pieces), pieces propias (`@automators/piece-*`) |
| `okf-retriever` | descubrimiento por **OKF** (Open Knowledge Format: markdown+frontmatter+index, navegación estructural, **sin vectores/RAG**). Retriever de **tres niveles** acotado por budget: nivel piece (índice) + nivel actions dentro de la piece + nivel flujos validados que usan cada action (sección "flows que la usan", índice inverso del `workflow-registry` adjunto por el handler). Medido: volcado naive ~435K tokens vs provider ~3K (reducción ~124x) → la saturación de contexto **no es riesgo real**. Provider `okf_catalog`. |
| `okf-generator` | `generateOkfCatalog(pieces)` → catálogo OKF (markdown+frontmatter); muestra todas las actions |
| `backend-mock` | credenciales en **Vault cifrado (AES-256-GCM)** + SQLite durable (`node:sqlite`). El motor los pide por HTTP a `internalApiUrl` → backend-mock (vault + KV + files). Sobrevive a reinicios (`DATA_DIR`). |
| `flow-builder` | construye el flow AP desde el request del agente (`buildFlowFromRequest`, `buildPieceStep`, `buildRouterStep` con 24 operadores, `buildLoopStep`, `connectionRef`, `validateActionInput`). Incluye **`sanitize-steps`** (auto-sanitiza nombres de paso inválidos + reescribe refs) y **validación pre-flight** (`validate-workflow.ts` + `validate-workflow-context.ts`: step names, refs entre pasos, existencia piece/action, props requeridas). |
| `context-assembler` | `assembleContext(slots, {totalBudget})` + guardrails — **L3 runtime assembly**: ensambla el contexto del agente según el contrato CCDD (no-secrets, output-schema, connection-refs). |
| `connection-provider` | `renderConnectionRefs` — provider `connection_refs`: referencias del vault, **nunca secretos** |
| `contract/` (fuera de `packages/`) | contrato CCDD firmado: `context.yaml` (budget) L1/L2/L3, slots + `policies/*.md` OKF + expected-hashes.json. Governance del contexto que se arma para el agente. Gate CI L1/L2 en `.github/workflows/ccdd-gate.yml`. |
| `piece-sdk` | validar + testear pieces (`smoke-validate-piece.mjs`, `smoke-test-piece.mjs`); crear pieces propias en **catálogos aislados**. |
| `piece-source-manager` | clonar pieces de un repo (total/parcial) o crear propias (`discover.ts`: fase segura SIN ejecutar ni bundlear — solo clona/lee + parsea). Build de pieces **no confiables en SANDBOX bwrap** (`build-source.ts`: sin red, FS confinado, límites CPU/mem) — bundle **y** extracción de metadata dentro del sandbox. |
| `run-logger` | `run-store.ts` — cada ejecución como `run-<id>.md` OKF + commit git; endpoints `/runs` (audit/reproduce). |
| `workflow-registry` | `workflow-store.ts` — workflows como OKF+git (guardar/descubrir/re-ejecutar, versionado). |
| `knowledge-base` | `knowledge-store.ts` — aprendizajes OKF+git con freshness TTL + vigencia humana (`attestEntry`); bucle run-failure→stub. |
| `trigger-runtime` | `dedup.ts`, `poll-runner.ts` (`startReactivePoll` + modo cron), `cron.ts` (`nextRun`), `cursor-store.ts` (Memory/File durable). |
| `product-api` | servidor HTTP (`node:http`). Puerto default `:8080` en source; la **imagen Docker** expone `:8088`. Mock backend interno `:3997`. Ver §API HTTP. |
| `a2e-mcp-server` | servidor **MCP** (stdio y Streamable HTTP, `@modelcontextprotocol/sdk`) con **12 tools** que envuelven los endpoints del product-api. Ver §Integración con LM Studio. |

**Stack de governance (4 capas):** OKF+git (catálogo·flows·runs·conocimiento) · CCDD (contrato firmado + gate) · freshness (TTL) · vigencia (attestation humana). Ver `docs/ESPECIFICACION-A2E.md`, `docs/ESTANDAR-SEGURIDAD-CATALOGOS-A2E.md`, `docs/CONTRATO-CCDD-A2E.md`.

---

## Features (verificado)

- **Descubrimiento OKF de 3 niveles (sin RAG)**, acotado por budget — nivel piece (índice) + nivel actions dentro de la piece + nivel **flujos validados que usan cada action**. Descubrimiento **fractal**: piece → action → receta probada que la usa; el agente, buscando una action útil, descubre ahí mismo un flujo reusable. Catálogo de 710 conectores. (Ver §Descubrimiento de 3 niveles.)
- **Ejecución multi-step** con datos encadenados `{{step.output}}` (refs inter-paso resueltas por el engine).
- **Pieces propias vía SDK** (`piece-sdk`: `validatePiece` + `testPieceAction`) en catálogos aislados. Ejemplo: `@automators/piece-textkit` (action `reverse_text`). `get_piece` y `retrieve_actions` unen **demoPieces + full-catalog** → toda piece custom es descubrible **y** ejecutable.
- **Credenciales por referencia** `{{connections['name']}}` (vault cifrado AES-256-GCM; el agente nunca ve secretos) + **canal admin**: `POST /admin/connections` con header `X-Admin-Token` (env `ADMIN_TOKEN`), **separado del plano del agente**. Sin `ADMIN_TOKEN` → admin deshabilitado (404).
- **Import T2** de pieces de repos no confiables: `/sources/discover` + `/sources/build` (gated por `X-Admin-Token`), sandbox **bwrap** (sin red, FS confinado), `npm install --ignore-scripts` de deps de terceros. **NO incluido en la imagen Docker** (requiere bwrap + toolchain AP de ~3GB): es capacidad de un deploy avanzado (ver `DEPLOY.md`).
- **Validación pre-flight** antes de ejecutar (step names, refs inter-paso, existencia piece/action, props requeridas).
- **Triggers reactivos**: polling con cron real + webhooks (`POST /webhooks/:triggerId`, sin API-key — el triggerId es el bearer), dedup con cursor durable.
- **Run history** (OKF+git, audit/reproduce), **registro de workflows** (guardar/descubrir/re-ejecutar, versionado), **base de conocimiento** (freshness TTL + vigencia humana).
- **Reuso de flujos validados** (`retrieve_flows`): el agente descubre workflows guardados y los reutiliza en vez de re-componer a ciego — ahorra el costo de razonar/iterar. Dos gates de confianza: **VALIDEZ** (cada flujo se re-valida contra el catálogo ACTUAL de pieces → caza staleness: una piece que cambió o desapareció invalida el flujo) y **SALUD** de los runs enlazados por `workflowId` ("N runs, X% ok, último status"; sin runs → untested). Loop: `retrieve_flows` → si válido + sano → `run_saved_workflow` (barato); si no → componer → ejecutar → `save_workflow` (el catálogo crece/mejora). Enlaza con el bucle run-failure→knowledge. **El MISMO gate de validez+salud alimenta el nivel 3** del descubrimiento (§Descubrimiento de 3 niveles): las recetas válidas+sanas se adjuntan al detalle de cada action.
- **L3 — runtime assembly**: `POST /agent/context` ensambla el contexto del agente según el contrato CCDD (no-secrets, output-schema, connection-refs, budget).
- **Backend durable**: vault/store/files sobreviven reinicios (`DATA_DIR`).
- **Auth por API key** (`X-API-Key` o `Authorization: Bearer`); modo dev abierto si `API_KEYS` no está seteado.

### Descubrimiento de 3 niveles (fractal)

El descubrimiento OKF tiene **tres niveles** que el agente recorre sin cambiar de tool:

| Nivel | Qué descubre | Endpoint / tool | Componente |
|---|---|---|---|
| 1 — piece | pieces relevantes + **nombres** de sus actions (hints, sin props) | `retrieve_pieces` · `GET /catalog/pieces` | okf-retriever |
| 2 — action | las actions DE UNA piece, filtradas por query, con props | `retrieve_actions` · `GET /catalog/pieces/:name/actions` | okf-retriever |
| 3 — receta | flujos guardados **válidos + sanos** que USAN esa action (top-K más sanos) | se engancha al detalle de cada action del nivel 2 | workflow-registry `buildFlowsByAction` + product-api `handlePieceActions` |

El **nivel 3** es un índice inverso `action → flows` (`buildFlowsByAction` en `workflow-registry/src/retrieve-flows.ts`): para cada flujo **válido** (los inválidos/stale se excluyen — no son receta confiable), y por cada step `(pieceName, actionName)` de su árbol, se indexa bajo `${piece}:${action}`. El handler `handlePieceActions` computa una sola vez el gate de validez+salud — **reusando exactamente el mismo gate de `retrieve_flows`** (`listWorkflowRecords` + runs por `workflowId` + re-validación contra el catálogo actual + `computeFlowHealth`) — y adjunta los top-K flujos a cada action; el render (`renderActionDetail` en `okf-retriever/src/two-level.ts`) añade la sección:

```
flows que la usan:
  - [id] name (validity, health)
```

- **Esparso:** una action sin flujos no añade nada (0 coste) — el render de nivel 2 queda intacto.
- **Acotado por budget:** los flujos viven dentro del bloque de cada action y se recortan vía `estimateTokens` con el mismo `budget` del endpoint.
- **Descubrimiento fractal:** piece → action → receta probada que la usa. El agente, buscando una action útil, descubre ahí mismo un flujo reusable (`run_saved_workflow`).
- **El sistema se abarata con el uso:** cuanto más se usa y se vetan flujos, más recetas válidas indexa el nivel 3 → descubrimiento más rico sin costo extra de contexto.

**Ejemplo verificado** (`packages/product-api/smoke-level3.mjs`): `retrieve_actions(@activepieces/piece-json)` con `q=convert` — el detalle de `convert_text_to_json` trae:

```
flows que la usan:
  - [wf-level3-json] Level3 JSON recipe (valid, 2 runs, 100% ok, last SUCCEEDED)
```

mientras `run_jsonata_query` (otra action de la misma piece, sin receta) **no** trae la sección — esparso, 0 coste.

### Feature matrix

| Capacidad | Componente | Estado |
|---|---|---|
| Componer acciones (pieces reales) | engine-adapter + flow-builder | ✅ |
| Secuencia (encadenar pasos) | flow-builder `chainSteps` | ✅ |
| Condición (router, 24 operadores) | flow-builder `buildRouterStep` | ✅ |
| Iteración (loop sobre items) | flow-builder `buildLoopStep` | ✅ |
| Paso de datos entre pasos `{{step.output}}` | engine-adapter `collectStepNames` | ✅ |
| Validación de inputs del agente | flow-builder `validateActionInput` | ✅ |
| Validación pre-flight (step names, refs, piece/action, props req) | flow-builder `validate-workflow*` + `sanitize-steps` | ✅ |
| Credenciales por referencia (vault cifrado AES-256-GCM) | backend-mock `Vault` | ✅ |
| Canal admin (`/admin/connections`, `X-Admin-Token`) | product-api `auth.ts` | ✅ |
| Import T2 (sandbox bwrap, `/sources/*`) | piece-source-manager | ✅ |
| Descubrimiento OKF (sin RAG) — 710 conectores | okf-generator + full-catalog | ✅ |
| Ejecución reactiva — polling con cron real | trigger-runtime `cron.ts` | ✅ |
| Ejecución reactiva — webhooks | product-api `/webhooks/:id` | ✅ |
| Dedup con cursor durable | trigger-runtime `FileCursorStore` | ✅ |
| API HTTP del producto | product-api | ✅ |
| **Servidor MCP** (12 tools, stdio + HTTP) | a2e-mcp-server | ✅ |
| **Reuso de flujos** (`retrieve_flows`, validez + salud) | workflow-registry + run-logger | ✅ |
| **Descubrimiento fractal — nivel 3** (flujos válidos por action, índice inverso) | workflow-registry `buildFlowsByAction` + okf-retriever | ✅ |
| **Pieces de comando / capacidades declaradas** (`executes-code`) | piece-sdk + piece-source-manager | ✅ |
| **Run history** (OKF+git, audit/reproduce) | run-logger | ✅ |
| **Registro de workflows** (guardar/descubrir/re-ejecutar, versionado) | workflow-registry | ✅ |
| **Base de conocimiento** (freshness TTL + vigencia humana) | knowledge-base | ✅ |
| **Provider `okf_catalog`** (catálogo acotado a budget, sin RAG) | okf-retriever | ✅ |
| **Provider `connection_refs`** (referencias del vault, sin fuga) | connection-provider | ✅ |
| **Contrato CCDD** (slots firmados + gate CI L1/L2) | `contract/` + `.github/workflows/ccdd-gate.yml` | ✅ |
| **L3 — runtime assembly** (contrato→contexto acotado+guardrails) | context-assembler + `POST /agent/context` | ✅ |
| **Catálogos aislados + sandbox bwrap** (build de pieces no confiables) | piece-sdk + piece-source-manager | ✅ |
| **Backend durable** (vault/store/files sobreviven reinicio) | backend-mock `Durable*` (env `DATA_DIR`) | ✅ |
| Auth por API-key | product-api (env `API_KEYS`) | ✅ |

### Pieces de comando / capacidades declaradas

En vez de dar al agente **shell arbitrario**, se le exponen **actions de terminal deterministas y acotadas** (allowlist / acciones específicas) que se ejecutan vía `execFile` **sin shell** → sin inyección de comandos. Deterministas, validables, auditables, composables como un step más del workflow.

El `piece-sdk` trata `executes-code` como una **capacidad declarada y gateada** (no un error duro), igual que `egress`/`env`/`file`:

- Si la piece **declara** `executesCode` en su `piece-manifest.json` → **warn** (`executes-code`, operator-vetted) y `ok:true` (no bloquea el import).
- Si **NO la declara** y el código ejecuta (`child_process`, `spawn`, `eval`, `new Function`, `execSync`…) → **error** `undeclared-executes-code` (`ok:false`).

**Honestidad:** el análisis estático es **señal, no garantía** (evadible por ofuscación). La contención real de código no confiable sigue siendo el **sandbox bwrap del import T2** (`/sources/build`): sin red, FS confinado, límites CPU/mem. La declaración de capacidades hace que el operador **vea** qué hace una piece al importarla.

**Estándar de repos de pieces:** `a2e-pieces-<categoria>`. El primero es **[`a2e-pieces-cmd`](https://github.com/MauricioPerera/a2e-pieces-cmd)** — pieces de comando (shell/git/sqlite) como actions deterministas. Importable vía el flujo T2.

**Pendiente (opcional):** escaneo SCA sobre el set final de pieces; backend durable a DB/Redis/S3 (hoy file-backed); L3 parseo real de `context.yaml`.

---

## API HTTP (`product-api`)

Puerto default `:8080` en source; la **imagen Docker** escucha en `:8088` (ver `Dockerfile`). Auth por **API key** (`X-API-Key` o `Authorization: Bearer <key>`); abierto en dev si `API_KEYS` no está configurado. Todas las rutas salvo `POST /webhooks/:id` exigen API key cuando `API_KEYS` está seteado.

```
GET  /catalog                                  → índice OKF de pieces (descubrimiento)
GET  /catalog/retrieve?q=&budget=&mode=        → subconjunto del catálogo acotado a budget (provider okf_catalog)
GET  /catalog/pieces?q=&budget=                → lista de pieces acotada a budget
GET  /catalog/pieces/:name/actions?q=&budget=  → actions de una piece (recorta a esa piece del full-catalog) + NIVEL 3: adjunta flujos válidos+sanos que usan cada action ("flows que la usan")
GET  /pieces/:name                             → OKF de una piece (actions/triggers/props)
POST /execute                                  → { steps:[...] } → ejecuta; validación pre-flight (400 si inválido)
POST /workflows/validate                       → valida un workflow sin ejecutarlo
POST /workflows · GET /workflows · GET /workflows/:id · POST /workflows/:id/execute  → registro de workflows
GET  /flows/retrieve?q=&budget=                    → reuso: workflows guardados relevantes, con gates de VALIDEZ (re-valida vs catálogo actual) y SALUD (runs por workflowId)
GET  /runs · GET /runs/:date/:runId            → run history (OKF+git)
GET  /connections?projectId=&piece=&format=&budget=  → referencias de credenciales (nunca secretos)
POST /admin/connections                        → canal ADMIN: carga credencial en el vault (header X-Admin-Token)
POST /knowledge · GET /knowledge · GET /knowledge/:id · POST /knowledge/:id/attest  → base de conocimiento
POST /agent/context                            → L3: ensambla el contexto del agente según el contrato CCDD
POST /agent/run                                → ejecuta un agente con contexto ensamblado
POST /sources/discover                         → T2: lista pieces de un repo/ruta (fase segura, sin ejecutar) — X-Admin-Token
POST /sources/build                            → T2: build de pieces (sandbox bwrap para no confiables) — X-Admin-Token
POST /triggers · GET /triggers/:id · DELETE /triggers/:id          → triggers POLLING reactivos
POST /webhook-triggers · GET/DELETE /webhook-triggers/:id         → triggers WEBHOOK
POST /webhooks/:triggerId                      → ingress: el evento dispara el flow (no requiere API-key)
```

`AP_EXECUTION_MODE` debe estar seteada (`UNSANDBOXED`) — se fija **antes** del `require` del engine.

### Contrato del agente (ExecuteRequest)
```json
{ "steps": [
  { "name":"s1", "pieceName":"@activepieces/piece-json", "pieceVersion":"0.7.2",
    "actionName":"convert_text_to_json", "input":{"text":"{\"a\":5,\"b\":9}"} },
  { "name":"s2", "pieceName":"@activepieces/piece-json", "pieceVersion":"0.7.2",
    "actionName":"run_jsonata_query",
    "input":{"json":"{{s1.output}}", "query":"a + b"} }
] }
```
El agente solo emite **referencias** de credenciales (`{{connections['name']}}`), nunca secretos.

### Variables de entorno (motor)

| Var | Default | Descripción |
|---|---|---|
| `API_KEYS` | — | Claves de API. Formato `<key>:<projectId>` separadas por comas. Sin setear → auth abierta (dev). |
| `PORT` | `8080` (source) / `8088` (imagen) | Puerto del API. |
| `MOCK_PORT` | `3997` (imagen) | Puerto del backend mock interno. |
| `BIND_ADDR` | `127.0.0.1` (source) / `0.0.0.0` (imagen) | Interfaz de bind. |
| `DATA_DIR` | `/data` (imagen) | Directorio de datos durables (vault, store, db). |
| `DATABASE` | `/data/a2e.db` (imagen) | Path del backend durable (SQLite). |
| `AP_EXECUTION_MODE` | `UNSANDBOXED` | Modo de ejecución del engine. |
| `ADMIN_TOKEN` | — | Token del canal admin (`/admin/*`, `/sources/*`). Sin setear → admin deshabilitado. |

---

## Integración con LM Studio (MCP)

El paquete `a2e-mcp-server` expone **12 tools** sobre el product-api para que un LLM con tool-calling componga y ejecute workflows A2E, descubra pieces, liste referencias de credenciales (sin secretos) y consulte knowledge/runs — **sin escribir código ni ver secretos**.

**Tools:** `retrieve_catalog`, `retrieve_pieces`, `retrieve_actions` (nivel 2 + **nivel 3**: adjunta al detalle de cada action los flujos válidos+sanos que la usan), `get_piece`, `list_connections`, `execute_workflow`, `save_workflow`, `list_workflows`, `run_saved_workflow`, **`retrieve_flows`** (descubre workflows guardados para reuso, con gates de validez+salud — el mismo gate que alimenta el nivel 3), `query_knowledge`, `query_runs`.

Dos formas de conectarlo:

### A) Remoto — MCP sobre HTTP (Streamable HTTP, Bearer auth)

Levanta el servidor HTTP (`a2e-mcp-http`) detrás de TLS y apunta `mcp.json` con una URL. Útil cuando el agente y el motor no comparten máquina.

```json
{
  "mcpServers": {
    "a2e": {
      "url": "https://TU-MOTOR/mcp",
      "headers": { "Authorization": "Bearer <A2E_MCP_TOKEN>" }
    }
  }
}
```

Servidor: `packages/a2e-mcp-server/src/server-http.ts` (Streamable HTTP). Env: `A2E_MCP_TOKEN` (requerido, Bearer), `MCP_PORT` (default `8089`), `MCP_BIND` (default `127.0.0.1`).

### B) Local — MCP sobre stdio

El cliente npm/Docker, con el motor alcanzable por HTTP:

```bash
A2E_API_BASE=http://localhost:8088 A2E_API_KEY=mi-key npx @rckflr/a2e-mcp-server
```

O tras `wsl.exe` para LM Studio local (ver `packages/a2e-mcp-server/MCP-SETUP.md`):

```json
{
  "mcpServers": {
    "a2e": {
      "command": "wsl.exe",
      "args": ["-d", "Ubuntu", "-e", "/home/administrador/product/packages/a2e-mcp-server/run-mcp.sh"]
    }
  }
}
```

- El modelo debe soportar **tool-calling** nativo (variantes tool de Qwen2.5/Llama 3.x).
- **stdio**: stdout debe ser exclusivamente el transporte JSON-RPC (los diagnósticos van a stderr).
- **Chat nuevo** tras editar `mcp.json` para que LM Studio recargue las tools.

### Verificar el handshake (sin LM Studio)
```bash
cd ~/product/packages/a2e-mcp-server && node handshake-test.mjs
# Esperado: ALL PASS — 12 tools, primer byte stdout = 0x7B ('{'), serverInfo = a2e-mcp-server 0.1.0
```
Detalle: `packages/a2e-mcp-server/MCP-SETUP.md`.

---

## Convención de encadenamiento (lo que el agente debe saber)

- **Referenciar el output de un paso previo** en el input de otro: `{{nombreDelPaso.output}}` (o `.output.campo`). **Nunca** hardcodear un valor que viene de otro paso.
- **Step names** = identificadores `[A-Za-z0-9_]`. Si el agente emite un nombre inválido, `sanitize-steps` lo auto-sanitiza **y reescribe las refs** que lo citan.
- Si una action usa un lenguaje de expresión (**JSONata**): sintaxis nativa (campos como `"a + b"`, **no** `"{{a + b}}"` ni `"$a + b"`).

Estas reglas viajan en las **descripciones de las tools** del MCP, de modo que el agente las descubre al listarlas.

---

## Demostración validada (end-to-end, agente real)

Un modelo **LOCAL de 9B** (`ornith:9b`) vía LM Studio **compuso y ejecutó un workflow de 2 pasos SIN escribir código**:

1. `convert_text_to_json` (piece `@activepieces/piece-json`) sobre el texto `{"a":5,"b":9}` → objeto.
2. `run_jsonata_query` (misma piece) con `json = {{step1.output}}` y `query = "a + b"` → **output `14`**.

Workflow **guardado** para reuso. El agente **descubrió → compuso → encadenó datos reales → ejecutó → persistió**, sin ver secretos, con validación en cada paso.

### Endurecimiento (5 fixes destapados probando con agente real)

1. **Auto-sanitize de step-names** (+ reescritura de refs que los citan) — `flow-builder/src/sanitize-steps.ts`.
2. **Fix env load-order:** `AP_EXECUTION_MODE` seteado **antes** del `require` del engine → las refs inter-paso `{{stepN.output}}` funcionan (`product-api/src/index.ts → configureEngineEnv()`).
3. **Discovery == execution:** la validación de existencia de actions usa el **full-catalog** (unión demo + full-catalog) → toda action discoverable por `retrieve_actions` es ejecutable por `/execute` (antes se rechazaba falsamente).
4. **`retrieve_actions` fallback:** lista todas las actions cuando la query no coincide → **no ciega al agente**.
5. **Validación de props requeridas** desde el full-catalog → finding accionable (`"missing required property X"`) en vez de crash críptico del engine (`actionPropsIndex` con `required:true`).

---

## A2E vs n8n (resumen)

| | n8n | A2E |
|---|---|---|
| Primero | humano (human-first) | agente (agent-first) |
| El agente lo usa vía | MCP de retrofit | MCP nativo (12 tools, por diseño) |
| Nodo `code` | sí (el agente puede escribir código SDK) | **no**, por diseño (JSON declarativo) |
| Governance | débil (hay humano en el loop) | CCDD + sandbox + secrets-by-reference (no hay humano en el loop) |
| UI | sí, es el centro | no existe (API-only); la UI sería un síntoma |

La diferencia no es la UI — es **quién autoriza**: en A2E el humano es **auditor, no autor**, por eso la governance es estructural.

---

## Seguridad (resumen)

- **Secrets-by-reference:** el agente nunca ve secretos; referencias `{{connections['name']}}` resueltas por el vault en ejecución.
- **Vault cifrado** (AES-256-GCM) + SQLite durable; secrets **fuera de git**.
- **Canal admin separado** del plano del agente: `POST /admin/connections` y `/sources/*` se gatean con `X-Admin-Token` (`ADMIN_TOKEN`); el `X-API-Key` del agente **nunca** los autoriza. Sin `ADMIN_TOKEN`, la superficie admin desaparece (404).
- **Catálogos aislados**; build de pieces no confiables en **sandbox bwrap** (sin red, FS confinado, límites CPU/mem) — bundle y extracción de metadata dentro del sandbox.
- **Validación pre-flight** antes de ejecutar (step names, refs inter-paso, existencia piece/action, props requeridas).
- **Auth por API key** (`X-API-Key` o `Bearer`); modo dev abierto si `API_KEYS` no está seteado.

Ver `docs/ESTANDAR-SEGURIDAD-CATALOGOS-A2E.md`.

---

## Legal (ver `docs/ATRIBUCION-Y-LICENCIAS.md`)

- `LICENSE` (MIT): `Copyright (c) 2026 Automators.work` + `Copyright (c) 2020-2024 Activepieces Inc.` (obligación MIT — preservado).
- `NOTICE.md`: procedencia; **no** se incorpora código `ee/` (Enterprise).
- `DEP-AUDIT.md`: deps de las pieces bundleadas — **100% permisivas** (MIT/Apache/ISC/BSD), sin copyleft.
- Marca: namespace `@automators`; nada de nombre/logos "Activepieces".
- Pendiente al comercializar: auditar deps de cada conector concreto + (opcional) SCA.

---

## Método de construcción

PM (Claude) **dirige y verifica**; toda la **implementación la escriben devs efímeros GLM-5.2** (`ollama launch claude`): lógica pura bajo **gate CCDD** determinista en Windows (tests congelados + complejidad bajo budget), e **integración acoplada al engine ejecutada por GLM en WSL**. Claude no escribe código de producción ni ejecuta.

---

## Documentos (`docs/`)

- `docs/ESPECIFICACION-A2E.md` — el protocolo A2E (premisa, garantías, contrato, enforcement).
- `docs/ANEXO-ARQUITECTURA-MOTOR-API.md` — arquitectura del motor, Camino A, piece-loader.
- `docs/ARQUITECTURA-DATOS-GOVERNANCE-A2E.md` — arquitectura de datos y governance.
- `docs/CONTRATO-CCDD-A2E.md` — contrato CCDD firmado (slots, gate L1/L2/L3).
- `docs/ESTANDAR-SEGURIDAD-CATALOGOS-A2E.md` — estándar de seguridad de catálogos.
- `docs/AUDITORIA-LICENCIAS-ACTIVEPIECES.md` — qué de Activepieces es MIT-reutilizable vs Enterprise.
- `docs/ATRIBUCION-Y-LICENCIAS.md` — LICENSE/NOTICE, checklist legal, método de auditoría de deps.
- `docs/README-A2E-PRODUCTO.md` — README de producto.
- `DEPLOY.md` — self-host detallado (imagen pública, VPS/nginx/pm2, canal admin, T2).

Paquete MCP: `packages/a2e-mcp-server/README.md` y `packages/a2e-mcp-server/MCP-SETUP.md`.

---

**Repo:** https://github.com/MauricioPerera/a2e-engine · **Docker:** `mauricioperera/a2e-engine`, `mauricioperera/a2e-mcp-server` · **npm:** `@rckflr/a2e-mcp-server`