import type { Prisma, OrderStatus, OrderActor } from '@prisma/client';

/**
 * Transições VÁLIDAS do pedido (máquina de estados — clean-code: tabela explícita,
 * não `if` espalhado). Transições com efeito colateral (PAID, CANCELLED, REFUNDED)
 * têm endpoints dedicados; as "de operação" abaixo passam pelo /transition genérico.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['PAID', 'CANCELLED'],
  PAID: ['FULFILLED', 'SHIPPED', 'REFUNDED'],
  FULFILLED: ['SHIPPED', 'REFUNDED'],
  SHIPPED: ['DELIVERED', 'REFUNDED'],
  DELIVERED: [],
  CANCELLED: [],
  REFUNDED: [],
};

/** Transições que a loja pode aplicar pelo endpoint genérico /transition (sem efeitos especiais). */
export const STORE_TRANSITIONS: OrderStatus[] = ['FULFILLED', 'SHIPPED', 'DELIVERED'];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Registra uma mudança de status na linha do tempo (append-only). */
export async function recordOrderEvent(
  tx: Prisma.TransactionClient,
  orderId: string,
  from: OrderStatus | null,
  to: OrderStatus,
  actor: OrderActor,
  rm: string | null,
  note?: string,
): Promise<void> {
  await tx.orderEvent.create({ data: { orderId, fromStatus: from, toStatus: to, actor, rm, note } });
}
