---
task: stable-stringify
intent: Devuelve una cadena JSON determinista del valor con claves ordenadas recursivamente.
target: src/dedup.ts
language: typescript
kind: function
target_line: 8
signature: "def stableStringify(value) -> str"
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
stop_rule: "stableStringify bajo budget y tests pasan"
---

# stable-stringify

## Intent

Devuelve una cadena JSON determinista del valor con claves ordenadas recursivamente.

## Interface

`stableStringify(value: unknown): string`

## Invariants

- Mismo contenido => misma cadena, sin importar el orden de claves.
- Arrays conservan el orden de elementos.

## Examples

- `stableStringify({a:1,b:2})` => `"{\"a\":1,\"b\":2}"`
- `stableStringify({b:2,a:1})` => `"{\"a\":1,\"b\":2}"` (mismo que arriba)

## Do / Don't

- Do: ordenar claves recursivamente.
- Don't: no mutar la entrada.

## Tests

`src/dedup.test.ts` cubre orden de claves, anidamiento y arrays.

## Constraints

- Sin red, sin Date, sin estado global.
- PARAR y reportar si la cyclomatica supera 11 o si algun test falla.