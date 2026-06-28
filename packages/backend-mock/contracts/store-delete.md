---
task: memory-store-delete
intent: Elimina la entrada asociada a una key.
target: D:/Repo/activepieces/engine-backend-mock/src/store.ts
target_line: 26
language: typescript
kind: function
signature: "def delete(key)"
tests: D:/Repo/activepieces/engine-backend-mock/src/store.test.ts
test_command: "node --test D:/Repo/activepieces/engine-backend-mock/src/store.test.ts"
deps_allowed: []
forbids: []
budget:
  cyclomatic: 5
  nesting: 2
  params: 3
  lines: 20
---

## Intent
Eliminar la entrada asociada a una key, siendo idempotente si no existe.

## Interface
- delete(key: string): void

## Invariants
- delete de key inexistente NO lanza (idempotente).
- Tras delete, get devuelve null.

## Examples
- put('a', 1); delete('a'); get('a') -> null
- delete('never') -> no lanza

## Do / Don't
- Don't: no lanzar si la key no existe.
- Do: usar Map.delete (no-op si ausente).

## Tests
Cubiertos por src/store.test.ts: delete elimina, delete idempotente.

## Constraints
- Sin dependencias externas.
- PARAR y reportar si cyclomatic>5, nesting>2, params>3, lines>20.