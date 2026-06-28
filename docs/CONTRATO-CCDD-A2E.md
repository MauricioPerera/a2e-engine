# Contrato CCDD del agente A2E — propuesta

**Qué es:** expresa el **contexto del agente A2E** como un contrato CCDD (`context.yaml`) — versionado en git, con capas dura (budget/slots/guardrails firmados, gateados en CI) y blanda (juicio de outputs). Convierte el `ESTANDAR-SEGURIDAD-CATALOGOS-A2E.md` de documento a **contrato enforceable**.

**Base:** repo `MauricioPerera/ccdd` (impl. Python ejecutable + tests + CI; esquema `ccdd_context.schema.json`; ejemplo real `support-agent/context.yaml`).

**Qué resuelve, concreto:**
1. **Catálogo-en-contexto:** 710 pieces (7102 archivos OKF) no caben en el contexto → un `slot` con budget + `compaction` inyecta un subconjunto/resumen acotado.
2. **Estándar de seguridad enforceable:** las políticas A2E van en un slot **firmado** + guardrails + `review_quorum`; debilitarlas = gate en CI bloquea el merge.
3. **Validación de salida a nivel contrato:** guardrail `json_schema` valida el `ExecuteRequest` del agente.

---

## context.yaml propuesto

```yaml
ccdd_version: "0.1"
contract:
  name: a2e-agent
  budget:
    model: claude-opus-4-8        # tunable
    max_tokens: 16000             # presupuesto total del contexto del agente
    reserve_output: 4000          # buffer para la salida (el ExecuteRequest)
  slots:
    - id: environment             # hechos de runtime: catálogo/tier activo, projectId
      priority: 0
      source: { type: static, path: env.txt, sign: true }
      compaction: none
      min_tokens: 20
    - id: system                  # rol A2E: "compón workflows, NO escribas código"
      priority: 1
      source: { type: static, path: system.txt, sign: true }
      compaction: none
      min_tokens: 60
    - id: policies                # EL estándar de seguridad (no-code, secretos por
      priority: 1                 # referencia, tiers permitidos, egress)
      source: { type: static, path: policies.txt, sign: true }
      compaction: none
      min_tokens: 80
      review_quorum: 2            # cambiar la política exige 2 revisores + re-firma
    - id: flow_schema             # contrato del ExecuteRequest/FlowVersion que debe emitir
      priority: 2
      source: { type: static, path: flow-schema.txt, sign: true }
      compaction: none
    - id: catalog                 # OKF — subconjunto/resumen acotado, NO RAG
      priority: 3
      source: { type: dynamic, provider: okf_catalog }   # retrieval estructural OKF
      compaction: summarize
      max_tokens: 6000
    - id: connections             # referencias disponibles (nombres, NUNCA secretos)
      priority: 3
      source: { type: dynamic, provider: connection_refs }
      compaction: truncate
      max_tokens: 1000
    - id: user_message            # la tarea/petición
      priority: 4
      source: { type: runtime }
      compaction: truncate
  guardrails:
    - id: no-secrets              # bloquea secretos en contexto Y en la salida
      type: regex_deny
      pattern: "(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)"
      on_fail: abort
    - id: output-schema           # valida el ExecuteRequest del agente
      type: json_schema
      schema_path: execute-request.schema.json
      target_slot: user_message   # (o el canal de salida del runtime)
      on_fail: abort
    - id: connection-refs         # {{connections.X}} debe resolver a una connection conocida
      type: reference_check
      on_fail: abort
```

---

## Archivos de slot (a crear)

| Archivo | Contenido | Firmado |
|---|---|---|
| `env.txt` | Catálogo/tier activos, projectId, límites de runtime | ✅ |
| `system.txt` | Rol del agente A2E: compone pieces, no escribe código, encadena/ramifica/itera | ✅ |
| `policies.txt` | **El estándar de seguridad operacionalizado**: sin code node, secretos solo por referencia, tiers permitidos (T1/T2/T3), egress allowlist | ✅ (quorum 2) |
| `flow-schema.txt` | Forma del `ExecuteRequest` (piece/router/loop) que debe emitir | ✅ |
| `execute-request.schema.json` | JSON Schema del output, para el guardrail | — |

`expected-hashes.json` (SHA-256 de los slots firmados) lo genera el tooling CCDD; cambiar un slot firmado sin re-firmar → **gate falla (exit 1)**.

---

## Cómo se conecta con lo que ya tenemos

| Pieza A2E existente | Rol en el contrato |
|---|---|
| Catálogo OKF (okf-generator/full-catalog) | provider `okf_catalog` del slot `catalog` (con compaction) |
| `validateActionInput` (flow-builder) | complementa el guardrail `output-schema` (runtime + contrato) |
| Vault + `{{connections.X}}` | provider `connection_refs` (solo nombres) + guardrail `no-secrets` |
| `ESTANDAR-SEGURIDAD-CATALOGOS-A2E.md` | se materializa en `policies.txt` firmado + guardrails + quorum |
| run-logger OKF+git (en curso) | el "Audit & Reproduce" (stage 5 de CCDD) |

---

## Caveats honestos

- **El provider `okf_catalog` hay que implementarlo:** CCDD define el slot dynamic con un `provider`; el retrieval estructural OKF (elegir qué subconjunto del catálogo inyectar según la tarea, dentro del budget) es código nuestro a escribir. CCDD da el marco (budget+compaction), no el retriever.
- **CCDD es Python;** integrarlo al runtime (Node) del producto sería: o correr el assembler CCDD como paso previo a la llamada del agente, o portar el subset que uses. A nivel **CI/gate** (lint+sign+verify del contrato) es directo (Python en el workflow).
- **Adopción gradual** (L1 local → L2 CI gate → L3 runtime enforcement): empezar por L1/L2 (el contrato versionado + gateado) da el 80% del valor sin tocar el runtime.

---

## Recomendación de orden

1. **L1/L2 primero:** versionar este `context.yaml` + slots firmados + el gate CCDD en CI → el estándar de seguridad se vuelve enforceable ya, sin tocar el runtime.
2. **Luego el provider `okf_catalog`** (retriever estructural con budget) → resuelve el catálogo-en-contexto.
3. **L3 (runtime assembly)** cuando quieras que la app ensamble el contexto respetando el contrato en cada llamada.
