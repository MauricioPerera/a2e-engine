/**
 * Frozen property-tests for MemoryFileStore (independent oracle).
 *
 * Oráculo: los bytes esperados se construyen literalmente en el test;
 * no se derivan ni reutilizan la lógica del store. El store guarda COPIAS,
 * por lo que mutar el Buffer original tras put NO altera lo almacenado.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { MemoryFileStore } from './files.ts';

test('put+get round-trip devuelve bytes identicos', () => {
  const s = new MemoryFileStore();
  const bytes = Buffer.from([0, 1, 2, 3, 255, 128, 0, 7]);
  s.put('f1', bytes);
  assert.deepEqual(s.get('f1'), Buffer.from([0, 1, 2, 3, 255, 128, 0, 7]));
});

test('get de fileId inexistente devuelve null', () => {
  assert.equal(new MemoryFileStore().get('missing'), null);
});

test('has true tras put y false si no existe', () => {
  const s = new MemoryFileStore();
  assert.equal(s.has('x'), false);
  s.put('x', Buffer.from([1, 2, 3]));
  assert.equal(s.has('x'), true);
});

test('put reemplaza el contenido previo', () => {
  const s = new MemoryFileStore();
  s.put('a', Buffer.from([1, 1, 1]));
  s.put('a', Buffer.from([2, 2, 2]));
  assert.deepEqual(s.get('a'), Buffer.from([2, 2, 2]));
});

test('inmutabilidad: mutar el Buffer original tras put NO cambia lo guardado', () => {
  const s = new MemoryFileStore();
  const original = Buffer.from([10, 20, 30]);
  s.put('k', original);
  original[0] = 99;
  original.writeUInt8(77, 1);
  assert.deepEqual(s.get('k'), Buffer.from([10, 20, 30]));
});

test('put con Buffer vacio funciona y get devuelve Buffer vacio', () => {
  const s = new MemoryFileStore();
  s.put('empty', Buffer.alloc(0));
  assert.deepEqual(s.get('empty'), Buffer.alloc(0));
  assert.equal(s.has('empty'), true);
});