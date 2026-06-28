// smoke-agent: prueba e2e del AGENT RUNTIME (loop A2E).
// (a) STUB: loop completo SIN modelo (determinista) -> debe dar SUCCEEDED {a:1}.
// (b) OLLAMA real (BEST-EFFORT): llama a gemma4:31b-cloud; reporta honestamente
//     respondio? / ExecuteRequest? / ejecuto? Sin afirmar exito del modelo.
// Mata todo al final.
import { start, PRODUCT_PORT } from './src/index.ts';
import { runAgent } from '../agent-runtime/src/orchestrator.ts';
import { stubProvider } from '../agent-runtime/src/stub-provider.ts';
import { callOllama } from '../agent-runtime/src/ollama-provider.ts';

const BASE = `http://localhost:${PRODUCT_PORT}`;
let failed = false;
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed = true;
};

// Ollama corre en Windows (127.0.0.1:11434); desde WSL se alcanza via el host IP
// del adaptador WSL. Se usa para la parte (b) real; la (a) no toca ollama.
process.env.OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://172.20.208.1:11434';
process.env.OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma4:31b-cloud';

const app = await start();
try {
  // ---- (a) STUB e2e (determinista, sin modelo) ----
  console.log('=== (a) STUB e2e ===');
  const stubReq = JSON.stringify({
    steps: [
      {
        name: 'parse',
        pieceName: '@activepieces/piece-json',
        pieceVersion: '0.1.8',
        actionName: 'convert_text_to_json',
        input: { text: '{"a":1}' },
      },
    ],
  });
  const a = await runAgent('Convert the text {"a":1} to JSON using the json piece.', {
    apiBase: BASE,
    llm: stubProvider(stubReq),
    maxRetries: 3,
  });
  console.log('attempts=', a.attempts, 'ok=', a.ok);
  console.log('transcript:', JSON.stringify(a.transcript, null, 2));
  ok('(a) stub ok:true', a.ok === true);
  ok('(a) stub attempts===1', a.attempts === 1, `(got ${a.attempts})`);
  ok('(a) stub result SUCCEEDED', a.result?.status === 'SUCCEEDED', `(got ${a.result?.status})`);
  ok('(a) stub output {a:1}', a.result?.output && a.result.output.a === 1, JSON.stringify(a.result?.output));

  // ---- (b) OLLAMA real (gemma4:31b-cloud), best-effort, con timeout ----
  console.log('\n=== (b) OLLAMA real (gemma4:31b-cloud) ===');
  const task =
    'Compose a workflow that converts the text \'{"hello":"world"}\' to JSON using the json piece. ' +
    'Reply with ONLY a JSON object ExecuteRequest of shape {"steps":[{"name":string,' +
    '"pieceName":"@activepieces/piece-json","pieceVersion":"0.1.8",' +
    '"actionName":"convert_text_to_json","input":{"text":"{\\"hello\\":\\"world\\"}"}}]} ' +
    'and nothing else.';
  const OLLAMA_TIMEOUT_MS = 180000;
  let b = null;
  let bErr = null;
  try {
    b = await Promise.race([
      runAgent(task, { apiBase: BASE, llm: (p, s) => callOllama(p, { system: s }), maxRetries: 2 }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`smoke timeout ${OLLAMA_TIMEOUT_MS}ms`)), OLLAMA_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    bErr = e;
  }

  if (bErr) {
    console.log('(b) runAgent rechazado/timeout:', bErr.message);
    console.log('(b) honest report: respondio=NO (error/timeout), ExecuteRequest=NO, ejecuto=NO');
  } else {
    console.log('attempts=', b.attempts, 'ok=', b.ok);
    console.log('transcript:', JSON.stringify(b.transcript, null, 2));
    if (b.request) console.log('(b) parsed request:', JSON.stringify(b.request));
    if (b.result) console.log('(b) exec result:', JSON.stringify(b.result));
    const responded = b.transcript.some((t) => t.includes('raw=') && !t.includes('raw=""'));
    const composedReq = !!b.request || b.transcript.some((t) => t.includes('exec status='));
    const executed = b.ok === true;
    console.log(
      `(b) honest report: respondio=${responded ? 'SI' : 'NO'}, ` +
        `ExecuteRequest=${composedReq ? 'SI (al menos parseo/ejecuto)' : 'NO'}, ` +
        `ejecuto=${executed ? 'SUCCEEDED' : 'no SUCCEEDED'} (${b.attempts} intento/s)`,
    );
  }
  // (b) es informativo: NO hace fallar el smoke (es un LLM real, best-effort).
} finally {
  await app.close();
  console.log(failed ? '\n=== SMOKE-AGENT FAILED ===' : '\n=== SMOKE-AGENT PASSED ===');
  process.exit(failed ? 1 : 0);
}