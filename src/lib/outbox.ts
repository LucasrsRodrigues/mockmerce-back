import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';

/** Cliente Prisma OU uma transação — o emit funciona em ambos. */
type DbClient = Prisma.TransactionClient | typeof prisma;

/**
 * Padrão Outbox (ADR-G5): grava um evento de domínio. Quando chamado DENTRO de
 * uma transação (passando `tx`), o evento é persistido atomicamente junto com a
 * mudança de estado — nunca se perde por falha de rede.
 *
 * A ENTREGA aos webhooks dos grupos (relay, retry, assinatura) é implementada
 * no épico f1-webhooks. Aqui apenas registramos o evento como PENDING.
 */
export async function emitEvent(
  client: DbClient,
  groupId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.outboxEvent.create({ data: { groupId, type, payload: payload as Prisma.InputJsonValue } });
}
