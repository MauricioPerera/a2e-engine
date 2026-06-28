// stub-provider: LLM determinista para tests SIN modelo.
// stubProvider(fixed) -> (prompt, system?) => Promise<fixed>.
// Ignora prompt y system: devuelve siempre el fixed (un ExecuteRequest serializado).
// Permite ejercitar el loop completo del orquestador de forma estable.

export function stubProvider(
  fixed: string,
): (prompt: string, system?: string) => Promise<string> {
  return async (_prompt: string, _system?: string): Promise<string> => fixed;
}