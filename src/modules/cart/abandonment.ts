import { prisma } from '../../prisma.js';
import { emitEvent } from '../../lib/outbox.js';
import { env } from '../../env.js';

/**
 * Marca carrinhos ACTIVE sem atividade há > ABANDON_TTL_MINUTES como ABANDONED,
 * emite `cart.abandoned` e registra um e-mail de recuperação no outbox.
 * Idempotente. Pode rodar para um grupo (teste) ou global (job).
 */
export async function runAbandonment(groupId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - env.ABANDON_TTL_MINUTES * 60_000);
  const carts = await prisma.cart.findMany({
    where: { status: 'ACTIVE', lastActivityAt: { lt: cutoff }, items: { some: {} }, ...(groupId ? { groupId } : {}) },
    include: { customer: { select: { email: true, name: true } } },
  });

  for (const c of carts) {
    await prisma.$transaction(async (tx) => {
      await tx.cart.update({ where: { id: c.id }, data: { status: 'ABANDONED' } });
      await emitEvent(tx, c.groupId, 'cart.abandoned', { cartId: c.id, customerId: c.customerId });
      await tx.emailOutbox.create({ data: { groupId: c.groupId, to: c.customer.email, template: 'cart_recovery', payload: { cartId: c.id, name: c.customer.name } } });
    });
  }
  return carts.length;
}

export function startAbandonmentJob(intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    runAbandonment().catch((err) => console.error('[abandonment] erro:', err));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
