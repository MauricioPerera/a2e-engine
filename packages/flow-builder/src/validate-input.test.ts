import { test } from "node:test";
import assert from "node:assert/strict";
import { validateActionInput, type PropSpec } from "./validate-input.js";

// Oráculo independiente: specs definidos aquí, no importados del target.
const propsAll: Record<string, PropSpec> = {
  text: { type: "LONG_TEXT", required: true },
  channel: { type: "SHORT_TEXT", required: false },
};

test("validateActionInput: todas las required presentes -> ok", () => {
  const r = validateActionInput({ text: "hi", channel: "#g" }, propsAll);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateActionInput: required presente y optional ausente -> ok", () => {
  const r = validateActionInput({ text: "hi" }, propsAll);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateActionInput: falta una required -> error con nombre y tipo", () => {
  const r = validateActionInput({ channel: "#g" }, propsAll);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /missing required property "text" \(LONG_TEXT\)/);
});

test("validateActionInput: required en null -> error", () => {
  const r = validateActionInput({ text: null }, propsAll);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /missing required property "text"/);
});

test("validateActionInput: required en string vacío -> error", () => {
  const r = validateActionInput({ text: "" }, propsAll);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /missing required property "text"/);
});

test("validateActionInput: unknown key -> error", () => {
  const r = validateActionInput({ text: "hi", bogus: 1 }, propsAll);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /unknown property "bogus"/);
});

test("validateActionInput: unknown + missing a la vez -> dos errores", () => {
  const r = validateActionInput({ bogus: 1 }, propsAll);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
  assert.ok(r.errors.some((e) => /missing required property "text"/.test(e)));
  assert.ok(r.errors.some((e) => /unknown property "bogus"/.test(e)));
});

test("validateActionInput: key de auth no cuenta como unknown ni como missing", () => {
  // La piece declara auth como prop required; el agente manda la ref en `auth`.
  const propsWithAuth: Record<string, PropSpec> = {
    auth: { type: "SECRET_TEXT", required: true },
  };
  const r = validateActionInput({ auth: "{{connections[\"c\"]}}" }, propsWithAuth);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.errors, []);
});

test("validateActionInput: auth ausente y prop auth required -> NO se reporta (se valida aparte)", () => {
  const propsWithAuth: Record<string, PropSpec> = {
    auth: { type: "SECRET_TEXT", required: true },
  };
  const r = validateActionInput({}, propsWithAuth);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validateActionInput: sin props y input vacío -> ok", () => {
  const r = validateActionInput({}, {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateActionInput: sin props y key cualquiera -> unknown", () => {
  const r = validateActionInput({ whatever: 1 }, {});
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /unknown property "whatever"/);
});
