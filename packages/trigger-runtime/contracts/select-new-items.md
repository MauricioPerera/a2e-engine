---
task: select-new-items
intent: Filtra los items no vistos preservando el orden de aparicion.
target: src/dedup.ts
language: typescript
kind: function
target_line: 51
signature: "def selectNewItems(items, seen, idField=None) -> dict"
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
stop_rule: "selectNewItems bajo budget y tests pasan"
---

# select-new-items

## Intent

Filtra los items no vistos preservando el orden de aparicion.

## Interface

`selectNewItems(items: unknown[], seen: string[], idField?: string): { newItems: unknown[]; seen: string[] }`

## Invariants

- newItems = items cuya key no esta en `seen` (orden de aparicion).
- Duplicados del mismo batch cuentan una vez.
- seen devuelto = seen previo + keys nuevas (al final, sin duplicados).
- No muta las entradas.

## Examples

- `selectNewItems([{id:1},{id:2}], [])` => `{newItems:[{id:1},{id:2}], seen:["1","2"]}`
- `selectNewItems([{id:1}], ["1"])` => `{newItems:[], seen:["1"]}`

## Do / Don't

- Do: devolver arrays nuevos.
- Don't: no mutar `items` ni `seen` de entrada.

## Tests

`src/dedup.test.ts` cubre primer poll, segundo poll, crecimiento, dedup por id y contenido, duplicados en batch, no mutacion.

## Constraints

- Sin red, sin Date, sin estado global.
- PARAR y reportar si la cyclomatica supera 11, si params supera 4 o si algun test falla.