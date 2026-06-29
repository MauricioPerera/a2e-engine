// smoke-validate-piece.mjs — runs the piece validator against REAL pieces and
// one synthetic executes-code source. Prints real findings + facts for 4 cases:
//  (a) our echo piece, no manifest          -> metadata ok, warn 'no-manifest'
//  (b) same echo with a correct manifest    -> ok:true, no 'no-manifest' warn
//  (c) community slack, manifest w/o egress -> undeclared-egress warns + detected hosts
//  (d) synthetic source with eval( no manifest -> ERROR 'undeclared-executes-code', ok:false
import { validatePieceDir } from "./src/validate-from-dir.ts";
import { validatePiece } from "./src/piece-sdk.ts";

const ECHO =
  "/home/administrador/product/packages/engine-adapter/custom-pieces-echo";
const SLACK = "/home/administrador/ap/packages/pieces/community/slack";

function dump(label, r) {
  console.log(`\n=== ${label} ===`);
  console.log(`ok: ${r.ok}`);
  for (const f of r.findings) {
    console.log(`  [${f.level}] ${f.code}: ${f.message}`);
  }
  if (r.facts) {
    console.log(`  facts.egressDomains: ${JSON.stringify(r.facts.egressDomains)}`);
    console.log(`  facts.readsEnv: ${r.facts.readsEnv}`);
    console.log(`  facts.readsFiles: ${r.facts.readsFiles}`);
    console.log(`  facts.executesCode: ${r.facts.executesCode}`);
  }
}

// (a) echo, no manifest.
dump("(a) echo / no manifest", validatePieceDir(ECHO));

// (b) echo with a correct manifest: auth SECRET_TEXT, egress [].
const echoManifest = { auth: "SECRET_TEXT", network: { egress: [] } };
dump("(b) echo / manifest {auth:SECRET_TEXT, egress:[]}", validatePieceDir(ECHO, echoManifest));

// (c) community slack with a manifest that does NOT declare slack's egress hosts.
const slackManifest = { auth: "OAUTH2", network: { egress: [] } };
const rSlack = validatePieceDir(SLACK, slackManifest);
dump("(c) slack / manifest {auth:OAUTH2, egress:[]}", rSlack);
console.log(`  detected egress hosts (from source): ${JSON.stringify(rSlack.facts?.egressDomains)}`);

// (d) synthetic source containing eval( with NO manifest -> the A2E guard must
// fire ERROR 'undeclared-executes-code' (declared would be a warn; this is not).
const synthSource =
  "const x = eval('1 + 1');\nexport const bad = () => x;\n";
const synthMeta = {
  name: "synth-bad",
  displayName: "Synth Bad",
  description: "Synthetic piece for executes-code guard test",
  actions: [{ name: "run", description: "runs arbitrary code" }],
};
dump("(d) synthetic eval( source", validatePiece(synthMeta, synthSource));