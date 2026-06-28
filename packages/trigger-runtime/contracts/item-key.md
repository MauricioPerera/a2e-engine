---
task: item-key
intent: Devuelve una key estable para un item priorizando idField primitivo.
target: src/dedup.ts
language: typescript
kind: function
target_line: 28
signature: "def itemKey(item, idField='id') -> str"
budget:
  max_cyclomatic: 11
  max_cognitive: 16
  max_nesting: 4
  max_params: 4
  max_lines: 40
test_command: "npx tsx --test dedup.test.ts"
tests: src/dedup.test.ts
deps_allowed:
  - node:test
  - node:assert
forbids:
  - print
  - Date
  - fetch
  - globalThis
stop_rule: "itemKey bajo budget y tests pasan"
---

# item-key

## Intent

Devuelve una key estable para un item priorizando idField primitivo.

## Interface

`itemKey(item: unknown, idField?: string): string`

## Invariants

- Objeto con idField primitivo (string/number/boolean) => `String(valor)`.
- null/undefined => "null"/"undefined".
- Resto => hash estable via `stableStringify`.

## Examples

- `itemKey({id:1,body:'x'})` => `"1"`
- `itemKey({id:1,body:'y'})` => `"1"` (mismo key, distinto resto)

## Do / Don't

- Do: usar `String(valor)` para primitivos.
- Don't: no usar `==` contra None; no mutar la entrada.

## Tests

`src/dedup.test.ts` cubre idField, null/undefined, idField custom, id no primitivo.

## Constraints

- Sin red, sin Date, sin estado global.
- PARAR y reportar si la cyclomatica supera 11 o si algun test falla.