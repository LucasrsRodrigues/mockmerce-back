import type { Prisma, PaymentMethod } from '@prisma/client';
import { emitEvent } from '../../lib/outbox.js';
import { money } from '../../lib/serialize.js';
import { commitForOrder } from '../inventory/service.js';
import { recordOrderEvent } from '../orders/stateMachine.js';

type Tx = Prisma.TransactionClient;

/**
 * Efeito ÚNICO de um resultado de pagamento sobre o pedido (fonte da verdade
 * compartilhada por orders/pay e pelo settle do sandbox):
 *  - aprovado  → baixa a reserva de estoque, marca o pedido PAID, emite order.paid
 *  - recusado  → nada no estoque
 * Em ambos os casos grava/atualiza o Payment do pedido e emite payment.approved/declined.
 */
export async function applyPaymentResult(
  tx: Tx,
  params: { groupId: string; orderId: string; rm: string | null; amount: Prisma.Decimal | number; method: PaymentMethod; approved: boolean; transactionId: string },
): Promise<void> {
  const { groupId, orderId, rm, amount, method, approved, transactionId } = params;

  if (approved) {
    await commitForOrder(tx, groupId, orderId, rm);
    await tx.order.update({ where: { id: orderId }, data: { status: 'PAID' } });
    await recordOrderEvent(tx, orderId, 'PENDING', 'PAID', 'SYSTEM', rm, 'pagamento aprovado');
    await emitEvent(tx, groupId, 'order.paid', { orderId, total: money(amount) });
    // E-mail de confirmação no outbox (fake — não envia de verdade).
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { customer: { select: { email: true, name: true } } } });
    if (order?.customer) {
      await tx.emailOutbox.create({ data: { groupId, to: order.customer.email, template: 'order_confirmation', payload: { orderId, name: order.customer.name, total: money(amount) } } });
    }
  }

  await tx.payment.upsert({
    where: { orderId },
    create: { orderId, method, amount, status: approved ? 'APPROVED' : 'DECLINED', transactionId },
    update: { method, status: approved ? 'APPROVED' : 'DECLINED', transactionId },
  });

  await emitEvent(tx, groupId, approved ? 'payment.approved' : 'payment.declined', { orderId, method, amount: money(amount) });
}
