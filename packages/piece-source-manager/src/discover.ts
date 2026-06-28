// Piece source discovery (fase SEGURA): dado un repo git o ruta local, lista
// las pieces disponibles SIN ejecutar ni bundlear codigo de pieces. Solo
// clona (git) / lee (FS) y PARSEA (regex) package.json + src/index.ts.
//
// El bundling/sandbox es una fase posterior; aqui no se importa ni se evalua
// codigo de las pieces: se leen como texto y se aplican regex sobre
// createPiece({ displayName, description, auth }).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface DiscoveredPiece {
  name: string;
  displayName: string;
  description: string;
  dir: string;
  auth?: string;
}

export interface DiscoverResult {
  sourceId: string;
  pieces: DiscoveredPiece[];
  total: number;
  warnings: string[];
}

export interface DiscoverOptions {
  source: string;
  ref?: string;
  workdir?: string;
}

const AUTH_TYPE_MAP: Record<string, string> = {
  SecretText: "SECRET_TEXT",
  CustomAuth: "CUSTOM_AUTH",
  OAuth2: "OAUTH2",
  BasicAuth: "BASIC_AUTH",
};

function isGitUrl(src: string): boolean {
  return (
    /^https?:\/\//i.test(src) ||
    /^git@/i.test(src) ||
    /\.git$/i.test(src) ||
    /^ssh:\/\/|^git:\/\//i.test(src)
  );
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function sourceIdFor(source: string, ref?: string): string {
  return "sm-" + createHash("sha1").update(source + "|" + (ref ?? "")).digest("hex").slice(0, 12);
}

// Clona shallow (sin historial) a <workdir>/<sourceId>. Devuelve el path local.
function cloneShallow(source: string, ref: string | undefined, dest: string): void {
  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  args.push(source, dest);
  execFileSync("git", args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

// Camina un directorio recursivamente, devolviendo rutas de archivos .ts.
// Salta node_modules y dist (evita leer dependencias vendorizadas).
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
      const full = path.join(dir, e);
      if (e === "node_modules" || e === "dist") continue;
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

// Extrae el substring del primer createPiece({...}) — balanceando parentesis
// para no quedarnos dentro de un sub-objeto (props/auth). Camina desde el "("
// tras createPiece contando profundidad hasta volver a 0. Si no encuentra
// createPiece( o el balance falla, devuelve el contenido entero (fallback).
function extractCreatePieceObject(content: string): string {
  const start = content.search(/createPiece\s*\(/);
  if (start < 0) return content;
  let i = content.indexOf("(", start);
  if (i < 0) return content;
  let depth = 0;
  for (; i < content.length; i++) {
    const c = content[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }
  return content.slice(start); // desbalanceado (string roto): usa lo que haya
}

// Extrae el primer string literal (o template literal) que sigue a `field:` en
// el contenido. Soporta comillas simples, dobles y backticks (multilinea).
function extractStringField(content: string, field: string): string | undefined {
  const re = new RegExp(
    field + ":\\s*('([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'|" +
    '"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|' +
    "`([^`]*)`)",
    "s",
  );
  const m = re.exec(content);
  if (!m) return undefined;
  // m[2]=single, m[3]=double, m[4]=template
  const raw = m[2] ?? m[3] ?? m[4] ?? "";
  // Desescapa lo minimo: newlines de template literals se conservan, colapsamos
  // a una linea para legibilidad del summary.
  return raw.replace(/\\(.)/g, "$1").replace(/\s+/g, " ").trim();
}

// Extrae el token del campo `auth:` (identificador o PieceAuth.X). Primer match.
function extractAuthToken(content: string): string | undefined {
  const m = /auth:\s*([A-Za-z0-9_.]+)/.exec(content);
  if (!m) return undefined;
  return m[1];
}

// Dado el token del campo auth, resuelve el tipo (SECRET_TEXT/CUSTOM_AUTH/OAUTH2/
// BASIC_AUTH). Si es inline PieceAuth.X -> directo. Si es variable, busca
// `const <id> = PieceAuth.<Type>(` en los .ts del piece (excluye node_modules/dist).
function resolveAuthType(token: string, pieceDir: string): string | undefined {
  const inline = /PieceAuth\.(\w+)/.exec(token);
  if (inline) {
    return AUTH_TYPE_MAP[inline[1]] ?? undefined;
  }
  if (token === "undefined") return undefined;
  // Buscar la definicion de la variable en el arbol src del piece.
  const idEscape = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const defRe = new RegExp("const\\s+" + idEscape + "\\s*=\\s*PieceAuth\\.(\\w+)");
  const srcDir = path.join(pieceDir, "src");
  if (!existsSync(srcDir)) return undefined;
  for (const f of walkTs(srcDir)) {
    let txt: string;
    try {
      txt = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const mm = defRe.exec(txt);
    if (mm) return AUTH_TYPE_MAP[mm[1]] ?? undefined;
  }
  return undefined;
}

// Procesa un directorio de piece: lee package.json + src/index.ts y extrae
// name/displayName/description/auth. Aisla fallos (lanza -> warning, no colapsa).
function scanPiece(pieceDir: string, root: string): DiscoveredPiece {
  const pkgPath = path.join(pieceDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
  const name = pkg.name ?? path.basename(pieceDir);
  const idxPath = path.join(pieceDir, "src", "index.ts");
  const idx = readFileSync(idxPath, "utf8");
  // Solo procesamos si createPiece esta presente (filtra librerias como
  // pieces-common / pieces-framework que viven bajo packages/pieces/*).
  if (!/createPiece\s*\(/.test(idx)) {
    throw new Error("no createPiece in src/index.ts (not a piece)");
  }
  // Acota al objeto createPiece({...}) para que displayName/description/auth sean
  // los del piece, no los de un Property/PieceAuth definido inline antes.
  const pieceObj = extractCreatePieceObject(idx);
  const displayName = extractStringField(pieceObj, "displayName") ?? name;
  const description = extractStringField(pieceObj, "description") ?? name;
  let auth: string | undefined;
  const authToken = extractAuthToken(pieceObj);
  if (authToken) auth = resolveAuthType(authToken, pieceDir);
  return {
    name,
    displayName,
    description,
    dir: path.relative(root, pieceDir).replace(/\\/g, "/"),
    ...(auth ? { auth } : {}),
  };
}

// Lista dirs candidato bajo root que contengan package.json + src/index.ts.
// Escanea community/* (primario) + custom/* y pieces/* (secundario, filtrado
// por createPiece para excluir libs).
function listPieceCandidates(root: string): string[] {
  const globs = [
    path.join("packages", "pieces", "community", "*"),
    path.join("packages", "pieces", "custom", "*"),
    path.join("packages", "pieces", "*"),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of globs) {
    const base = g.slice(0, g.lastIndexOf("*"));
    const parent = path.join(root, base.slice(0, -1));
    if (!existsSync(parent)) continue;
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      continue;
    }
    for (const e of entries) {
      const dir = path.join(parent, e);
      if (!statSync(dir).isDirectory()) continue;
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "src", "index.ts"))) {
        out.push(dir);
      }
    }
  }
  return out;
}

export async function discoverSource(opts: DiscoverOptions): Promise<DiscoverResult> {
  const source = expandHome(opts.source);
  const ref = opts.ref;
  const workdir = opts.workdir ?? os.tmpdir();
  const sourceId = sourceIdFor(opts.source, ref);
  const warnings: string[] = [];

  let root: string;
  if (isGitUrl(source)) {
    root = path.join(workdir, sourceId);
    // Reusa clone existente si ya esta (idempotente en re-llamadas).
    if (!existsSync(path.join(root, "package.json")) && !existsSync(path.join(root, ".git"))) {
      try {
        cloneShallow(source, ref, root);
      } catch (e) {
        throw new Error(`git clone failed: ${(e as Error).message}`);
      }
    }
  } else {
    // Ruta local: usar directamente, sin clonar ni copiar.
    if (!existsSync(source)) {
      throw new Error(`local source not found: ${source}`);
    }
    root = source;
  }

  const candidates = listPieceCandidates(root);
  const pieces: DiscoveredPiece[] = [];
  for (const dir of candidates) {
    try {
      pieces.push(scanPiece(dir, root));
    } catch (e) {
      warnings.push(`${path.relative(root, dir).replace(/\\/g, "/")}: ${(e as Error).message}`);
    }
  }

  return { sourceId, pieces, total: pieces.length, warnings };
}