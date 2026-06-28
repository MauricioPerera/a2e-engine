#!/usr/bin/env node
// bin/validate-piece.mjs <piece-dir> [manifest.json]
// Runs validatePieceDir on a real piece directory and prints findings + facts.
// Exit code 1 if validation does not pass (ok === false), 0 otherwise.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validatePieceDir } from "../src/validate-from-dir.ts";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("usage: validate-piece.mjs <piece-dir> [manifest.json]");
  process.exit(2);
}

const dir = resolve(args[0]);
let manifest = undefined;
if (args[1]) {
  manifest = JSON.parse(readFileSync(resolve(args[1]), "utf8"));
}

const result = validatePieceDir(dir, manifest);
console.log(`piece: ${dir}`);
console.log(`ok: ${result.ok}`);
console.log("findings:");
for (const f of result.findings) {
  console.log(`  [${f.level}] ${f.code}: ${f.message}`);
}
if (result.facts) {
  console.log("facts:");
  console.log(`  egressDomains: ${JSON.stringify(result.facts.egressDomains)}`);
  console.log(`  readsEnv: ${result.facts.readsEnv}`);
  console.log(`  readsFiles: ${result.facts.readsFiles}`);
  console.log(`  executesCode: ${result.facts.executesCode}`);
}
process.exit(result.ok ? 0 : 1);