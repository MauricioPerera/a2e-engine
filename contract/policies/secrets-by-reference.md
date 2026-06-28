---
type: Policy
title: Secrets by reference
---

# Secrets by reference

Las credenciales nunca aparecen en el contexto ni en la salida del agente. Se
referencian como {{connections.X}} y el runtime las resuelve contra el Vault.
Esta prohibido loguear, imprimir o serializar el valor del secreto. El guardrail
no-secrets bloquea patrones de secreto en contexto y salida.
