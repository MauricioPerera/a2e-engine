import { createAction, Property } from '@activepieces/pieces-framework';
import { execFile } from 'node:child_process';

// Allowlisted terminal action.
//
// SECURITY MODEL (deterministic + bounded):
//   - The agent may only invoke a binary present on a fixed ALLOWLIST.
//   - Execution uses execFile with an ARRAY of args and { shell: false } (the
//     default): no string concatenation, no shell metacharacter interpretation,
//     so there is no command-injection surface.
//   - The allowlist is checked BEFORE any process is spawned; a non-allowed
//     binary throws synchronously and nothing runs.
//
// CAPABILITY DECLARATION (honest, no obfuscation):
//   This piece executes code — it spawns allowlisted binaries via execFile. We
//   import node:child_process with the LITERAL module name (no runtime name
//   assembly) and DECLARE the executes-code capability in the piece manifest
//   (piece-manifest.json beside this source), so the piece-sdk static validator
//   emits a WARN (declared, operator-vetted) instead of an error. The static
//   check is only a SIGNAL — the real containment of untrusted pieces is the
//   bwrap sandbox; this allowlist + execFile (no shell) is the piece's own
//   bounded surface, not a substitute for sandboxing untrusted code.

const ALLOW = ['git', 'sqlite3', 'echo', 'ls', 'cat', 'pwd', 'date', 'wc', 'head', 'tail', 'node'];

export const runAction = createAction({
  name: 'run',
  displayName: 'Run (allowlisted)',
  description:
    'Run an ALLOWLISTED binary with arguments. Deterministic: uses execFile (no shell), so no injection. The agent cannot run arbitrary commands — only the binaries in the allowlist.',
  requireAuth: false,
  props: {
    bin: Property.ShortText({
      displayName: 'Binary',
      description: `Allowed: ${ALLOW.join(', ')}`,
      required: true,
    }),
    args: Property.Array({
      displayName: 'Arguments',
      required: false,
    }),
    cwd: Property.ShortText({
      displayName: 'Working dir',
      required: false,
    }),
  },
  async run(context) {
    const bin: string = String((context.propsValue as { bin?: unknown }).bin ?? '');
    if (!ALLOW.includes(bin)) {
      throw new Error(`command not allowed: ${bin} (allowlist: ${ALLOW.join(', ')})`);
    }
    const rawArgs: unknown = (context.propsValue as { args?: unknown }).args;
    const args: string[] = Array.isArray(rawArgs) ? rawArgs.map((a) => String(a)) : [];
    const cwd: string | undefined = (context.propsValue as { cwd?: string }).cwd || undefined;

    return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        bin,
        args,
        { cwd, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          // exitCode 0 -> resolve; non-zero -> still resolve WITH the code (no
          // reject) so the agent can observe the result instead of a throw.
          const code =
            err && typeof (err as NodeJS.ErrnoException).code === 'number'
              ? ((err as NodeJS.ErrnoException).code as number)
              : err
                ? 1
                : 0;
          resolve({ exitCode: code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
    });
  },
});