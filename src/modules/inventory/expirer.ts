import { prisma } from '../../prisma.js';
import { emitEvent } from '../../lib/outbox.js';
import { releaseForOrder } from './service.js';

/**
 * Libera reservas de estoque vencidas (ACTIVE com expiresAt no passado) e cancela
 * o pedido correspondente. Idempotente: só age em reservas ACTIVE. Pode ser
 * chamado por um grupo (para testes determinísticos) ou globalmente pelo job.
 */
export async function expireReservations(groupId?: string): Promise<number> {
  const now = new Date();
  const expired = await prisma.reservation.findMany({
    where: { status: 'ACTIVE', expiresAt: { lt: now }, ...(groupId ? { groupId } : {}) },
    select: { orderId: true },
    distinct: ['orderId'],
  });

  let count = 0;
  for (const { orderId } of expired) {
    await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, groupId: true, status: true } });
      if (!order) return;
      await releaseForOrder(tx, order.groupId, orderId, null, 'reserva expirada');
      if (order.status === 'PENDING') {
        await tx.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } });
        await emitEvent(tx, order.groupId, 'order.cancelled', { orderId, reason: 'reservation_expired' });
      }
    });
    count += 1;
  }
  return count;
}

/** Inicia o job periódico (a cada `intervalMs`). Retorna um stop(). */
export function startReservationExpirer(intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    expireReservations().catch((err) => console.error('[expirer] erro:', err));
  }, intervalMs);
  timer.unref?.(); // não segura o processo vivo
  return () => clearInterval(timer);
}
