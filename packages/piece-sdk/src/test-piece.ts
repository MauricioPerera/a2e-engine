// test-piece — HARNESS e2e: corre una action de una piece DE VERDAD a traves del
// engine Activepieces (bundledo, en-proceso) y evalua su output real contra `expect`.
// Convierte "validado" en hecho verificado dinamicamente: no hay stubs, la action se
// ejecuta y el matcher (test-match) caza diferencias reales.
//
// Reusa:
//   - piece-sdk/test-match: evaluateCase / summarizeResults (PURO, certificado).
//   - flow-builder: buildPieceStep -> nodo PieceAction que el engine valida.
//   - engine-adapter/src/execute-flow.cjs: executeFlow -> {verdict, steps} en-proceso.
//   - backend-mock (via bin/start-mock.ts): vault + server HTTP para la rama connection.
//
// El bundle de la piece DEBE existir en <piecesPath> (layout del loader:
//   <piecesPath>/pieces/@<scope>/piece-<name>-<version>/node_modules/@<scope>/piece-<name>/).
// El engine resuelve la piece via process.env.AP_CUSTOM_PIECES_PATHS=<piecesPath>.
//
// LIMITACION (honesta): las pieces que requieren RED externa real (HTTP a terceros,
// OAuth real, APIs de pago) o credenciales reales de terceros NO se pueden testear
// offline. El harness soporta `connection` (via vault del mock) para pieces que solo
// leen context.auth y no llaman afuera; la red externa real queda fuera del alcance.

import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPieceStep } from "../../flow-builder/src/flow-builder.js";
import {
  evaluateCase,
  summarizeResults,
  type CaseResult,
  type Summary,
  type TestCase,
} from "./test-match.js";

const require = createRequire(import.meta.url);
// execute-flow.cjs es CommonJS y carga el engine bundledo (dist/engine.cjs).
// Se requiere de forma perezosa DESPUES de setear env, por si el engine captura
// AP_CUSTOM_PIECES_PATHS al cargar (defensivo; en la practica lo lee por ejecucion).
let _executeFlow: ((args: unknown) => Promise<FlowResult>) | null = null;
function getExecuteFlow(): (args: unknown) => Promise<FlowResult> {
  if (!_executeFlow) {
    const mod = require("../../engine-adapter/src/execute-flow.cjs") as {
      executeFlow: (args: unknown) => Promise<FlowResult>;
    };
    _executeFlow = mod.executeFlow;
  }
  return _executeFlow;
}

// Shape real que devuelve executeFlow(...).finishExecution() (observado en run-demo):
//   { verdict: {status}, steps: Record<stepName, {status, output, errorMessage?}> }
type StepOutput = { status?: string; output?: unknown; errorMessage?: unknown };
type FlowResult = { verdict: { status?: string }; steps: Record<string, StepOutput> };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START_MOCK = path.resolve(__dirname, "..", "bin", "start-mock.ts");
const ENGINE_TOKEN = "dev-engine-token"; // coherente con execute-flow buildConstants.

export type TestPieceOptions = {
  // Raiz (outRoot) donde viven los bundles: <piecesPath>/pieces/@<scope>/...
  piecesPath: string;
  pieceName: string;
  pieceVersion: string;
  cases: TestCase[];
  // Si se pasa `connection`, se arranca el mock en este puerto (o uno libre si
  // se omite) sembrando la credencial, y se apunta internalApiUrl del engine ahi.
  mockPort?: number;
  connection?: {
    externalId: string;
    // debe coincidir con el projectId del engine (normalmente "demo-project").
    projectId: string;
    // AppConnectionValue: {type:"SECRET_TEXT", secret_text} | BASIC_AUTH | CUSTOM_AUTH | NO_AUTH
    value: unknown;
    pieceName?: string; // default: opts.pieceName
    displayName?: string; // default: externalId
  };
};

export type TestPieceResult = { results: CaseResult[]; summary: Summary };

/** Pide al SO un puerto TCP libre (bind a 0) y lo libera. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv: NetServer = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("could not pick a free port"));
      srv.close();
    });
  });
}

/** Resuelve el binario tsx: prefiere $HOME/product/node_modules/.bin/tsx. */
function tsxBin(): string {
  return path.join(os.homedir(), "product", "node_modules", ".bin", "tsx");
}

/** Arranca start-mock.ts como child y resuelve cuando imprime "LISTENING <port>". */
function startMock(opts: {
  port: number;
  engineToken: string;
  projectId: string;
  externalId: string;
  pieceName: string;
  displayName: string;
  value: unknown;
}): Promise<ChildProcess> {
  const valueB64 = Buffer.from(JSON.stringify(opts.value), "utf-8").toString("base64");
  const args = [
    START_MOCK,
    String(opts.port),
    opts.engineToken,
    opts.projectId,
    opts.externalId,
    opts.pieceName,
    opts.displayName,
    valueB64,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrBuf = "";
    const onStdout = (chunk: Buffer): void => {
      const text = chunk.toString("utf-8");
      const m = text.match(/LISTENING (\d+)/);
      if (m) {
        child.stdout?.off("data", onStdout);
        const gotPort = Number(m[1]);
        if (gotPort === opts.port) resolve(child);
        else reject(new Error(`mock listened on ${gotPort}, expected ${opts.port}`));
      }
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", (c: Buffer) => {
      stderrBuf += c.toString("utf-8");
    });
    child.on("error", (e) => reject(new Error(`failed to spawn tsx: ${e.message}`)));
    child.on("exit", (code) => {
      reject(new Error(`mock exited before LISTENING (code=${code}): ${stderrBuf.trim()}`));
    });
  });
}

/** Mata al mock de forma graceful (SIGTERM); no falla si ya murio. */
function stopMock(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    // Salvaguarda: si SIGTERM no cierra en 2s, fuerza.
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }, 2000).unref();
  });
}

/**
 * Corre cada TestCase contra la action real via el engine y evalua el output.
 * - Setea AP_CUSTOM_PIECES_PATHS=piecesPath y AP_EXECUTION_MODE=UNSANDBOXED.
 * - (si connection) arranca el mock, siembra el vault, apunta internalApiUrl al mock.
 * - Por cada caso: buildPieceStep -> executeFlow -> extrae {status, output, error}
 *   -> evaluateCase. Errores por caso se capturan sin colgar el lote.
 * Devuelve results + summary. Siempre mata al mock al terminar.
 *
 * Para testear una action con auth: poner `{{connections['<externalId>']}}` en el
 * input del caso (typo en input.auth) y pasar `connection` para sembrar el mock.
 */
export async function testPieceAction(opts: TestPieceOptions): Promise<TestPieceResult> {
  const piecesPath = path.resolve(opts.piecesPath);
  // El engine lee estas vars al resolver la piece (y al ejecutar). Se setean antes
  // del primer require de execute-flow.cjs y de cada llamada.
  process.env.AP_CUSTOM_PIECES_PATHS = piecesPath;
  process.env.AP_EXECUTION_MODE = "UNSANDBOXED";

  const runFlow = getExecuteFlow();
  const STEP_NAME = "t";
  const lastUpdated = new Date().toISOString();

  let mockChild: ChildProcess | null = null;
  let port = opts.mockPort ?? 3997; // sin connection, el engine no llama al mock; valor neutro.
  const projectId = opts.connection?.projectId ?? "demo-project";
  const engineToken = ENGINE_TOKEN;

  if (opts.connection) {
    const c = opts.connection;
    const pieceName = c.pieceName ?? opts.pieceName;
    const displayName = c.displayName ?? c.externalId;
    if (opts.mockPort !== undefined) port = opts.mockPort;
    else port = await freePort();
    mockChild = await startMock({
      port,
      engineToken,
      projectId: c.projectId,
      externalId: c.externalId,
      pieceName,
      displayName,
      value: c.value,
    });
  }

  const results: CaseResult[] = [];
  try {
    for (const tc of opts.cases) {
      try {
        const step = buildPieceStep(
          {
            name: STEP_NAME,
            pieceName: opts.pieceName,
            pieceVersion: opts.pieceVersion,
            actionName: tc.actionName,
            input: tc.input,
          },
          lastUpdated,
        );
        const result = await runFlow({ action: step, port, engineToken, projectId });
        const so: StepOutput | undefined = result.steps?.[STEP_NAME];
        const err = so?.errorMessage;
        const exec = {
          status: so?.status,
          output: so?.output,
          error:
            err === undefined || err === null
              ? undefined
              : typeof err === "string"
                ? err
                : JSON.stringify(err),
        };
        results.push(evaluateCase(tc, exec));
      } catch (e) {
        // Un caso que lanza no cuelga el lote: se reporta como FAIL con el error.
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ name: tc.name, passed: false, mismatches: [], error: `harness: ${msg}` });
      }
    }
  } finally {
    if (mockChild) await stopMock(mockChild);
  }

  const summary = summarizeResults(results);
  return { results, summary };
}