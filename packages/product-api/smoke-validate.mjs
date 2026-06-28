// e2e smoke del validador de inputs en /execute (A2E). Bootea la product API,
// dispara requests reales por HTTP y comprueba:
//   1) /catalog ok (no-regresión).
//   2) /execute que OMITE una prop required (text) -> 400 validation_failed con
//      el error de missing required, SIN ejecutar el flow.
//   3) /execute válido (todas las required) -> 200 SUCCEEDED (no-regresión).
//   4) /execute echo con connection -> 200 SUCCEEDED (no-regresión, auth no cuenta).
// Mata todo al final.
import { start, PRODUCT_PORT } from "./src/index.ts";

const BASE = `http://localhost:${PRODUCT_PORT}`;
let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

const app = await start();
try {
  // 1) /catalog
  const cat = await fetch(`${BASE}/catalog`);
  ok("GET /catalog -> 200", cat.status === 200, `(status ${cat.status})`);

  // 2) /execute INVALIDO: omite la prop required "text" de convert_text_to_json.
  const rInvalid = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      steps: [
        {
          name: "parse",
          pieceName: "@activepieces/piece-json",
          pieceVersion: "0.1.8",
          actionName: "convert_text_to_json",
          input: { extra: "no-text" }, // falta "text" (required); "extra" es unknown
        },
      ],
    }),
  });
  const bInvalid = await rInvalid.json();
  console.log("execute(invalid, missing text) ->", JSON.stringify(bInvalid));
  ok("invalid -> HTTP 400", rInvalid.status === 400, `(status ${rInvalid.status})`);
  ok("invalid -> error=validation_failed", bInvalid.error === "validation_failed");
  const step0 = bInvalid.steps?.[0];
  ok("invalid -> steps[0].name=parse", step0?.name === "parse", JSON.stringify(step0));
  ok(
    "invalid -> error menciona missing required text",
    !!step0?.errors?.some((e) => /missing required property "text"/.test(e)),
    JSON.stringify(step0?.errors),
  );
  ok(
    "invalid -> error menciona unknown property extra",
    !!step0?.errors?.some((e) => /unknown property "extra"/.test(e)),
    JSON.stringify(step0?.errors),
  );
  ok("invalid -> NO se ejecuta (sin status SUCCEEDED)", bInvalid.status !== "SUCCEEDED");

  // 3) /execute VALIDO: text presente -> 200 SUCCEEDED.
  const rValid = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      steps: [
        {
          name: "parse",
          pieceName: "@activepieces/piece-json",
          pieceVersion: "0.1.8",
          actionName: "convert_text_to_json",
          input: { text: {a:1} },
        },
      ],
    }),
  });
  const bValid = await rValid.json();
  console.log("execute(valid json) ->", JSON.stringify(bValid));
  ok("valid json -> HTTP 200", rValid.status === 200, `(status ${rValid.status})`);
  ok("valid json -> SUCCEEDED", bValid.status === "SUCCEEDED", `(got ${bValid.status})`);
  ok("valid json -> output {a:1}", bValid.output && bValid.output.a === 1, JSON.stringify(bValid.output));

  // 4) /execute echo con connection (auth no cuenta como prop) -> 200 SUCCEEDED.
  const rEcho = await fetch(`${BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      steps: [
        {
          name: "whoami",
          pieceName: "@automators/piece-echo-auth",
          pieceVersion: "0.1.0",
          actionName: "whoami",
          connection: { name: "my-echo-conn" },
        },
      ],
    }),
  });
  const bEcho = await rEcho.json();
  console.log("execute(echo) ->", JSON.stringify(bEcho));
  ok("echo -> HTTP 200", rEcho.status === 200, `(status ${rEcho.status})`);
  ok("echo -> SUCCEEDED", bEcho.status === "SUCCEEDED", `(got ${bEcho.status})`);
  ok("echo -> apiKeyTail 1234", bEcho.output && bEcho.output.apiKeyTail === "1234", JSON.stringify(bEcho.output));
} finally {
  await app.close();
  console.log(failed ? "\n=== SMOKE-VALIDATE FAILED ===" : "\n=== SMOKE-VALIDATE PASSED ===");
  process.exit(failed ? 1 : 0);
}
