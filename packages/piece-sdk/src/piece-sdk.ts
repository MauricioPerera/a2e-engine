// piece-sdk — author-time validator for Activepieces pieces.
// Pure functions: no network, no FS, no Date. Metadata and source arrive as data.

export type CapabilityManifest = {
  network?: { egress: string[] };
  auth?: 'OAUTH2' | 'SECRET_TEXT' | 'CUSTOM_AUTH' | 'BASIC_AUTH' | 'NONE';
  readsEnv?: boolean;
  readsFiles?: boolean;
  executesCode?: boolean;
};

export type ActionMeta = {
  name: string;
  displayName?: string;
  description?: string;
  props?: Record<string, unknown>;
};

export type PieceMetaLike = {
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  auth?: { type: string };
  actions: ActionMeta[];
};

export type Finding = { level: 'error' | 'warn'; code: string; message: string };

export type CodeFacts = {
  egressDomains: string[];
  readsEnv: boolean;
  readsFiles: boolean;
  executesCode: boolean;
};

export type ValidationResult = {
  ok: boolean;
  findings: Finding[];
  facts?: CodeFacts;
};

const PIECE_NAME_RE = /^[@a-z0-9/_-]+$/;
const ACTION_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Validate the piece's display name and description metadata. */
function validateDisplay(meta: PieceMetaLike): Finding[] {
  const out: Finding[] = [];
  if (!meta.displayName) {
    out.push({ level: 'error', code: 'missing-displayName', message: 'piece is missing displayName' });
  }
  if (!meta.description || meta.description.length < 10) {
    out.push({ level: 'error', code: 'short-description', message: 'piece description is missing or shorter than 10 chars' });
  }
  return out;
}

/** Validate a single action's name and description. */
function validateAction(action: ActionMeta): Finding[] {
  const out: Finding[] = [];
  if (!action.name || !ACTION_NAME_RE.test(action.name)) {
    out.push({ level: 'error', code: 'invalid-action-name', message: `action has invalid or missing name: ${String(action.name)}` });
  }
  if (!action.description) {
    if (!action.displayName) {
      out.push({ level: 'error', code: 'action-missing-description', message: `action "${action.name}" is missing both description and displayName` });
    } else {
      out.push({ level: 'warn', code: 'action-missing-description', message: `action "${action.name}" is missing a description` });
    }
  }
  return out;
}

/** Validate piece metadata: naming, presence of displayName/description, and per-action shape. */
export function validateMetadata(meta: PieceMetaLike): Finding[] {
  const out: Finding[] = [];
  if (!meta.name || !PIECE_NAME_RE.test(meta.name)) {
    out.push({ level: 'error', code: 'invalid-piece-name', message: `piece name is invalid: ${String(meta.name)}` });
  }
  if (!meta.actions || meta.actions.length === 0) {
    out.push({ level: 'error', code: 'no-actions', message: 'piece declares no actions' });
    return out.concat(validateDisplay(meta));
  }
  out.push(...validateDisplay(meta));
  for (const action of meta.actions) {
    out.push(...validateAction(action));
  }
  return out;
}

const URL_HOST_RE = /https?:\/\/([^/"'`\s)]+)/g;
const READS_ENV_RE = /process\.env\b/;
const READS_FILES_RE = /\b(fs|node:fs)\b|readFile|writeFile/;
const EXECUTES_CODE_RE = /\beval\s*\(|new Function\s*\(|child_process|execSync|spawn\b/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Extract code facts from raw source: declared-egress hosts, env/file/code usage. */
export function extractCodeFacts(source: string): CodeFacts {
  const hosts = new Set<string>();
  let match: RegExpExecArray | null;
  URL_HOST_RE.lastIndex = 0;
  while ((match = URL_HOST_RE.exec(source)) !== null) {
    const host = match[1].toLowerCase().split(':')[0];
    if (!LOCAL_HOSTS.has(host)) hosts.add(host);
  }
  return {
    egressDomains: [...hosts],
    readsEnv: READS_ENV_RE.test(source),
    readsFiles: READS_FILES_RE.test(source),
    executesCode: EXECUTES_CODE_RE.test(source),
  };
}

/** Reconcile a present manifest against code-derived facts (egress/env/files). */
function reconcileDeclared(manifest: CapabilityManifest, facts: CodeFacts): Finding[] {
  const out: Finding[] = [];
  const declared = new Set((manifest.network?.egress ?? []).map((h) => h.toLowerCase()));
  for (const host of facts.egressDomains) {
    if (!declared.has(host)) {
      out.push({ level: 'warn', code: 'undeclared-egress', message: `code egresses to undeclared host: ${host}` });
    }
  }
  if (facts.readsEnv && manifest.readsEnv !== true) {
    out.push({ level: 'warn', code: 'undeclared-env-read', message: 'code reads process.env but manifest does not declare readsEnv' });
  }
  if (facts.readsFiles && manifest.readsFiles !== true) {
    out.push({ level: 'warn', code: 'undeclared-file-read', message: 'code reads files but manifest does not declare readsFiles' });
  }
  return out;
}

/** Reconcile declared capabilities against code-derived facts. */
export function reconcileCapabilities(manifest: CapabilityManifest | undefined, facts: CodeFacts): Finding[] {
  const out: Finding[] = [];
  if (!manifest) {
    out.push({ level: 'warn', code: 'no-manifest', message: 'piece has no capability manifest; capabilities undeclared' });
  } else {
    out.push(...reconcileDeclared(manifest, facts));
  }
  // executesCode is always an error, declared or not — forbidden in A2E pieces.
  if (facts.executesCode) {
    out.push({ level: 'error', code: 'executes-code', message: 'code executes arbitrary code (eval/Function/child_process); forbidden in A2E pieces' });
  }
  return out;
}

/** Full validation: metadata plus, when source is provided, code-fact reconciliation. */
export function validatePiece(meta: PieceMetaLike, source?: string, manifest?: CapabilityManifest): ValidationResult {
  let findings = validateMetadata(meta);
  let facts: CodeFacts | undefined;
  if (source) {
    facts = extractCodeFacts(source);
    findings = findings.concat(reconcileCapabilities(manifest, facts));
  }
  const ok = !findings.some((f) => f.level === 'error');
  return { ok, findings, facts };
}