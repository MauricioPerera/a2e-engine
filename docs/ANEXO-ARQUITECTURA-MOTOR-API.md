# Anexo técnico — Motor API-only sobre el framework de Activepieces

**Companion de:** `AUDITORIA-LICENCIAS-ACTIVEPIECES.md`
**Fecha:** 2026-06-27
**Objetivo del producto:** API (sin UI) donde un agente (1) lee el catálogo de pieces disponibles, (2) genera un workflow, y (3) lo ejecuta. Descubrimiento de pieces vía **OKF** (Open Knowledge Format), sin vectores/RAG.
**Verificado contra código en:** `D:\Repo\activepieces\activepieces` (todas las afirmaciones validadas a archivo:línea en la auditoría delegada).

---

## Veredicto de viabilidad

**ALCANZABLE sin tocar nada restringido** (ni `packages/ee/`, ni el server CE, ni el worker, ni la UI). Todo MIT.

El único punto de coste real: el engine **no tiene inyección de dependencias**. Connections, store y files están hardcodeados a `fetch()` contra `internalApiUrl`. No se pueden pasar como objetos JS. La solución no es el server CE entero, sino un **mock HTTP local de 4-5 rutas REST** apuntado por `internalApiUrl`.

---

## Arquitectura

```
┌─ TU API (orquestador) ──────────────────────────────────┐
│                                                          │
│  1. Catálogo OKF   ← generado en build-time desde        │
│     PieceMetadata. El agente navega markdown+YAML,       │
│     sin embeddings ni RAG.                               │
│                                                          │
│  2. El agente genera un FlowVersion (JSON)               │
│     schema en @activepieces/shared                       │
│                                                          │
│  3. flowExecutor.execute({action, executionState,        │
│     constants})  ← engine corre IN-PROCESS               │
│         │                                                │
│         └─► fetch() ─► TU MOCK HTTP (4-5 rutas)          │
│             connections / store / files / project        │
└──────────────────────────────────────────────────────────┘
```

**Paquetes que arrastras (todos MIT):**
`pieces-framework`, `core-utils`, `core-piece-types`, `core-formula`, `engine`, `shared`, `pieces-common`.

**Lo que NO usas:** server CE (`api`), worker, sandbox, UI (`web`), y todo `ee/`.

---

## Componente 1 — Catálogo de pieces en OKF

- **Fuente:** `PieceMetadata` (actions, triggers, props con tipo/required/descripción/auth). Extraíble sin ejecutar nada.
- **Generación:** build-time. Escaneas la metadata de tus pieces y emites un árbol OKF:
  - Una carpeta por piece → `frontmatter` (`type`, `tags`, `description`) + body con actions/triggers y schema de props.
  - `index.md` enumera el catálogo (descubrimiento progresivo).
- **Consumo por el agente:** navegación estructural (filesystem + cross-links + index). Sin vectores.
- **Por qué OKF encaja:** es solo una convención markdown+YAML, cero lock-in, legible con `cat`/`git`. Mapea 1:1 con la jerarquía de pieces.
- **Nota:** además del catálogo, expón al agente el **schema del FlowVersion** (cómo es el JSON del workflow) para que pueda generarlo válido.

---

## Componente 2 — Generación del workflow

- El workflow es un **JSON `FlowVersion`**: un `trigger` con un árbol de `nextAction`.
- El schema vive en `@activepieces/shared` → esta capa arrastra el paquete grueso.
- Valida el JSON generado contra el schema de `shared` antes de ejecutar.

---

## Componente 3 — Ejecución (lo crítico)

### 🏆 EJECUCIÓN REAL PROBADA (end-to-end, verificada)
Un flow real se ejecutó a través del engine bundleado in-process: piece `@activepieces/piece-json` action `convert_text_to_json`, input `{"text":"{\"hello\":\"world\"...}"}` → **`verdict: SUCCEEDED`, output `{"hello":"world","n":42}`**. Control negativo: sin el path de pieces, `PieceNotFoundError` desde dentro del engine (prueba que el executor corre de verdad, no fallback).

**Mecanismo del piece-loader (verificado):** para cargar una piece no-dev, el engine busca por cada `AP_CUSTOM_PIECES_PATHS` (subiendo desde `__dirname`) la ruta:
`<path>/pieces/@activepieces/piece-<name>-<version>/node_modules/@activepieces/piece-<name>/package.json` y resuelve su campo `main`.
Para habilitar una piece: bundlear el `src/index.ts` de la community piece con los 7 alias en ESE layout, y exportar `AP_CUSTOM_PIECES_PATHS`. (`piece-loader.ts` → `getPiecePath` → `traverseAllParentFoldersToFindPiece`.)

**Adapter funcionando** (`~/product/packages/engine-adapter`): `build-engine.mjs` (esbuild → `dist/engine.cjs` 1.4mb, expone los 3 símbolos), `execute-flow.cjs` (construye EngineConstants + `FlowExecutorContext.empty({engineApi:{engineToken,internalApiUrl}})` + `flowExecutor.execute` + `finishExecution()`). Con `streamStepProgress=NONE` el progress-reporter cortocircuita; el mock queda disponible para connections/store/files de pieces que los pidan.

### ✅ VALIDADO (Camino A — import in-process, confirmado end-to-end)
Probado empíricamente: el engine se importa y ejecuta **in-process**, sin Socket.IO, sin `fork`, sin `isolated-vm`, con CERO env. `flowExecutor` + `EngineConstants` + `FlowExecutorContext` cargan limpios (`LOADED_OK`/`NO_HANG_EXIT`, exit 0).

**Requisitos de integración confirmados:**
- **Bundlear con esbuild** el entry del handler del engine con los 7 alias a `packages/*/src` (idénticos a `packages/server/engine/esbuild.config.mjs`) y `external: [isolated-vm, utf-8-validate, bufferutil]`. NO funciona ejecutar el `.ts` directo con bun/tsx + tsconfig paths (bun no resuelve los re-exports transitivos `@activepieces/*`).
- Alias: `shared→core/shared/src`, `pieces-framework→pieces/framework/src`, `pieces-common→pieces/common/src`, `core-utils`, `core-piece-types`, `core-formula`, `core-execution` → sus `src`.
- El bundle del engine compila en ~142ms; `bun install` de los 8 paquetes es **~4 min en Linux ext4** (impracticable en Windows NTFS: horas).
- El socket de `main.ts` está gateado tras `if (SANDBOX_ID)`; `flow-executor.ts` no importa `main.ts` ni `worker-socket`. Por eso la carga es limpia.
- **Cabo abierto:** `@ai-sdk/gateway` no se instala; no bloquea la carga, pero verificar en runtime si alguna AI-piece lo requiere (irrelevante para flujos pieces-only sin tools de IA).
- El AI SDK (`ai`) SÍ es runtime en el path de `flowExecutor` (vía `tools/index.ts`) — incluirlo como dependencia.

### Punto de entrada
Llamar **directamente** a:
```
flowExecutor.execute({ action, executionState, constants })
```
(`packages/server/engine/src/lib/handler/flow-executor.ts:68`)

- **Evitar** `flowOperation.execute` (hace `backup()` HTTP) y `flowRunProgressReporter.init()`.
- `action` = cabeza de la cadena (`trigger.nextAction`).
- `executionState` inicial = `FlowExecutorContext.empty(...)` (ver `flow.operation.ts:56`).
- `constants` = instancia de `EngineConstants`.

### EngineConstants — reglas estrictas (validadas en el constructor)
`engine-constants.ts:90-95`:
- `internalApiUrl` **debe terminar en `/`**.
- `publicApiUrl` **debe terminar en `/api/`**.
- `streamStepProgress: NONE` → desactiva el reporting HTTP de progreso (early-return).
- `workerHandlerId: null` + `httpRequestId: null` → desactiva la webhook response.

### Acoplamiento al backend — todo es `fetch()` condicional
Cada llamada solo se dispara **si la piece usa esa capacidad**:

| Endpoint a mockear | Disparado solo si… | Archivo de referencia |
|---|---|---|
| `GET v1/worker/app-connections/{externalId}?projectId=...` | la piece usa credenciales | `connection-resolver.ts:8` |
| `v1/store-entries` (GET/POST/DELETE) | la piece usa `context.store` | `store.ts:7,43,75,110` |
| file upload | la piece usa `context.files.write()` | `file-uploader.ts:16`, `engine-file-api.ts` |
| `GET v1/worker/project` | la piece lee `context.project.externalId` | `engine-constants.ts:224` |
| progress / logs | **solo** si `streamStepProgress=WEBSOCKET` o llamas `backup()` | `flow-run-progress-reporter.ts:40` |

**Para un flujo de pieces sin connections ni store, el mock es casi vacío.**
**Punto que duele:** la mayoría de integraciones reales usan connections → estás obligado a servir `v1/worker/app-connections/{id}` por HTTP. No hay atajo en memoria.

### isolated-vm — evitable
- Solo se carga con steps de tipo **CODE** y `AP_EXECUTION_MODE` en `SANDBOX_CODE_ONLY`/`SANDBOX_CODE_AND_PROCESS` (`code-sandbox.ts:21`).
- Con `AP_EXECUTION_MODE=UNSANDBOXED` y **solo pieces** (sin code steps), isolated-vm **nunca se carga**. Las pieces corren in-process (`piece-executor.ts:156`).

### ✅ DECISIÓN CERRADA — Pieces-only, sin code node
El producto **NO soporta steps de tipo CODE**. El agente solo encadena pieces y mapea datos entre ellas vía `{{step.output}}`. Razones:
- Con pieces bien definidas (actions + props tipadas), las transformaciones se cubren de forma **determinista** (incluida, si hace falta, una piece propia de transform/map).
- Reduce la superficie no-determinista del agente y elimina la dependencia nativa `isolated-vm` (node-gyp).
- Config: `AP_EXECUTION_MODE=UNSANDBOXED`.
- (Code node queda como posible fase futura; no en el alcance inicial.)

---

## ✅ DECISIÓN CERRADA — Credenciales: vault + referencias (modelo n8n, nativo del engine)

El engine **ya impone** el modelo reference-based; el agente no-determinista **nunca toca un secreto**. Verificado en código:

- En el flow JSON, una credencial se referencia como **`{{connections.<nombre>}}`** — un identificador (`externalId`), nunca el secreto (`props-resolver.ts:219`).
- En ejecución, el engine hace `GET v1/worker/app-connections/{externalId}?projectId=...` con `engineToken` (`connection-resolver.ts:7`).
- El engine **no descifra nada**: tu endpoint devuelve un `AppConnection` con `.value` ya usable, tipado por `AppConnectionType` (`SECRET_TEXT`, `CUSTOM_AUTH`, `OAUTH2`, `BASIC_AUTH`).

**Tu mock es el ÚNICO punto donde el secreto existe en claro.**

```
┌─ Vault (almacén cifrado) ─────────────────┐
│  externalId → {type, value cifrado}        │  ← cifrado en reposo (AES-GCM)
│  scope: projectId                          │
└────────────────────────────────────────────┘
        ▲ escritura: humano / OAuth determinista (FUERA del agente)
        │ dereferencia SOLO aquí, server-side, con audit log
        ▼
GET v1/worker/app-connections/{id}  ← único punto de descifrado
        ▲  {{connections.<nombre>}}  ← lo único que ve el agente
   FlowVersion JSON (generado por el agente)
```

**4 reglas que cierran la fuga:**
1. El agente solo ve **nombres/labels** de connections (expuestos como metadata en OKF), nunca el valor.
2. La creación/autorización de credenciales es un **flujo separado** (humano u OAuth determinista), fuera del alcance del agente.
3. **Cifrado en reposo**; descifrado solo en el endpoint de dereferencia; **scoped por `projectId`** (aislamiento multi-tenant — el engine ya pasa `projectId`).
4. **Audit log** de cada dereferencia (flow, connection, timestamp).

**Fases:**
- **Fase 1:** `SECRET_TEXT` / `CUSTOM_AUTH` / `BASIC_AUTH` (API keys) → el vault solo devuelve el valor. Trivial.
- **Fase 2:** `OAUTH2` con refresh tokens → requiere detectar expiración y refrescar contra el provider (el engine tiene `auth-refresh.operation`; el backend real refresca y re-guarda). Es el ~80% de la complejidad de credenciales — diferido.

**Tecnología sugerida:** filas cifradas en tu DB (AES-GCM, clave en secret manager/env), igual que n8n. Migrable a HashiCorp Vault / secret manager del cloud detrás del mismo endpoint sin cambiar el contrato HTTP.

---

## Variables de entorno requeridas

| Env var | Valor sugerido | Necesaria si… |
|---|---|---|
| `AP_EXECUTION_MODE` | `UNSANDBOXED` | siempre (evita isolated-vm) |
| `AP_MAX_FILE_SIZE_MB` | p.ej. `25` | siempre |
| `AP_PAUSED_FLOW_TIMEOUT_DAYS` | p.ej. `1` | siempre |
| `AP_BASE_CODE_DIRECTORY` | ruta temp | solo si hay code steps |

`engineToken` puede ser cualquier string que tu mock acepte como Bearer.

---

## Plan de implementación (alto nivel)

1. **Extraer y renombrar** los 7 paquetes MIT a tu namespace (`@tuempresa/*`), conservando el copyright Activepieces.
2. **Generador OKF**: script build-time `PieceMetadata[] → árbol OKF` + `index.md`.
3. **Endpoint catálogo**: tu API sirve el árbol OKF + el schema del FlowVersion al agente.
4. **Mock HTTP interno** (4-5 rutas REST): connections, store, files, project. Connections respaldado por tu propio almacén de credenciales.
5. **Orquestador de ejecución**: construye `EngineConstants` + `FlowExecutorContext.empty()` y llama `flowExecutor.execute(...)`. Apunta `internalApiUrl` al mock.
6. **Validación**: valida el FlowVersion del agente contra el schema de `shared` antes de ejecutar.

---

## Checklist de decisiones
- [x] **Code steps del agente:** NO. Pieces-only, `UNSANDBOXED`, sin isolated-vm.
- [x] **Modelo de credenciales:** vault cifrado + referencias `{{connections.X}}`. Fase 1 API-keys; OAuth2 diferido.
- [ ] ¿Persistencia del store (KV) y files (blob) — efímera o duradera?
- [ ] ¿OKF servido como archivos estáticos o sintetizado on-the-fly por la API?
- [ ] Renombrado de namespace + cumplimiento del checklist legal del informe de auditoría.
