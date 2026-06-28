---
type: Policy
title: Tiers y egress
---

# Tiers y egress

Pieces clasificadas en tiers: T1 (Activepieces core), T2 (terceros), T3 (propio).
El egress esta acotado por una allowlist por piece; una piece T2/T3 solo puede
llamar a destinos explicitos. T1 es preferido; T3 requiere revision. No se
permite egress fuera de la allowlist.
