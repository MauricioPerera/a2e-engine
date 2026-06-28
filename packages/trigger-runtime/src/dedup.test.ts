import { test } from "node:test";
import assert from "node:assert/strict";
import { itemKey, selectNewItems, stableStringify } from "./dedup.ts";

test("primer poll: todos los items son nuevos; seen se llena con sus keys", () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const res = selectNewItems(items, []);
  assert.equal(res.newItems.length, 3);
  assert.deepEqual(res.newItems, items);
  assert.deepEqual(res.seen, ["1", "2", "3"]);
});

test("segundo poll con los mismos items: newItems vacío; seen no cambia", () => {
  const items = [{ id: 1 }, { id: 2 }];
  const seen = ["1", "2"];
  const res = selectNewItems(items, seen);
  assert.equal(res.newItems.length, 0);
  assert.deepEqual(res.seen, ["1", "2"]);
});

test("poll que crece [a,b] luego [a,b,c]: solo c es nuevo en el 2do", () => {
  const first = selectNewItems([{ id: "a" }, { id: "b" }], []);
  const second = selectNewItems(
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    first.seen,
  );
  assert.deepEqual(second.newItems, [{ id: "c" }]);
  assert.deepEqual(second.seen, ["a", "b", "c"]);
});

test("dedup por idField: mismo id, distinto resto -> mismo key (no nuevo la 2da)", () => {
  const first = selectNewItems([{ id: 1, body: "x" }], []);
  const second = selectNewItems([{ id: 1, body: "y" }], first.seen);
  assert.equal(first.newItems.length, 1);
  assert.equal(second.newItems.length, 0);
  assert.equal(itemKey({ id: 1, body: "x" }), itemKey({ id: 1, body: "y" }));
  assert.equal(itemKey({ id: 1, body: "x" }), "1");
});

test("items sin idField: dedup por contenido; {a:1,b:2} == {b:2,a:1}", () => {
  const a = { a: 1, b: 2 };
  const b = { b: 2, a: 1 };
  assert.equal(itemKey(a), itemKey(b));
  const first = selectNewItems([a], []);
  const second = selectNewItems([b], first.seen);
  assert.equal(first.newItems.length, 1);
  assert.equal(second.newItems.length, 0);
});

test("duplicados dentro del mismo batch: [x,x] -> un solo nuevo", () => {
  const x = { id: 7 };
  const res = selectNewItems([x, x, x], []);
  assert.equal(res.newItems.length, 1);
  assert.deepEqual(res.seen, ["7"]);
});

test("no mutación de entrada (seen e items originales intactos)", () => {
  const items = [{ id: 1 }, { id: 2 }];
  const seen = ["9"];
  const itemsSnap = JSON.stringify(items);
  const seenSnap = JSON.stringify(seen);
  const res = selectNewItems(items, seen);
  assert.deepEqual(res.seen, ["9", "1", "2"]);
  assert.equal(JSON.stringify(items), itemsSnap);
  assert.equal(JSON.stringify(seen), seenSnap);
  // el array seen devuelto es uno nuevo, no el de entrada
  assert.notEqual(res.seen, seen);
});

test("itemKey: null/undefined y primitivos", () => {
  assert.equal(itemKey(null), "null");
  assert.equal(itemKey(undefined), "undefined");
  assert.equal(itemKey(0), itemKey(0));
  assert.equal(itemKey("x"), itemKey("x"));
});

test("itemKey: idField custom", () => {
  assert.equal(itemKey({ key: "k1", x: 1 }, "key"), "k1");
  assert.equal(itemKey({ key: 42 }, "key"), "42");
  // idField ausente -> hash por contenido
  assert.equal(itemKey({ a: 1 }, "key"), itemKey({ a: 1 }, "key"));
});

test("itemKey: id presente pero valor no primitivo -> hash por contenido", () => {
  const obj = { id: { nested: 1 } };
  // valor de id no es primitivo -> fallback a hash estable
  assert.equal(itemKey(obj), itemKey({ id: { nested: 1 } }));
  assert.notEqual(itemKey(obj), "1");
});

test("stableStringify: orden de claves no afecta el resultado", () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(stableStringify({ a: 1, b: { c: 3, d: 4 } }), stableStringify({ b: { d: 4, c: 3 }, a: 1 }));
  assert.equal(stableStringify([1, 2, 3]), "[1,2,3]");
});