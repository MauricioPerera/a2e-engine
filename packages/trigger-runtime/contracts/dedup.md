---
task: dedup-polling
intent: Deduplica items de un poll contra un cursor de keys ya vistas devolviendo solo los nuevos.
target: src/dedup.ts
language: typescript
kind: group
signature: "def selectNewItems(items, seen, idField=None) -> dict"
budget:
  max_cyclomatic: 11
  max_cognitive: 16
  max_nesting: 4
  max_params: 4
  max_lines: 40
children:
  - stable-stringify.md
  - item-key.md
  - select-new-items.md
test_command: "npx tsx --test dedup.test.ts"
integration_test_command: "npx tsx --test dedup.test.ts"
deps_allowed:
  - node:test
  - node:assert
stop_rule: "las 3 funciones hijas bajo budget y los 11 tests de integracion pasan"
---

# dedup-polling

Composición del loop reactivo de triggers POLLING: deduplicación pura.

- `stableStringify(value)` — stringify determinista con claves ordenadas.
- `itemKey(item, idField?)` — key estable de un item.
- `selectNewItems(items, seen, idField?)` — orquestador.

`selectNewItems` → `itemKey` → `stableStringify`. El test de integración
`src/dedup.test.ts` ejercita la composición real (sin mocks).

## Criterio

- Cada hija bajo budget.
- 11 tests de integración pasan.
- Sin mutación; sin red; sin estado global; sin Date.