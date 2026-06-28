---
task: files-get
intent: Devolver los bytes guardados de un fileId o null si no existe.
target: ../src/files.ts
language: typescript
kind: function
signature: "def get(fileId)"
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
Devuelve los bytes guardados de un fileId, o null si no existe (no undefined, no lanza).

## Interface
- `get(fileId: string): Buffer | null`

## Invariants
- get de fileId inexistente devuelve null (no undefined, no lanza).
- get de un fileId con contenido previamente reemplazado devuelve el ultimo.

## Examples
- get('missing') -> null
- put('f1', Buffer.from([1,2,3])); get('f1') -> Buffer idem bytes.
- put('a', b1); put('a', b2); get('a') -> bytes de b2.

## Do / Don't
- Do: `return this.files.get(fileId) ?? null`.
- Don't: no devolver undefined; normalizar a null.
- Don't: no usar dependencias externas.

## Tests
Cubierto por `src/files.test.ts` (round-trip, inexistente => null, reemplaza).

## Constraints
- Sin dependencias externas; solo stdlib de Node.
- PARAR y reportar si supera el budget.