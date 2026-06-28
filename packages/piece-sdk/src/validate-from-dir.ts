// piece-validator/validate-from-dir — adapts the PURE piece-sdk validator to
// a real piece directory: reads all .ts under <dir>/src, parses piece metadata
// (name/displayName/description + actions) from source via regex (same style as
// piece-source-manager/discover.ts), concatenates the source, and calls
// validatePiece(meta, source, manifest).
//
// No execution, no bundling: source is read as TEXT and matched with regex.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  validatePiece,
  type ActionMeta,
  type CapabilityManifest,
  type PieceMetaLike,
  type ValidationResult,
} from "./piece-sdk.ts";

/** Walk a directory tree collecting .ts file paths (skips node_modules/dist). */
function walkTs(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e === "node_modules" || e === "dist") continue;
      const full = path.join(dir, e);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile() && full.endsWith(".ts")) out.push(full);
    }
  }
  return out;
}

/** Extract every balanced `<fnName>(...)` call object body from content.
 *  Parenthesis-balanced (does not understand strings — same limitation as
 *  discover.ts; acceptable for author-time regex parsing). */
function extractCallObjects(content: string, fnName: string): string[] {
  const re = new RegExp("\\b" + fnName + "\\s*\\(", "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const start = m.index;
    let i = content.indexOf("(", start);
    if (i < 0) continue;
    let depth = 0;
    let end = -1;
    for (; i < content.length; i++) {
      const c = content[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end >= 0) out.push(content.slice(start, end + 1));
    else break; // unbalanced (truncated source): stop
  }
  return out;
}

/** First string/template literal assigned to `<field>:` in content.
 *  Uses \b<field>: so that `name:` does not match inside `displayName:`. */
function extractStringField(content: string, field: string): string | undefined {
  const re = new RegExp(
    "\\b" + field + ":\\s*('([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'|" +
      '"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|' +
      "`([^`]*)`)",
    "s",
  );
  const m = re.exec(content);
  if (!m) return undefined;
  const raw = m[2] ?? m[3] ?? m[4] ?? "";
  return raw.replace(/\\(.)/g, "$1").replace(/\s+/g, " ").trim();
}

/** Parse every `createAction({...})` block across the piece's .ts files into
 *  ActionMeta (name + displayName + description). Best-effort regex parse. */
function parseActions(files: string[]): ActionMeta[] {
  const actions: ActionMeta[] = [];
  for (const f of files) {
    let txt: string;
    try {
      txt = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const block of extractCallObjects(txt, "createAction")) {
      const name = extractStringField(block, "name");
      if (!name) continue; // not a real action block (e.g. nested call)
      actions.push({
        name,
        displayName: extractStringField(block, "displayName"),
        description: extractStringField(block, "description"),
      });
    }
  }
  return actions;
}

/** Build a PieceMetaLike from a piece directory: name from package.json (fallback
 *  to dir basename), displayName/description from the createPiece block in
 *  src/index.ts, actions from every createAction block under src/. */
function parsePieceMeta(pieceDir: string): PieceMetaLike {
  const pkgPath = path.join(pieceDir, "package.json");
  let name: string;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
    name = pkg.name ?? path.basename(pieceDir);
  } catch {
    name = path.basename(pieceDir);
  }
  let idx = "";
  try {
    idx = readFileSync(path.join(pieceDir, "src", "index.ts"), "utf8");
  } catch {
    // no index.ts; meta will be sparse and validation will flag it
  }
  const pieceObj = extractCallObjects(idx, "createPiece")[0] ?? idx;
  const displayName = extractStringField(pieceObj, "displayName");
  const description = extractStringField(pieceObj, "description");
  const srcDir = path.join(pieceDir, "src");
  const files = existsSync(srcDir) ? walkTs(srcDir) : [];
  const actions = parseActions(files);
  return { name, displayName, description, actions };
}

/** Concatenate all .ts source under <dir>/src into one string for fact extraction. */
function readAllSource(files: string[]): string {
  return files
    .map((f) => {
      try {
        return readFileSync(f, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

/**
 * Validate a real piece directory against the piece-sdk validator.
 * Reads all .ts under <dir>/src, parses metadata from source, and calls
 * validatePiece(meta, source, manifest). Returns the full ValidationResult
 * (ok, findings, facts).
 */
export function validatePieceDir(
  dir: string,
  manifest?: CapabilityManifest,
): ValidationResult {
  const pieceDir = path.resolve(dir);
  const srcDir = path.join(pieceDir, "src");
  const files = existsSync(srcDir) ? walkTs(srcDir) : [];
  const source = readAllSource(files);
  const meta = parsePieceMeta(pieceDir);
  return validatePiece(meta, source, manifest);
}