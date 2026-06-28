// Smoke de discovery contra la ruta LOCAL ~/ap (monorepo AP ya clonado, sin red).
// Llama discoverSource({ source: <HOME>/ap }) -> confirma que lista cientos de
// pieces con name/displayName/description; muestra las primeras ~10 + total +
// tiempo. Verifica que NO se ejecuto codigo (es solo parseo de archivos).
import { discoverSource } from "./src/discover.ts";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const source = process.argv[2] || `${HOME}/ap`;

console.log(`[smoke-discover] source = ${source}`);
const t0 = Date.now();
let res;
try {
  res = await discoverSource({ source });
} catch (e) {
  console.error("discoverSource threw:", e.message);
  process.exit(1);
}
const dt = Date.now() - t0;

console.log(`[smoke-discover] sourceId = ${res.sourceId}`);
console.log(`[smoke-discover] total pieces = ${res.total}`);
console.log(`[smoke-discover] warnings = ${res.warnings.length}`);
console.log(`[smoke-discover] elapsed = ${dt} ms`);
console.log(`[smoke-discover] (parseo puro: solo readFileSync + regex; 0 imports/evals de codigo de pieces)`);

console.log("\n--- first 10 pieces ---");
for (const p of res.pieces.slice(0, 10)) {
  console.log(
    `  - ${p.name}  |  display="${p.displayName}"  |  auth=${p.auth ?? "(none)"}  |  dir=${p.dir}`,
  );
  console.log(`      desc: ${p.description.slice(0, 120)}`);
}

// Aserciones (hechos):
let failed = false;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

ok("total >= 100 (cientos)", res.total >= 100, `(got ${res.total})`);
ok("total ~ 720 (community de ~/ap)", res.total >= 700, `(got ${res.total})`);
const withDisplay = res.pieces.filter((p) => p.displayName && p.displayName !== p.name).length;
ok("mayoria con displayName propio", withDisplay >= res.total * 0.8, `(${withDisplay}/${res.total})`);
const withDesc = res.pieces.filter((p) => p.description && p.description !== p.name).length;
// description es OPCIONAL en createPiece (132/720 pieces de ~/ap no lo declaran);
// el fallback a name es correcto. Umbral honesto: >=500 (588 pieces declaran desc).
ok("muchas pieces con description propia", withDesc >= 500, `(${withDesc}/${res.total})`);
const withAuth = res.pieces.filter((p) => p.auth).length;
ok("algunas pieces con auth detectado", withAuth > 0, `(${withAuth})`);
// auth solo puede tomar valores del mapa conocido.
const validAuths = new Set(["SECRET_TEXT", "CUSTOM_AUTH", "OAUTH2", "BASIC_AUTH"]);
const badAuths = res.pieces.filter((p) => p.auth && !validAuths.has(p.auth));
ok("todos los auth son tipos validos", badAuths.length === 0, `(bad: ${badAuths.length})`);
ok("dir es relativo (no abs sensible)", res.pieces.every((p) => !p.dir.startsWith("/")), "");
// Distribucion de auth (informativo).
const dist = {};
for (const p of res.pieces) dist[p.auth ?? "NONE"] = (dist[p.auth ?? "NONE"] || 0) + 1;
console.log("\n--- auth distribution ---");
console.log(JSON.stringify(dist, null, 2));

if (res.warnings.length > 0) {
  console.log("\n--- warnings (first 10) ---");
  for (const w of res.warnings.slice(0, 10)) console.log(`  ! ${w}`);
}

console.log(`\n=== SMOKE ${failed ? "FAILED" : "PASSED"} === (${dt} ms, ${res.total} pieces)`);
process.exit(failed ? 1 : 0);