import type { FastifyInstance } from 'fastify';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { money } from '../../lib/serialize.js';
import { emitEvent } from '../../lib/outbox.js';
import { variantLabel } from '../catalog/serialize.js';
import { ensureWarehouses, ensureBalance, reserveForOrder, reverseCommittedStock } from '../inventory/service.js';
import { applyPaymentResult } from '../payments/orderPayment.js';
import { canTransition, STORE_TRANSITIONS, recordOrderEvent } from './stateMachine.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

const sec = [{ apiKey: [], studentRm: [] }];

async function serializeStoreOrder(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: true, payment: true, customer: { select: { id: true, name: true, email: true } }, events: { orderBy: { createdAt: 'asc' } }, internalComments: { orderBy: { createdAt: 'asc' } } },
  });
  return {
    id: o.id, status: o.status, total: money(o.total),
    customer: o.customer,
    items: o.items.map((it) => ({ variantId: it.variantId, productName: it.productName, variantName: it.variantName, sku: it.variantSku, quantity: it.quantity, unitPrice: money(it.unitPrice) })),
    payment: o.payment ? { status: o.payment.status, method: o.payment.method } : null,
    timeline: o.events.map((e) => ({ from: e.fromStatus, to: e.toStatus, actor: e.actor, rm: e.rm, note: e.note, at: e.createdAt.toISOString() })),
    internalComments: o.internalComments.map((c) => ({ rm: c.rm, body: c.body, at: c.createdAt.toISOString() })),
    createdAt: o.createdAt.toISOString(),
  };
}

export async function storeOrderRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  // ----------------------------------------------------------- LISTA / DETALHE
  app.get('/store/orders', {
    schema: {
      tags: ['Pedidos (loja)'], summary: 'Lista todos os pedidos do grupo', security: sec,
      querystring: { type: 'object', properties: { status: { type: 'string' }, customerId: { type: 'string' }, page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } },
    },
  }, async (req) => {
    const q = req.query as any;
    const where = tenantScope(req.group!.id, { ...(q.status ? { status: q.status } : {}), ...(q.customerId ? { customerId: q.customerId } : {}) });
    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { customer: { select: { name: true, email: true } } } }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, data: orders.map((o) => ({ id: o.id, status: o.status, total: money(o.total), customer: o.customer, createdAt: o.createdAt.toISOString() })) };
  });

  app.get('/store/orders/:id', {
    schema: { tags: ['Pedidos (loja)'], summary: 'Detalha um pedido (com timeline e comentários internos)', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const order = await prisma.order.findFirst({ where: tenantScope(req.group!.id, { id: (req.params as any).id }), select: { id: true } });
    if (!order) throw notFound('Pedido não encontrado.');
    return serializeStoreOrder(order.id);
  });

  // ----------------------------------------------------------- PEDIDO MANUAL
  app.post('/store/orders', {
    schema: {
      tags: ['Pedidos (loja)'], summary: 'Cria um pedido manual para um cliente (reserva estoque)', security: sec,
      body: {
        type: 'object', required: ['customerId', 'items'],
        properties: {
          customerId: { type: 'string' },
          items: { type: 'array', minItems: 1, items: { type: 'object', required: ['variantId', 'quantity'], properties: { variantId: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } } } },
          markAsPaid: { type: 'boolean', default: false },
        },
      },
    },
  }, async (req, reply) => {
    const groupId = req.group!.id;
    const rm = req.rm ?? null;
    const body = req.body as { customerId: string; items: { variantId: string; quantity: number }[]; markAsPaid?: boolean };

    const customer = await prisma.customer.findFirst({ where: tenantScope(groupId, { id: body.customerId }), select: { id: true } });
    if (!customer) throw badRequest('customerId não pertence a este grupo.');

    const variants = await prisma.productVariant.findMany({
      where: tenantScope(groupId, { id: { in: body.items.map((i) => i.variantId) } }),
      include: { product: { select: { name: true } }, optionValues: { include: { option: true, optionValue: true } } },
    });
    const vmap = new Map(variants.map((v) => [v.id, v]));
    if (vmap.size !== new Set(body.items.map((i) => i.variantId)).size) throw badRequest('Alguma variante não pertence a este grupo.');

    await ensureWarehouses(groupId);
    for (const it of body.items) await ensureBalance(groupId, it.variantId);

    const total = body.items.reduce((s, it) => s + money(vmap.get(it.variantId)!.price) * it.quantity, 0);

    const orderId = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          groupId, customerId: body.customerId, status: 'PENDING', total: Number(total.toFixed(2)),
          items: { create: body.items.map((it) => { const v = vmap.get(it.variantId)!; return { variantId: v.id, productName: v.product.name, variantSku: v.sku, variantName: variantLabel(v), quantity: it.quantity, unitPrice: v.price }; }) },
        },
      });
      await reserveForOrder(tx, groupId, created.id, rm, body.items);
      await recordOrderEvent(tx, created.id, null, 'PENDING', 'STORE', rm, 'pedido manual');
      await emitEvent(tx, groupId, 'order.created', { orderId: created.id, total: created.total, manual: true });
      if (body.markAsPaid) {
        await applyPaymentResult(tx, { groupId, orderId: created.id, rm, amount: created.total, method: 'PIX', approved: true, transactionId: `manual_${created.id}` });
      }
      return created.id;
    });
    return reply.code(201).send(await serializeStoreOrder(orderId));
  });

  // ----------------------------------------------------------- TRANSIÇÃO
  app.post('/store/orders/:id/transition', {
    schema: {
      tags: ['Pedidos (loja)'], summary: 'Avança o status (FULFILLED/SHIPPED/DELIVERED)', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['to'], properties: { to: { type: 'string', enum: STORE_TRANSITIONS }, note: { type: 'string' } } },
    },
  }, async (req) => {
    const groupId = req.group!.id;
    const { id } = req.params as { id: string };
    const { to, note } = req.body as { to: any; note?: string };
    const order = await prisma.order.findFirst({ where: tenantScope(groupId, { id }) });
    if (!order) throw notFound('Pedido não encontrado.');
    if (!canTransition(order.status, to)) throw conflict(`Transição inválida: ${order.status} → ${to}.`);
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id }, data: { status: to } });
      await recordOrderEvent(tx, id, order.status, to, 'STORE', req.rm ?? null, note);
    });
    return serializeStoreOrder(id);
  });

  // ----------------------------------------------------------- REEMBOLSO
  app.post('/store/orders/:id/refund', {
    schema: { tags: ['Pedidos (loja)'], summary: 'Reembolsa um pedido pago: reverte o estoque + estorna', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const groupId = req.group!.id;
    const rm = req.rm ?? null;
    const { id } = req.params as { id: string };
    const order = await prisma.order.findFirst({ where: tenantScope(groupId, { id }) });
    if (!order) throw notFound('Pedido não encontrado.');
    if (!canTransition(order.status, 'REFUNDED')) throw conflict(`Não é possível reembolsar um pedido ${order.status}.`);

    await prisma.$transaction(async (tx) => {
      await reverseCommittedStock(tx, groupId, id, rm); // devolve o estoque baixado
      await tx.order.update({ where: { id }, data: { status: 'REFUNDED' } });
      await tx.payment.updateMany({ where: { orderId: id }, data: { status: 'DECLINED' } }); // estorno (fake)
      await tx.sandboxPayment.updateMany({ where: { orderId: id, status: 'APPROVED' }, data: { status: 'DECLINED' } });
      await recordOrderEvent(tx, id, order.status, 'REFUNDED', 'STORE', rm, 'reembolso');
      await emitEvent(tx, groupId, 'order.refunded', { orderId: id, amount: money(order.total) });
    });
    return serializeStoreOrder(id);
  });

  // ----------------------------------------------------------- COMENTÁRIOS INTERNOS
  app.get('/store/orders/:id/comments', {
    schema: { tags: ['Pedidos (loja)'], summary: 'Lista comentários internos (só a loja vê)', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const order = await prisma.order.findFirst({ where: tenantScope(req.group!.id, { id: (req.params as any).id }), select: { id: true } });
    if (!order) throw notFound('Pedido não encontrado.');
    const comments = await prisma.orderInternalComment.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
    return comments.map((c) => ({ rm: c.rm, body: c.body, at: c.createdAt.toISOString() }));
  });

  app.post('/store/orders/:id/comments', {
    schema: {
      tags: ['Pedidos (loja)'], summary: 'Adiciona um comentário interno', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['body'], properties: { body: { type: 'string', minLength: 1 } } },
    },
  }, async (req, reply) => {
    const order = await prisma.order.findFirst({ where: tenantScope(req.group!.id, { id: (req.params as any).id }), select: { id: true } });
    if (!order) throw notFound('Pedido não encontrado.');
    const c = await prisma.orderInternalComment.create({ data: { orderId: order.id, rm: req.rm ?? null, body: (req.body as any).body } });
    return reply.code(201).send({ rm: c.rm, body: c.body, at: c.createdAt.toISOString() });
  });
}
