/**
 * Isolamento de tenant EXPLÍCITO (ADR-G2).
 *
 * Toda consulta a dado de negócio deve passar por aqui: nunca escreva um `where`
 * de negócio sem o filtro de grupo. Deployment (banco único) != isolation — o
 * isolamento é este mecanismo, não a topologia do banco.
 *
 * Uso:
 *   prisma.product.findMany({ where: tenantScope(groupId, { state: 'PUBLISHED' }) })
 *   prisma.product.findFirst({ where: tenantScope(groupId, { id }) })
 */
export function tenantScope<T extends Record<string, unknown>>(
  groupId: string,
  where: T = {} as T,
): T & { groupId: string } {
  return { ...where, groupId };
}
