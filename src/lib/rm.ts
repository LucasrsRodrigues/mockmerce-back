/**
 * Normaliza um RM digitado. Como TODO RM começa com "RM", o prefixo é opcional
 * na entrada: se o aluno informar só os números (ex.: "550001") ou usar "rm"
 * minúsculo, completamos para o formato canônico "RM<numeros>" (ex.: "RM550001").
 * Qualquer outro formato passa inalterado — a busca/validação seguinte decide.
 */
export function normalizeRm(input: string): string {
  const t = input.trim();
  if (/^\d+$/.test(t)) return `RM${t}`; // só números → completa com "RM"
  if (/^rm\d+$/i.test(t)) return `RM${t.slice(2)}`; // "rm123"/"Rm123" → "RM123"
  return t;
}
