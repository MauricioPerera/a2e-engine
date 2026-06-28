---
task: files-has
intent: Indicar si un fileId existe en el store.
target: ../src/files.ts
language: typescript
kind: function
signature: "def has(fileId)"
tests: ../src/files.test.ts
test_command: "node --import tsx --test ../src/files.test.ts"
deps_allowed: []
forbids: ["node:fs", "node:crypto", "node:path"]
budget:
  cyclomatic: 5
  nesting: 2
  params: 3
  lines: 20
---

## Intent
Devuelve true si el fileId existe en el store, false en caso contrario.

## Interface
- `has(fileId: string): boolean`

## Invariants
- has de fileId inexistente devuelve false.
- has de fileId tras put devuelve true.

## Examples
- has('x') -> false
- put('x', Buffer.from([1])); has('x') -> true

## Do / Don't
- Do: `return this.files.has(fileId)`.
- Don't: no usar dependencias externas.

## Tests
Cubierto por `src/files.test.ts` (has true/false).

## Constraints
- Sin dependencias externas; solo stdlib de Node.
- PARAR y reportar si supera el budget.