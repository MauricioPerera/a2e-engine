---
task: memory-file-store
intent: Respaldar un almacen de archivos en memoria sobre un Map de Buffers para los endpoints del engine.
target: ../src/files.ts
language: typescript
kind: group
signature: "class MemoryFileStore"
tests: ../src/files.test.ts
test_command: "node --import tsx --test ../src/files.test.ts"
integration_test_command: "node --import tsx --test ../src/files.test.ts"
children:
  - files-put.md
  - files-get.md
  - files-has.md
deps_allowed: []
forbids: ["node:fs", "node:crypto", "node:path"]
budget:
  cyclomatic: 5
  nesting: 2
  params: 3
  lines: 20
---

## Intent
Respaldar un almacen de archivos en memoria sobre un Map<string, Buffer>, ensamblando las operaciones put, get y has para los endpoints v1/files del engine.

## Interface
- `put(fileId: string, data: Buffer): void` — guarda/reemplaza (copia defensiva).
- `get(fileId: string): Buffer | null` — null si no existe.
- `has(fileId: string): boolean` — true si existe.

## Invariants
- put con el mismo fileId reemplaza el contenido previo.
- get de fileId inexistente devuelve null (no undefined, no lanza).
- has de fileId inexistente devuelve false.
- El store guarda una COPIA de los bytes: mutar el Buffer entrante tras put NO altera lo almacenado.
- fileId es opaco: el store NO lo interpreta ni transforma.

## Examples
- put('f1', Buffer.from([1,2,3])); get('f1') -> Buffer idem bytes.
- get('missing') -> null
- put('a', b1); put('a', b2); get('a') -> bytes de b2.
- has('x') -> false; put('x', ...); has('x') -> true
- put('k', orig); orig[0]=99; get('k') -> bytes originales sin mutar.

## Do / Don't
- Do: usar `Map<string, Buffer>` como respaldo.
- Do: copiar el Buffer entrante en put (`Buffer.from(data)`).
- Don't: no guardar la referencia mutable del Buffer entrante.
- Don't: no interpretar, validar ni transformar el fileId.
- Don't: no usar dependencias externas (solo node:buffer).

## Tests
Tests congelados en `src/files.test.ts` (node:test + node:assert/strict) cubren: round-trip put+get bytes identicos, get inexistente => null, has true/false, put reemplaza, inmutabilidad (mutar el original tras put no cambia lo guardado), Buffer vacio. Oraculo independiente: los bytes esperados se construyen literalmente en el test.

## Constraints
- Sin dependencias externas; solo stdlib de Node (node:buffer).
- Preservar el estilo del repo (ver src/vault.ts y src/store.ts): clase con campo Map privado, metodos cortos, JSDoc breve.
- PARAR y reportar si alguna funcion supera el budget (cyclomatic>5, nesting>2, params>3, lines>20).