import type { OperatorRole } from '@prisma/client';
import { prisma } from '../../prisma.js';

/**
 * RBAC deny-by-default (secure-coding). Papéis mapeados para permissões em código
 * (subdomínio generic — não precisa de editor dinâmico de permissões). `*` = tudo.
 */
const PERMISSIONS: Record<OperatorRole, string[]> = {
  ADMIN: ['*'],
  MONITOR: ['groups:read', 'logs:read', 'activity:read', 'audit:read', 'config:read'],
  VIEWER: ['groups:read', 'logs:read', 'activity:read'],
};

export function hasPermission(role: OperatorRole, permission: string): boolean {
  const perms = PERMISSIONS[role] ?? [];
  return perms.includes('*') || perms.includes(permission);
}

/** Contexto do operador autenticado (via master token ou token de operador). */
export interface OperatorContext {
  id: string | null;
  email: string | null;
  role: OperatorRole;
  isMaster: boolean;
}

/** Grava uma entrada de auditoria (fire-and-forget). */
export async function recordAudit(
  operator: OperatorContext,
  action: string,
  details: { targetType?: string; targetId?: string; groupId?: string; meta?: Record<string, unknown> } = {},
): Promise<void> {
  await prisma.auditLog
    .create({
      data: {
        operatorId: operator.id, operatorEmail: operator.email, tokenMaster: operator.isMaster,
        action, targetType: details.targetType, targetId: details.targetId, groupId: details.groupId,
        meta: (details.meta ?? undefined) as any,
      },
    })
    .catch(() => {});
}
