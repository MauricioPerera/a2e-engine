---
task: memory-store-put
intent: Guarda un valor bajo una key en el almacen.
target: D:/Repo/activepieces/engine-backend-mock/src/store.ts
target_line: 14
language: typescript
kind: function
signature: "def put(key, value)"
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
Guardar un valor bajo una key en un Map en memoria, reemplazando cualquier valor previo, devolviendo {key, value}.

## Interface
- put(key: string, value: unknown): StoreEntry

## Invariants
- put con la misma key reemplaza el valor previo.
- Siempre devuelve {key, value} con el valor recien guardado.
- No interpreta la key (opaca).

## Examples
- put('a', {x:1}) -> {key:'a', value:{x:1}}
- put('a', 1); put('a', 2) -> get('a') = {key:'a', value:2}

## Do / Don't
- Don't: no validar el contenido de value; es JSON arbitrario.
- Don't: no lanzar si la key ya existe.
- Do: usar Map.set para reemplazar.

## Tests
Cubiertos por src/store.test.ts: put+get round-trip, put reemplaza, value de tipos variados.

## Constraints
- Sin dependencias externas.
- PARAR y reportar si cyclomatic>5, nesting>2, params>3, lines>20.