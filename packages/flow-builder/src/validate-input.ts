// validate-input.ts — validador PURO del input que el agente manda para una action.
// Compara el input contra las props declaradas por la piece y devuelve errores
// claros/accionables ANTES de que el engine ejecute (feedback A2E al agente).
//
// MVP: valida REQUIRED + UNKNOWN. La validación profunda de TYPES es futura
// (ver TYPE-VALIDATION-FUTURE más abajo): por ahora basta avisar al agente qué
// prop falta o qué key no existe, en vez de dejar que el engine falle con un
// TypeError criptográfico.
//
// Pureza: sin red, sin FS, sin Date/aleatoriedad. Sólo aritmética sobre los
// dos Records que recibe. Determinista.

// Especificación mínima de una prop: su tipo (para el mensaje) y si es required.
// Es un subconjunto de okf-generator PieceProperty — lo mantenemos desacoplado
// para que el validador no dependa del catálogo.
export interface PropSpec {
  type: string;
  required: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

// Keys reservadas para credenciales: el agente NO las manda como props reales,
// son referencias de connection que el flow-builder inyecta después. La auth se
// valida aparte (requiere resolver la conexión contra el vault), así que aquí no
// se cuentan ni como prop faltante ni como unknown.
//
// MVP: sólo "auth" (la key por defecto que usa flow-builder para connectionRef).
// Si una piece usara un property distinto, el wiring puede normalizarlo antes
// de llamar (ver handleExecute); el validador se queda con el contrato simple.
const AUTH_KEYS: ReadonlySet<string> = new Set(["auth"]);

// Valida el input de una action contra sus props.
//   - REQUIRED: cada prop con required=true ausente (undefined/null/"") -> error.
//   - UNKNOWN:  cada key del input que no es prop ni key de auth -> error.
// Devuelve { ok, errors }; ok=true iff errors está vacío. No lanza.
//
// TYPE-VALIDATION-FUTURE: hoy no se chequea que el valor coincida con spec.type
// (ej. NUMBER con un string). Añadirlo aquí cuando se necesite, manteniendo la
// pureza (sin importar el catálogo ni el engine).
export function validateActionInput(
  input: Record<string, unknown>,
  props: Record<string, PropSpec>,
): ValidationResult {
  const errors: string[] = [];

  // REQUIRED: recorremos las props declaradas, no el input.
  for (const [name, spec] of Object.entries(props)) {
    if (!spec.required) continue;
    if (AUTH_KEYS.has(name)) continue; // auth se valida aparte
    const v = input[name];
    if (v === undefined || v === null || v === "") {
      errors.push(`missing required property "${name}" (${spec.type})`);
    }
  }

  // UNKNOWN: recorremos las keys realmente presentes en el input.
  for (const key of Object.keys(input)) {
    if (AUTH_KEYS.has(key)) continue; // referencia de connection, no prop
    if (!(key in props)) {
      errors.push(`unknown property "${key}"`);
    }
  }

  return { ok: errors.length === 0, errors };
}
