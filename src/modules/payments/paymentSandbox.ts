import { randomBytes } from 'node:crypto';
import type { PaymentMethod } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { emitEvent } from '../../lib/outbox.js';
import { money } from '../../lib/serialize.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { applyPaymentResult } from './orderPayment.js';

// ------------------------------------------------------------- geradores fake
function digits(n: number): string {
  let s = '';
  for (const b of randomBytes(n)) s += (b % 10).toString();
  return s;
}
const providerRef = () => `pay_${randomBytes(12).toString('hex')}`;
/** Payload "copia e cola" do PIX (formato EMV plausível, fake). */
const pixPayload = () => `00020126580014br.gov.bcb.pix0136${randomBytes(18).toString('hex')}5204000053039865802BR5913LOJA DA TURMA6009SAO PAULO62070503***6304${digits(4)}`;
/** Linha digitável de boleto (fake). */
const boletoLine = () => `${digits(5)}.${digits(5)} ${digits(5)}.${digits(6)} ${digits(5)}.${digits(6)} ${digits(1)} ${digits(14)}`;

function artifactsFor(method: PaymentMethod, installments?: number) {
  switch (method) {
    case 'PIX': return { pixCopiaECola: pixPayload(), boletoLine: null, cardBrand: null };
    case 'BOLETO': return { pixCopiaECola: null, boletoLine: boletoLine(), cardBrand: null };
    case 'CREDIT_CARD': return { pixCopiaECola: null, boletoLine: null, cardBrand: 'visa' };
  }
}

function serialize(p: any) {
  return {
    id: p.id, method: p.method, amount: money(p.amount), installments: p.installments,
    status: p.status, providerRef: p.providerRef, orderId: p.orderId,
    pix: p.pixCopiaECola ? { copiaECola: p.pixCopiaECola, qr: p.pixCopiaECola } : undefined,
    boleto: p.boletoLine ? { linhaDigitavel: p.boletoLine } : undefined,
    card: p.cardBrand ? { brand: p.cardBrand, installments: p.installments ?? 1 } : undefined,
    createdAt: p.createdAt.toISOString(),
    _hint: p.status === 'PENDING' ? 'Confirme com POST /sandbox/payments/{id}/settle' : undefined,
  };
}

// ------------------------------------------------------------- criar cobrança
export async function createCharge(groupId: string, rm: string | null, input: {
  method: PaymentMethod; amount?: number; orderId?: string; installments?: number; simulate?: 'approve' | 'decline';
}) {
  let amount = input.amount ?? 0;

  if (input.orderId) {
    const order = await prisma.order.findFirst({ where: tenantScope(groupId, { id: input.orderId }), select: { id: true, total: true, status: true } });
    if (!order) throw notFound('Pedido não encontrado.');
    if (order.status !== 'PENDING') throw conflict(`Pedido não está pendente (status: ${order.status}).`);
    amount = Number(order.total);
  } else if (amount <= 0) {
    throw badRequest('Informe amount (> 0) ou orderId.');
  }

  const art = artifactsFor(input.method, input.installments);
  const created = await prisma.sandboxPayment.create({
    data: {
      groupId, orderId: input.orderId, method: input.method, amount, installments: input.installments,
      status: 'PENDING', providerRef: providerRef(), ...art,
    },
  });

  // CARTÃO é síncrono: resolve na hora conforme simulate (padrão: aprova).
  if (input.method === 'CREDIT_CARD') {
    return settleCharge(groupId, created.id, rm, input.simulate ?? 'approve');
  }
  // PIX/BOLETO ficam PENDING até o settle (assíncrono).
  return serialize(created);
}

export async function getCharge(groupId: string, id: string) {
  const p = await prisma.sandboxPayment.findFirst({ where: tenantScope(groupId, { id }) });
  if (!p) throw notFound('Cobrança não encontrada.');
  return serialize(p);
}

// ------------------------------------------------------------- settle (confirmar)
export async function settleCharge(groupId: string, id: string, rm: string | null, simulate: 'approve' | 'decline' = 'approve') {
  const payment = await prisma.sandboxPayment.findFirst({ where: tenantScope(groupId, { id }) });
  if (!payment) throw notFound('Cobrança não encontrada.');
  if (payment.status !== 'PENDING') throw conflict(`Cobrança já resolvida (status: ${payment.status}).`);

  const approved = simulate !== 'decline';

  await prisma.$transaction(async (tx) => {
    await tx.sandboxPayment.update({ where: { id }, data: { status: approved ? 'APPROVED' : 'DECLINED' } });

    if (payment.orderId) {
      // Liga o resultado ao pedido (baixa estoque, marca PAID, emite eventos).
      const order = await tx.order.findUnique({ where: { id: payment.orderId }, select: { status: true } });
      if (order?.status === 'PENDING') {
        await applyPaymentResult(tx, { groupId, orderId: payment.orderId, rm, amount: payment.amount, method: payment.method, approved, transactionId: payment.providerRef });
      } else {
        await emitEvent(tx, groupId, approved ? 'payment.approved' : 'payment.declined', { paymentId: id, orderId: payment.orderId, amount: money(payment.amount) });
      }
    } else {
      await emitEvent(tx, groupId, approved ? 'payment.approved' : 'payment.declined', { paymentId: id, amount: money(payment.amount) });
    }
  });

  return getCharge(groupId, id);
}

// ------------------------------------------------------------- assinatura recorrente
export async function createSubscription(groupId: string, input: { amount: number; intervalDays: number; customerId?: string }) {
  const sub = await prisma.sandboxSubscription.create({
    data: { groupId, amount: input.amount, intervalDays: input.intervalDays, customerId: input.customerId, nextChargeAt: new Date(Date.now() + input.intervalDays * 86_400_000) },
  });
  return serializeSub(sub);
}

/** Avança um ciclo: gera uma nova cobrança PIX (aprovada) e emite webhook. */
export async function advanceSubscription(groupId: string, id: string, rm: string | null) {
  const sub = await prisma.sandboxSubscription.findFirst({ where: tenantScope(groupId, { id }) });
  if (!sub) throw notFound('Assinatura não encontrada.');
  if (sub.status !== 'ACTIVE') throw conflict('Assinatura não está ativa.');

  const charge = await prisma.sandboxPayment.create({
    data: { groupId, method: 'PIX', amount: sub.amount, status: 'APPROVED', providerRef: providerRef() },
  });
  await prisma.sandboxSubscription.update({
    where: { id },
    data: { cyclesBilled: { increment: 1 }, nextChargeAt: new Date(Date.now() + sub.intervalDays * 86_400_000) },
  });
  await emitEvent(prisma, groupId, 'payment.approved', { subscriptionId: id, paymentId: charge.id, cycle: sub.cyclesBilled + 1, amount: money(sub.amount) });

  return { subscriptionId: id, cycle: sub.cyclesBilled + 1, chargeId: charge.id, amount: money(sub.amount) };
}

function serializeSub(s: any) {
  return { id: s.id, amount: money(s.amount), intervalDays: s.intervalDays, status: s.status, cyclesBilled: s.cyclesBilled, nextChargeAt: s.nextChargeAt.toISOString() };
}
