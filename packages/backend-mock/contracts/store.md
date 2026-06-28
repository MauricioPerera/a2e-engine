---
task: memory-store
intent: Respalda un almacen clave-valor en memoria sobre un Map.
target: D:/Repo/activepieces/engine-backend-mock/src/store.ts
language: typescript
kind: group
signature: "class MemoryStore"
tests: D:/Repo/activepieces/engine-backend-mock/src/store.test.ts
test_command: "node --test D:/Repo/activepieces/engine-backend-mock/src/store.test.ts"
integration_test_command: "node --test D:/Repo/activepieces/engine-backend-mock/src/store.test.ts"
children:
  - store-put.md
  - store-get.md
  - store-delete.md
deps_allowed: []
forbids: []
budget:
  cyclomatic: 5
  nesting: 2
  params: 3
  lines: 20
---

## Intent
Respaldar un almacen clave-valor en memoria sobre un Map, ensamblando las operaciones put, get y delete.

## Interface
- tipo `StoreEntry = { key: string; value: unknown }`
- `put(key: string, value: unknown): StoreEntry` — guarda/reemplaza, devuelve {key, value}
- `get(key: string): StoreEntry | null` — null si no existe
- `delete(key: string): void` — idempotente

## Invariants
- put con la misma key reemplaza el valor previo.
- get de key inexistente devuelve null (no undefined, no lanza).
- delete de key inexistente NO lanza (idempotente).
- value es JSON arbitrario: objeto, array, string, number, boolean, null.
- La key es opaca: el store NO la interpreta ni la transforma.

## Examples
- put('a', {x:1}) -> {key:'a', value:{x:1}}; get('a') -> {key:'a', value:{x:1}}
- get('missing') -> null
- put('a', 1); put('a', 2); get('a') -> {key:'a', value:2}
- put('a', 1); delete('a'); get('a') -> null
- delete('never') -> no lanza
- put('n', null); get('n') -> {key:'n', value:null}

## Do / Don't
- Do: usar `Map<string, unknown>` como respaldo.
- Don't: no interpretar, validar ni transformar la key.
- Don't: no validar el contenido de value; es JSON arbitrario.
- Don't: no lanzar en delete de key inexistente.
- Don't: no usar dependencias externas.

## Tests
Tests congelados en `src/store.test.ts` (node:test + node:assert/strict) cubren: round-trip put+get, get inexistente => null, put reemplaza, delete elimina, delete idempotente, value de tipos variados. Oráculo independiente: los valores esperados se construyen literalmente en el test.

## Constraints
- Sin dependencias externas; solo stdlib de Node.
- Preservar el estilo del repo (ver src/vault.ts): clase con campo Map privado, metodos cortos, JSDoc breve.
- PARAR y reportar si alguna funcion supera el budget (cyclomatic>5, nesting>2, params>3, lines>20).