// connection-provider.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  filterByPiece,
  renderRefLine,
  renderConnectionRefs,
  type ConnectionRef,
} from "./connection-provider.js";

const refs: ConnectionRef[] = [
  { externalId: "gh-1", displayName: "GitHub", pieceName: "github", type: "OAUTH2" },
  { externalId: "sl-1", displayName: "Slack", pieceName: "slack", type: "SECRET_TEXT" },
  { externalId: "gh-2", displayName: "GitHub App", pieceName: "github", type: "CUSTOM_AUTH" },
  { externalId: "sh-1", displayName: "Shell", pieceName: "shell", type: "SECRET_TEXT" },
];

test("estimateTokens: ceil(length/4)", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("12345678"), 2);
});

test("filterByPiece: sin filtro devuelve todos", () => {
  assert.deepEqual(filterByPiece(refs), refs);
  assert.deepEqual(filterByPiece(refs, undefined), refs);
});

test("filterByPiece: filtra por pieceName", () => {
  const github = filterByPiece(refs, "github");
  assert.equal(github.length, 2);
  assert.ok(github.every((r) => r.pieceName === "github"));
  const slack = filterByPiece(refs, "slack");
  assert.deepEqual(slack.map((r) => r.externalId), ["sl-1"]);
});

test("filterByPiece: pieceName inexistente -> vacío", () => {
  assert.deepEqual(filterByPiece(refs, "nope"), []);
});

test("renderRefLine: produce referencia {{connections.X}} sin secreto", () => {
  const line = renderRefLine(refs[0]);
  assert.match(line, /^\- \{\{connections\.gh-1\}\} — GitHub \(github, auth: OAUTH2\)$/);
  // Confirmar que la salida solo contiene externalId/displayName/pieceName/type (sin secreto).
  // El ConnectionRef no tiene campo de valor; la línea no debe contener tokens ajenos.
  assert.equal(line.includes("{{connections.gh-1}}"), true);
  assert.equal(line.includes("GitHub"), true);
  assert.equal(line.includes("github"), true);
  assert.equal(line.includes("OAUTH2"), true);
  // Nada que parezca un secreto o valor de credencial.
  assert.equal(line.includes("secret"), false);
  assert.equal(line.includes("token="), false);
  assert.equal(line.includes("password"), false);
});

test("renderConnectionRefs: budget alto -> todos incluidos, omitted 0", () => {
  const r = renderConnectionRefs(refs, { maxTokens: 1000 });
  assert.equal(r.total, refs.length);
  assert.equal(r.included.length, refs.length);
  assert.equal(r.omitted, 0);
  assert.deepEqual(r.included, refs.map((x) => x.externalId));
  assert.ok(r.context.startsWith("Available connections:"));
});

test("renderConnectionRefs: maxTokens bajo -> menos refs, omitted > 0", () => {
  const r = renderConnectionRefs(refs, { maxTokens: 6 });
  assert.equal(r.total, refs.length);
  assert.ok(r.included.length < refs.length, "debe incluir menos que el total");
  assert.ok(r.omitted > 0, "debe omitir al menos uno");
  assert.equal(r.included.length + r.omitted, r.total);
  // El contexto cabe en el budget (o justo lo excede por la última línea aceptada — aquí corta antes).
  assert.ok(estimateTokens(r.context) <= 6);
});

test("renderConnectionRefs: respeta filtro pieceName", () => {
  const r = renderConnectionRefs(refs, { maxTokens: 1000, pieceName: "github" });
  assert.equal(r.total, 2);
  assert.deepEqual(r.included, ["gh-1", "gh-2"]);
  assert.equal(r.omitted, 0);
});

test("renderConnectionRefs: coherencia included/total/omitted", () => {
  for (const maxTokens of [1, 3, 5, 8, 20, 100]) {
    const r = renderConnectionRefs(refs, { maxTokens });
    assert.equal(r.included.length + r.omitted, r.total, `coherencia para maxTokens=${maxTokens}`);
    assert.ok(r.included.length <= r.total, `no incluye más del total para maxTokens=${maxTokens}`);
  }
});

test("renderConnectionRefs: contexto = header + renderRefLine de los incluidos", () => {
  const r = renderConnectionRefs(refs, { maxTokens: 1000 });
  const expectedLines = ["Available connections:", ...r.included.map((id) => {
    const ref = refs.find((x) => x.externalId === id)!;
    return renderRefLine(ref);
  })];
  assert.equal(r.context, expectedLines.join("\n"));
});