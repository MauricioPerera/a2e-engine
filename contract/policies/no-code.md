---
type: Policy
title: No-code
tier: T1
---

# No-code

El agente A2E compone workflows encadenando pieces del catalogo. Esta prohibido
escribir, ejecutar o inyectar codigo arbitrario: no code node, no eval, no
scripts inline. Solo se permiten pieces auditadas del catalogo. Cualquier paso
que requiera logica debe expresarse como una piece existente o como
router/loop del flujo.
