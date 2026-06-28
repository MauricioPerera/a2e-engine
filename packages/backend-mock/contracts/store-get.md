---
task: memory-store-get
intent: Recupera la entrada guardada bajo una key.
target: D:/Repo/activepieces/engine-backend-mock/src/store.ts
target_line: 20
language: typescript
kind: function
signature: "def get(key)"
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
Recuperar la entrada guardada bajo una key, devolviendo null si no existe.

## Interface
- get(key: string): StoreEntry | null

## Invariants
- get de key inexistente devuelve null (no undefined, no lanza).
- Devuelve {key, value} exacto si existe.

## Examples
- get('missing') -> null
- put('a', 1); get('a') -> {key:'a', value:1}

## Do / Don't
- Don't: no lanzar si la key no existe.
- Don't: no devolver undefined; devolver null.
- Do: usar Map.has antes de Map.get para distinguir ausencia.

## Tests
Cubiertos por src/store.test.ts: get inexistente => null, round-trip.

## Constraints
- Sin dependencias externas.
- PARAR y reportar si cyclomatic>5, nesting>2, params>3, lines>20.