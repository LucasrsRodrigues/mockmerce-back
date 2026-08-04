/**
 * Serializa linhas em CSV com prevenção de CSV/Formula injection (secure-coding):
 * células que começam com = + - @ (ou tab/CR) são prefixadas com aspa simples,
 * para o Excel/Sheets não as interpretar como fórmula.
 */
function sanitizeCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string {
  const header = columns.map((c) => sanitizeCell(c.label)).join(',');
  const lines = rows.map((r) => columns.map((c) => sanitizeCell(r[c.key])).join(','));
  return [header, ...lines].join('\n');
}
