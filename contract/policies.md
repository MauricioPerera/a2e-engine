---
type: Policy
title: A2E security baseline
quorum: 2
---

# Politicas de seguridad A2E (baseline firmada)

Fuente canonica OKF: policies/no-code.md, policies/secrets-by-reference.md,
policies/tiers-egress.md. Este archivo es el slot CCDD firmado; cambiarlo exige
quorum 2 + re-firma (review_quorum del slot policies).

## P1 — No-code
El agente compone workflows usando EXCLUSIVAMENTE pieces del catalogo. Queda
prohibido escribir, ejecutar o inyectar codigo arbitrario (code node, eval,
scripts). Solo pieces auditadas.

## P2 — Secrets by reference
Las credenciales NUNCA van en contexto ni en salida. Se referencian como
{{connections.X}} y el runtime las resuelve contra el Vault. Nunca loguear,
imprimir ni serializar el valor del secreto.

## P3 — Tiers y egress
Pieces clasificadas: T1 (Activepieces core), T2 (terceros), T3 (propio).
Egress acotado por allowlist por piece; T2/T3 solo llama a destinos explicitos.
T1 preferido; T3 requiere revision. Sin egress fuera de la allowlist.
