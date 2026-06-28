# A2E — Agent to Execution · Especificación

**Versión:** 0.1 (fundada en PoC implementado y verificado end-to-end)
**Fecha:** 2026-06-27
**Companion de:** `ANEXO-ARQUITECTURA-MOTOR-API.md`, `AUDITORIA-LICENCIAS-ACTIVEPIECES.md`

---

## 1. Premisa

> **El agente no escribe código. Escribe workflows que componen código ya validado.**

A2E es un protocolo de ejecución para agentes (LLM) que invierte el modelo habitual "el agente genera código y lo ejecutamos". En su lugar:

- El **código validado** son unidades reutilizables y probadas (**pieces**).
- El **agente** produce un **workflow declarativo** (JSON) que referencia y compone esas pieces.
- El **runtime** ejecuta la composición de forma determinista.

El agente **compone, no implementa**. Su superficie de acción está acotada a primitivas verificadas.

---

## 2. Garantías de A2E

A2E garantiza, por diseño (no por convención):

1. **No-ejecución de código arbitrario.** El agente no tiene ninguna primitiva para inyectar código. Su única salida es un JSON declarativo de pasos.
2. **Composición acotada.** El agente solo puede referenciar pieces que existen en el catálogo. Referenciar algo inexistente es un error duro del runtime (`PieceNotFoundError`), no un comportamiento indefinido.
3. **Aislamiento de secretos.** Las credenciales se pasan **por referencia** (`{{connections.<name>}}`). El agente nunca ve, recibe ni transmite un secreto. La no-determinación del agente jamás toca datos sensibles.
4. **Ejecución determinista.** Sin code node, la ejecución de un workflow dado es reproducible: las pieces son las únicas primitivas de ejecución.
5. **Descubrimiento explícito.** El conjunto de lo que el agente puede hacer es un artefacto legible (catálogo OKF), no conocimiento implícito del modelo.

---

## 3. Roles y capas de validación

A2E define **dos niveles de "código validado"**, ambos independientes del agente:

| Capa | Qué | Cómo se valida |
|---|---|---|
| **Runtime A2E** | El motor de ejecución, el adaptador del engine, el constructor de workflows, el backend de credenciales | Gate determinista (CCDD): contratos + tests congelados + budget de complejidad |
| **Primitivas** | Las pieces (conectores/acciones) | Unidades probadas; el agente solo las compone, nunca las modifica |

El agente vive estrictamente sobre la capa de primitivas. Nunca perfora ninguna de las dos capas.

---

## 4. Contrato de E/S del agente

### 4.1 Entrada del agente — Descubrimiento (catálogo OKF)
El agente lee el catálogo en **OKF** (Open Knowledge Format): árbol de markdown con frontmatter, navegable estructuralmente, **sin vectores ni RAG**.

```
GET /catalog          -> índice raíz: lista de pieces disponibles
GET /pieces/:name     -> índice de una piece: auth + lista de actions/triggers
                         (+ por action: descripción, tabla de props, uso)
```

El catálogo es **la frontera de lo permitido**: lo que no está en el catálogo, no se puede componer.

### 4.2 Salida del agente — Workflow declarativo
El agente produce un `ExecuteRequest`:

```json
{
  "steps": [
    {
      "name": "step_1",
      "pieceName": "@scope/piece-x",
      "pieceVersion": "1.0.0",
      "actionName": "do_something",
      "input": { "param": "value" },
      "connection": { "name": "mi-credencial", "property": "auth" }
    }
  ]
}
```

- `input` contiene los valores de las props de la action (datos, no código).
- `connection` (opcional) inyecta una **referencia** de credencial — nunca el secreto.
- Los pasos se encadenan en secuencia; el output de uno alimenta al siguiente vía expresiones `{{...}}`.

### 4.3 Resultado
```json
POST /execute  ->  { "status": "SUCCEEDED" | "FAILED", "output": { ... }, "error"?: "..." }
```

---

## 5. Cómo se hace cumplir cada garantía (en el código existente)

| Garantía | Mecanismo de enforcement | Componente |
|---|---|---|
| No código arbitrario | Sin code node; `AP_EXECUTION_MODE=UNSANDBOXED`; sin isolated-vm | engine-adapter |
| Composición acotada | El request solo produce nodos `PIECE`; el piece-loader exige que la piece exista (`PieceNotFoundError` si no) | flow-builder + engine |
| Aislamiento de secretos | El flow JSON solo lleva `{{connections.<name>}}`; el secreto se resuelve server-side y se descifra solo en el vault | backend-mock (vault) + connection-resolver del engine |
| Ejecución determinista | Las pieces son las únicas primitivas; ejecución in-process del engine | engine-adapter |
| Descubrimiento explícito | Catálogo OKF generado desde la metadata real de cada piece | okf-generator |

**Validación del runtime (capa 1):** todo el código del runtime se certificó con el gate CCDD (complejidad bajo budget + property-tests congelados).

---

## 6. Modelo de credenciales (A2E-safe)

```
Vault cifrado (AES-256-GCM)          el agente NUNCA lo ve
   externalId -> {type, value}        escritura: humano / OAuth, fuera del agente
   scope: projectId                   audit log de cada dereferencia
        │
        │  el engine pide por HTTP (server-side, Bearer)
        ▼
   GET /v1/worker/app-connections/<id>   <- único punto de descifrado
        ▲
        │  {{connections['name']}}        <- lo único que el agente emite/ve
   ExecuteRequest (del agente)
```

Probado end-to-end: un flow con referencia de connection ejecuta, el engine descifra vía el vault, la piece recibe `context.auth`, y el secreto completo **no aparece** ni en el workflow ni en la salida.

---

## 7. Ciclo de vida de una ejecución A2E

1. **Descubrir** — el agente lee `GET /catalog` y `GET /pieces/:name` (OKF).
2. **Componer** — el agente emite un `ExecuteRequest` (pasos que referencian pieces + inputs + referencias de credenciales).
3. **Construir** — `buildFlowFromRequest` valida y produce el nodo `PieceAction` encadenado (forma exacta que el engine acepta).
4. **Ejecutar** — el adaptador arma `EngineConstants` + `FlowExecutorContext` y llama `flowExecutor.execute` in-process.
5. **Resolver dependencias** — durante la ejecución, el engine pide connections/store/files al backend por HTTP (el vault descifra las credenciales server-side).
6. **Responder** — el runtime devuelve `{ status, output }`.

---

## 8. Estado de implementación (verificado)

| Componente | Rol A2E | Estado |
|---|---|---|
| `product-api` | Superficie del protocolo (`/catalog`, `/pieces`, `/execute`) | ✅ e2e via HTTP |
| `okf-generator` | Descubrimiento (catálogo OKF) | ✅ metadata real, 104 archivos / 5 pieces |
| `flow-builder` | Composición (request → workflow) | ✅ gate CCDD |
| `engine-adapter` | Ejecución (engine in-process) | ✅ ejecución real |
| `backend-mock` (vault) | Credenciales A2E-safe | ✅ gate CCDD + e2e |
| Pieces reales | Primitivas validadas | ✅ 5 conectores; pipeline genérico sobre 720 |

Flujo completo **agente → API → composición → engine → pieces** probado end-to-end, incluyendo el modelo de credenciales. Reside en `~/product` (WSL).

---

## 9. Límites y trabajo futuro

- **OAuth2 con refresh** de credenciales: diferido (fase 2 del vault); fase 1 cubre API-keys/secret/custom-auth.
- **Router/ramas condicionales**: ✅ IMPLEMENTADO y verificado e2e — el agente compone ramas (`if/else` declarativo, 24 operadores, `EXECUTE_FIRST_MATCH`/`EXECUTE_ALL_MATCH`) vía `buildRouterStep`; el engine ejecuta solo la rama que matchea (probado: solo el child correcto corre).
- **Loops/iteración**: ✅ IMPLEMENTADO y verificado e2e — `buildLoopStep` (type `loop`, `items` + body); el engine itera el cuerpo una vez por item (probado: 3 items → 3 iteraciones, item actual visible vía `{{<loop>.output.item}}` / `.index`).
- **Paso de datos entre pasos**: ✅ verificado — expresiones `{{<step>.output...}}` resuelven (requiere `stepNames` poblado en EngineConstants; el adapter lo deriva automáticamente del grafo vía `collectStepNames`).
- **Triggers — parte #1 (hook in-process): ✅ VIABLE y verificado.** El engine ejecuta hooks de trigger (`TEST`/`RUN`) in-process vía `triggerHookOperation.execute`; probado con una piece POLLING propia que devuelve items. La operación deriva sus EngineConstants sola; requiere un `flowVersion` con `trigger.settings={pieceName,pieceVersion,triggerName,input,propertySettings}` y `triggerPayload` envuelto `{type:'inline',value}`.
- **Triggers — parte #2 (sistema reactivo):**
  - ✅ **MVP POLLING implementado** (`trigger-runtime`): scheduler por intervalo → hook `RUN` → dedup (`selectNewItems`, certificada por gate) → disparo de `executeFlow` por cada item NUEVO (no por poll) → item seedeado en el cuerpo del flow. Demo: items crecientes `[1,2]→[1,2,3]→[1,2,3]` producen disparos `[2,1,0]`, 3 firings = 3 items únicos. (Dedup y hooks de trigger verificados directamente; demo e2e reproducido idéntico por DOS corridas independientes de agente — resultado `[2,1,0]`/3 firings/SUCCEEDED consistente.)
  - ⏳ Pendiente (refinamientos): cron real desde `ON_ENABLE.scheduleOptions` (hoy intervalo `setInterval`); ingress de webhooks (WEBHOOK/APP_WEBHOOK con HANDSHAKE/RENEW); persistencia durable del cursor (hoy en memoria).
- **Renombrado de namespace + checklist legal** (ver auditoría de licencias) antes de uso comercial.
- **Validación de input contra el schema de props** de cada action (hoy se confía en la piece); un validador previo daría errores más tempranos y mejores para el agente.

---

## Apéndice — Por qué A2E (resumen de una línea)

Mover la frontera de confianza: en vez de confiar en que el agente **genere código correcto**, se confía en **código ya validado** y se restringe al agente a **componerlo**. La corrección vive en las primitivas y el runtime; la creatividad del agente vive en la composición.
