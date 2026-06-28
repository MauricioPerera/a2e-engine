---
task: files-put
intent: Guardar o reemplazar los bytes de un fileId en el Map copiando el Buffer entrante.
target: ../src/files.ts
language: typescript
kind: function
signature: "def put(fileId, data)"
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
Guarda o reemplaza los bytes de un fileId en el Map, almacenando una COPIA del Buffer entrante.

## Interface
- `put(fileId: string, data: Buffer): void`

## Invariants
- put con el mismo fileId reemplaza el contenido previo.
- El store guarda una COPIA: mutar el Buffer entrante tras put NO altera lo almacenado.
- fileId es opaco: no se interpreta ni transforma.

## Examples
- put('f1', Buffer.from([1,2,3])) -> get('f1') devuelve esos bytes.
- put('a', b1); put('a', b2) -> get('a') devuelve bytes de b2 (reemplaza).
- put('k', orig); orig[0]=99 -> get('k') devuelve bytes originales (copia).

## Do / Don't
- Do: `this.files.set(fileId, Buffer.from(data))` para copiar los bytes.
- Don't: no guardar la referencia mutable del Buffer entrante.
- Don't: no usar dependencias externas.

## Tests
Cubierto por `src/files.test.ts` (round-trip, reemplaza, inmutabilidad, Buffer vacio).

## Constraints
- Sin dependencias externas; solo stdlib de Node.
- PARAR y reportar si supera el budget (cyclomatic>5, nesting>2, params>3, lines>20).