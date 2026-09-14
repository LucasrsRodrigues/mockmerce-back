import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { money } from '../../lib/serialize.js';
import { emitEvent } from '../../lib/outbox.js';
import { variantLabel } from '../catalog/serialize.js';
import { ensureWarehouses, ensureBalance, reserveForOrder, releaseForOrder } from '../inventory/service.js';
import { applyPaymentResult } from '../payments/orderPayment.js';
import { recordOrderEvent } from './stateMachine.js';
import { conflict, notFound, unprocessable, badRequest } from '../../lib/errors.js';

const orderSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string' },
    total: { type: 'number' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          variantId: { type: 'string' }, productName: { type: 'string' }, variantName: { type: 'string', nullable: true },
          sku: { type: 'string' }, unitPrice: { type: 'number' }, quantity: { type: 'integer' }, subtotal: { type: 'number' },
        },
      },
    },
    payment: { type: 'object', nullable: true, properties: { status: { type: 'string' }, method: { type: 'string' }, amount: { type: 'number' }, transactionId: { type: 'string' } } },
    // Retirada na loja (f6-locations). Null = entrega no endereço.
    pickup: {
      type: 'object', nullable: true, additionalProperties: true,
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, hours: { type: 'string', nullable: true },
        coordinate: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
        address: { type: 'object', additionalProperties: true },
      },
    },
    createdAt: { type: 'string' },
  },
};

async function serializeOrder(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: true, payment: true, pickupPoint: true },
  });
  return {
    id: order.id, status: order.status, total: money(order.total),
    /// Null = entrega no endereço; preenchido = o cliente retira neste ponto.
    pickup: order.pickupPoint ? {
      id: order.pickupPoint.id,
      name: order.pickupPoint.name,
      hours: order.pickupPoint.hours,
      coordinate: { latitude: order.pickupPoint.latitude, longitude: order.pickupPoint.longitude },
      address: {
        cep: order.pickupPoint.cep, street: order.pickupPoint.street, number: order.pickupPoint.number,
        district: order.pickupPoint.district, city: order.pickupPoint.city, state: order.pickupPoint.state,
      },
    } : null,
    items: order.items.map((it) => {
      const unitPrice = money(it.unitPrice);
      return { variantId: it.variantId, productName: it.productName, variantName: it.variantName, sku: it.variantSku, unitPrice, quantity: it.quantity, subtotal: Number((unitPrice * it.quantity).toFixed(2)) };
    }),
    payment: order.payment ? { status: order.payment.status, method: order.payment.method, amount: money(order.payment.amount), transactionId: order.payment.transactionId } : null,
    createdAt: order.createdAt.toISOString(),
  };
}

export async function orderRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);
  app.addHook('preHandler', app.requireCustomer);

  // -------------------------------------------------------------- CHECKOUT
  app.post('/orders/checkout', {
    schema: {
      tags: ['Pedidos'], summary: 'Cria um pedido a partir do carrinho ativo e RESERVA o estoque (PENDING)',
      security: [{ apiKey: [], customerToken: [] }],
      body: {
        type: 'object',
        properties: {
          pickupPointId: {
            type: 'string',
            description: 'Retirar neste ponto em vez de receber em casa (ver GET /pickup-points).',
          },
        },
      },
      response: { 201: orderSchema },
    },
    // POST sem corpo é o uso normal deste endpoint (checkout simples), e é
    // assim que os apps já chamam. O schema de body acima existe só para
    // documentar o pickupPointId — sem este hook ele reprovaria quem não manda
    // corpo nenhum, quebrando todo mundo que já estava integrado.
    preValidation: (req, _reply, done) => {
      if (req.body === undefined || req.body === null) req.body = {};
      done();
    },
  }, async (req, reply) => {
    const groupId = req.group!.id;
    const customerId = req.customer!.id;
    const rm = req.rm ?? null;

    // Retirada na loja (f6-locations): o ponto precisa ser desta loja e estar ativo.
    const pickupPointId = (req.body as { pickupPointId?: string } | undefined)?.pickupPointId;
    if (pickupPointId) {
      const ponto = await prisma.pickupPoint.findFirst({
        where: tenantScope(groupId, { id: pickupPointId, active: true }), select: { id: true },
      });
      if (!ponto) throw badRequest('Ponto de retirada não encontrado ou desativado.');
    }

    const cart = await prisma.cart.findFirst({
      where: { customerId, status: 'ACTIVE' },
      include: { items: { include: { variant: { include: { product: { select: { name: true } }, optionValues: { include: { option: true, optionValue: true } } } } } } },
    });
    if (!cart || cart.items.length === 0) throw unprocessable('Carrinho vazio. Adicione itens antes do checkout.');

    // Garante depósitos e materializa saldos antes de reservar.
    await ensureWarehouses(groupId);
    for (const item of cart.items) await ensureBalance(groupId, item.variantId);

    const total = cart.items.reduce((sum, it) => sum + money(it.unitPrice) * it.quantity, 0);

    const orderId = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          groupId, customerId, status: 'PENDING', total: Number(total.toFixed(2)),
          pickupPointId: pickupPointId ?? null,
          items: {
            create: cart.items.map((it) => ({
              variantId: it.variantId, productName: it.variant.product.name, variantSku: it.variant.sku,
              variantName: variantLabel(it.variant), quantity: it.quantity, unitPrice: it.unitPrice,
            })),
          },
        },
      });
      // RESERVA o estoque (lança 422 se faltar — rollback de tudo).
      await reserveForOrder(tx, groupId, created.id, rm, cart.items.map((it) => ({ variantId: it.variantId, quantity: it.quantity })));
      await tx.cart.update({ where: { id: cart.id }, data: { status: 'CHECKED_OUT' } });
      await recordOrderEvent(tx, created.id, null, 'PENDING', 'CUSTOMER', rm, 'pedido criado');
      await emitEvent(tx, groupId, 'order.created', { orderId: created.id, total: created.total });
      return created.id;
    });

    return reply.code(201).send(await serializeOrder(orderId));
  });

  // ------------------------------------------------------------------ LISTA
  app.get('/orders', {
    schema: { tags: ['Pedidos'], summary: 'Lista pedidos do cliente logado', security: [{ apiKey: [], customerToken: [] }], response: { 200: { type: 'array', items: orderSchema } } },
  }, async (req) => {
    const orders = await prisma.order.findMany({ where: tenantScope(req.group!.id, { customerId: req.customer!.id }), orderBy: { createdAt: 'desc' }, select: { id: true } });
    return Promise.all(orders.map((o) => serializeOrder(o.id)));
  });

  app.get('/orders/:id', {
    schema: { tags: ['Pedidos'], summary: 'Detalha um pedido', security: [{ apiKey: [], customerToken: [] }], params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, response: { 200: orderSchema } },
  }, async (req) => {
    const order = await prisma.order.findFirst({ where: tenantScope(req.group!.id, { id: (req.params as any).id, customerId: req.customer!.id }), select: { id: true } });
    if (!order) throw notFound('Pedido não encontrado.');
    return serializeOrder(order.id);
  });

  // ---------------------------------------------------------- PAGAMENTO (fake)
  app.post('/orders/:id/pay', {
    schema: {
      tags: ['Pagamento'], summary: 'Paga um pedido (simulado). Se aprovado, confirma a baixa da reserva.', security: [{ apiKey: [], customerToken: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['method'], properties: { method: { type: 'string', enum: ['CREDIT_CARD', 'PIX', 'BOLETO'] }, simulate: { type: 'string', enum: ['approve', 'decline'], default: 'approve' } } },
      response: { 200: orderSchema },
    },
  }, async (req) => {
    const groupId = req.group!.id;
    const rm = req.rm ?? null;
    const { id } = req.params as { id: string };
    const { method, simulate = 'approve' } = req.body as { method: 'CREDIT_CARD' | 'PIX' | 'BOLETO'; simulate?: 'approve' | 'decline' };

    const order = await prisma.order.findFirst({ where: tenantScope(groupId, { id, customerId: req.customer!.id }), include: { payment: true } });
    if (!order) throw notFound('Pedido não encontrado.');
    if (order.status !== 'PENDING') throw conflict(`Pedido não está pendente (status atual: ${order.status}).`);

    const approved = simulate !== 'decline';
    const transactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    await prisma.$transaction(async (tx) => {
      // Registra a cobrança no "gateway" fake (resolvida na hora por este atalho síncrono).
      await tx.sandboxPayment.create({
        data: { groupId, orderId: order.id, method, amount: order.total, status: approved ? 'APPROVED' : 'DECLINED', providerRef: transactionId },
      });
      // Efeito compartilhado: baixa estoque, marca PAID e emite eventos.
      await applyPaymentResult(tx, { groupId, orderId: order.id, rm, amount: order.total, method, approved, transactionId });
    });

    return serializeOrder(order.id);
  });

  // ------------------------------------------------------------------ CANCELAR
  app.post('/orders/:id/cancel', {
    schema: { tags: ['Pedidos'], summary: 'Cancela um pedido pendente e LIBERA a reserva', security: [{ apiKey: [], customerToken: [] }], params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, response: { 200: orderSchema } },
  }, async (req) => {
    const groupId = req.group!.id;
    const rm = req.rm ?? null;
    const { id } = req.params as { id: string };
    const order = await prisma.order.findFirst({ where: tenantScope(groupId, { id, customerId: req.customer!.id }) });
    if (!order) throw notFound('Pedido não encontrado.');
    if (order.status !== 'PENDING') throw conflict(`Só é possível cancelar pedidos pendentes (status: ${order.status}).`);

    await prisma.$transaction(async (tx) => {
      await releaseForOrder(tx, groupId, id, rm, 'cancelado pelo cliente');
      await tx.order.update({ where: { id }, data: { status: 'CANCELLED' } });
      await recordOrderEvent(tx, id, 'PENDING', 'CANCELLED', 'CUSTOMER', rm, 'cancelado pelo cliente');
      await emitEvent(tx, groupId, 'order.cancelled', { orderId: id, reason: 'cancelled_by_customer' });
    });
    return serializeOrder(id);
  });

  // ------------------------------------------------------------------ TIMELINE
  app.get('/orders/:id/timeline', {
    schema: { tags: ['Pedidos'], summary: 'Linha do tempo do pedido', security: [{ apiKey: [], customerToken: [] }], params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const order = await prisma.order.findFirst({ where: tenantScope(req.group!.id, { id: (req.params as any).id, customerId: req.customer!.id }), select: { id: true } });
    if (!order) throw notFound('Pedido não encontrado.');
    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
    return events.map((e) => ({ from: e.fromStatus, to: e.toStatus, actor: e.actor, rm: e.rm, note: e.note, at: e.createdAt.toISOString() }));
  });

  // ------------------------------------------------------------------ REORDER
  app.post('/orders/:id/reorder', {
    schema: { tags: ['Pedidos'], summary: 'Recria o carrinho a partir de um pedido (comprar novamente)', security: [{ apiKey: [], customerToken: [] }], params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const groupId = req.group!.id;
    const customerId = req.customer!.id;
    const order = await prisma.order.findFirst({ where: tenantScope(groupId, { id: (req.params as any).id, customerId }), include: { items: true } });
    if (!order) throw notFound('Pedido não encontrado.');

    let cart = await prisma.cart.findFirst({ where: { customerId, status: 'ACTIVE' } });
    if (!cart) cart = await prisma.cart.create({ data: { groupId, customerId, status: 'ACTIVE' } });

    const skipped: string[] = [];
    for (const it of order.items) {
      const variant = await prisma.productVariant.findFirst({ where: tenantScope(groupId, { id: it.variantId }) });
      if (!variant || !variant.active || variant.stock < it.quantity) { skipped.push(it.productName); continue; }
      await prisma.cartItem.upsert({
        where: { cartId_variantId: { cartId: cart.id, variantId: it.variantId } },
        create: { cartId: cart.id, variantId: it.variantId, quantity: it.quantity, unitPrice: variant.price },
        update: { quantity: { increment: it.quantity }, unitPrice: variant.price },
      });
    }
    await prisma.cart.update({ where: { id: cart.id }, data: { lastActivityAt: new Date() } });
    return { cartId: cart.id, adicionados: order.items.length - skipped.length, indisponiveis: skipped };
  });
}
