# Arquitectura de datos y governance — A2E

**Ámbito:** cómo el sistema A2E almacena estado, gobierna el contexto del agente, y mantiene una capa de conocimiento auditable. Consolida lo añadido sobre el README maestro.
**Companion de:** `README-A2E-PRODUCTO.md`, `ESPECIFICACION-A2E.md`, `CONTRATO-CCDD-A2E.md`, `ESTANDAR-SEGURIDAD-CATALOGOS-A2E.md`.
**Repo:** `github.com/MauricioPerera/a2e-engine` (privado).

---

## 1. El stack de governance (4 capas)

```
┌─ VIGENCIA   — attestation humana con expiración (¿sigue siendo verdad?)
├─ FRESHNESS  — TTL automático por tipo de contenido (¿está obsoleto?)
├─ CCDD       — integridad del contexto del agente (budget/slots/guardrails/firmas)
└─ OKF + git  — estructura/almacenamiento auditable (catálogo·flows·runs·conocimiento)
```

Cada capa cubre lo que las otras no: OKF+git da estructura y audit; CCDD da integridad de inferencia; freshness/vigencia dan recencia semántica. Patrón tomado de `ccdd/examples/okf-integration`.

---

## 2. Modelo de persistencia — DOS mecanismos separados (no confundir)

| | **git + OKF** | **Backend durable** |
|---|---|---|
| Qué | catálogo · workflows · **runs** · conocimiento | **credenciales** · store-entries · files |
| Dónde | repos git: `.run-history/`, `.workflow-registry/`, `.knowledge-base/` | SQLite (`DATABASE`) / file-JSON (`DATA_DIR`) / memoria |
| Formato | markdown OKF + commits git | tabla SQLite cifrada / JSON / blobs |
| Objetivo | auditable, versionado, legible por agente y humano | rápido, privado, estado operacional |
| Upgrade | — | SQLite → Redis/Postgres/S3 |

**Regla:** los **secretos NUNCA van a git** (el historial es permanente). El vault va al backend durable cifrado. Git+OKF es solo para conocimiento auditable. DBs/almacenes reales solo donde hay throughput o secreto.

### Niveles de durabilidad del backend (por env)
- `DATABASE=x.db` → **SQLite** (ACID, upserts de fila, recomendado producción).
- `DATA_DIR=...` → file-JSON (MVP).
- (nada) → in-memory (dev).
El vault cifra en reposo (AES-256-GCM) en los tres; el secreto nunca aparece en claro.

---

## 3. El cuarteto OKF+git

Cada artefacto es un repo git de docs OKF (markdown + frontmatter + `index.md`). El agente los navega igual que el catálogo (un solo modelo de lectura); el humano los audita con `git log`.

| Artefacto | Repo (env) | Endpoints | Paquete |
|---|---|---|---|
| **Catálogo** | `full-catalog/` (generado) | `GET /catalog`, `GET /catalog/retrieve?q=&budget=` | okf-generator, okf-retriever |
| **Workflows** | `.workflow-registry/` (`WORKFLOWS_REPO`) | `POST/GET /workflows`, `GET /workflows/:id`, `POST /workflows/:id/execute` | workflow-registry |
| **Runs** | `.run-history/` (`RUNS_REPO`) | `GET /runs`, `GET /runs/:date/:runId` | run-logger |
| **Conocimiento** | `.knowledge-base/` (`KNOWLEDGE_REPO`) | `POST/GET /knowledge`, `GET /knowledge/:id`, `POST /knowledge/:id/attest` | knowledge-base |

**El bucle de aprendizaje:** un run `FAILED` siembra best-effort un stub de conocimiento (`sourceRunId`, tag `run-failure`) → un humano lo completa y lo atesta (vigencia) → futuras composiciones lo consultan; cuando caduca, el sistema lo sabe.

---

## 4. Freshness / Vigencia

Cada doc OKF de conocimiento lleva en frontmatter: `ttlDays`, `expiresAt`, y opcional `attestation { by, at, sha256, expiresAt }`.

- **Freshness (TTL):** `checkFreshness(entry, now)` → `fresh` si dentro del TTL.
- **Vigencia (humana):** una attestation válida **rescata** un entry vencido por TTL → verdict `attested`. Si la attestation también expira → `expired`. La verdad no-automatizable se delega a un humano con fecha de caducidad.

---

## 5. El contrato CCDD (governance del contexto del agente)

El contexto del agente es un contrato CCDD firmado en `~/product/contract/`:
- `context.yaml`: budget (16000 / reserve 4000), slots (environment·system·**policies**·flow_schema·**catalog**·**connections**·user_message), guardrails (no-secrets·output-schema·connection-refs).
- Slots estáticos firmados (SHA-256 en `expected-hashes.json`); `policies/*.md` son docs OKF (`type: Policy`) **y** el slot CCDD protegido (seam dual).

**Enforcement en 3 niveles:**
- **L1** (`ccdd.py lint --sign` / `lint` verify): firma + verifica integridad. Degradar un slot firmado → exit 1.
- **L2** (`.github/workflows/ccdd-gate.yml`, `ccdd.py diff`): gate CI; bloquea regresión semántica (quitar guardrail, bajar prioridad…) en cambios a `contract/**`.
- **L3** (`POST /agent/context`, paquete context-assembler): ensambla en runtime el contexto respetando prioridad + budget + guardrails, usando los providers. Devuelve el contexto acotado + accounting por slot + verdict de guardrails. Verificado: secreto nunca presente.

**Providers dinámicos:**
- `okf_catalog` (okf-retriever): retrieval estructural del catálogo (710 pieces) acotado a budget, **sin RAG**. `retrieve(query, budget)` → subconjunto relevante + `omitted`.
- `connection_refs` (connection-provider): referencias del vault (`{{connections.X}}`), **nunca secretos**.

---

## 6. Mapa de componentes (`~/product/packages`)

| Paquete | Rol |
|---|---|
| `okf-generator` | catálogo OKF desde metadata de pieces |
| `flow-builder` | request del agente → flow (piece/router/loop) + validación de inputs |
| `engine-adapter` | bundle del engine (Camino A) + executeFlow + bundler genérico de pieces |
| `backend-mock` | vault (cifrado) + store + files; **Durable*** (file) y **Sqlite*** (ACID) |
| `trigger-runtime` | reactivo: dedup + cron real + cursor durable |
| `run-logger` · `workflow-registry` · `knowledge-base` | el cuarteto OKF+git |
| `okf-retriever` · `connection-provider` · `context-assembler` | providers + L3 del contrato |
| `product-api` | servidor HTTP que ata todo; auth `API_KEYS`; arranca el mock interno |

Fuera de `packages/`: `contract/` (contrato CCDD firmado) · `.github/workflows/ccdd-gate.yml`.

---

## 7. Operación — variables de entorno

| Env | Efecto |
|---|---|
| `AP_EXECUTION_MODE=UNSANDBOXED` | pieces-only, sin isolated-vm (requerido) |
| `AP_CUSTOM_PIECES_PATHS` | roots de pieces (separados por `:`) que el loader resuelve |
| `AP_REPO` | ruta del monorepo Activepieces para el build (default `~/ap`) |
| `DATABASE` / `DATA_DIR` | durabilidad del backend (SQLite / file / memoria) |
| `RUNS_REPO` / `WORKFLOWS_REPO` / `KNOWLEDGE_REPO` | repos OKF+git (opt-in) |
| `API_KEYS` | `key:projectId,...` — auth por API-key (sin él, modo dev abierto) |
| `CONTRACT_DIR` | dir del contrato CCDD (default `~/product/contract`) |

Arranque: ver `README-A2E-PRODUCTO.md` §6 + `scripts/setup.sh` (clona AP al tag fijado, builda el engine).

---

## 8. Lo que resta (upgrades, no viabilidad)

- SQLite WAL / cross-proceso; Redis/Postgres para multi-instancia.
- HMAC por-webhook (hoy el `triggerId` uuid es el bearer del ingress).
- Parseo real de `context.yaml` en el assembler L3 (hoy el config de slots se deriva/hardcodea coincidiendo con el contrato).
- Escaneo SCA sobre el set final de pieces a comercializar.
- Piece source manager (repo→listar→seleccionar→catálogo aislado): diseñado en este doc-set, no construido.
