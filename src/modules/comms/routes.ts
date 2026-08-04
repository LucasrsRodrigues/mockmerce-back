import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { IntegrationSystem } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { money } from '../../lib/serialize.js';
import { conflict, notFound } from '../../lib/errors.js';

const sec = [{ apiKey: [], studentRm: [] }];
const PAID_STATES = ['PAID', 'FULFILLED', 'SHIPPED', 'DELIVERED'];

export async function commsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  // ---------------------------------------------------------- NF-e FAKE
  app.get('/orders/:id/invoice', {
    schema: { tags: ['Comunicações'], summary: '[FAKE] NF-e do pedido (gera na 1ª chamada, se pago)', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const groupId = req.group!.id;
    const order = await prisma.order.findFirst({ where: tenantScope(groupId, { id: (req.params as any).id }), include: { invoice: true } });
    if (!order) throw notFound('Pedido não encontrado.');
    if (order.invoice) return serializeInvoice(order.invoice);
    if (!PAID_STATES.includes(order.status)) throw conflict('NF-e só é emitida para pedidos pagos.');

    const invoice = await prisma.$transaction(async (tx) => {
      const number = (await tx.fakeInvoice.count({ where: { groupId } })) + 1;
      const xmlStub = `<?xml version="1.0"?><nfe fake="true"><numero>${number}</numero><pedidoId>${order.id}</pedidoId><valorTotal>${money(order.total)}</valorTotal><emitidoEm>${order.createdAt.toISOString()}</emitidoEm></nfe>`;
      return tx.fakeInvoice.create({ data: { groupId, orderId: order.id, number, xmlStub } });
    });
    return serializeInvoice(invoice);
  });

  // ---------------------------------------------------------- OUTBOX DE E-MAIL
  app.get('/email-outbox', {
    schema: {
      tags: ['Comunicações'], summary: '[FAKE] E-mails que "seriam" enviados', security: sec,
      querystring: { type: 'object', properties: { template: { type: 'string' }, page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } },
    },
  }, async (req) => {
    const q = req.query as any;
    const where = tenantScope(req.group!.id, q.template ? { template: q.template } : {});
    const [total, emails] = await Promise.all([
      prisma.emailOutbox.count({ where }),
      prisma.emailOutbox.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, data: emails.map((e) => ({ to: e.to, template: e.template, payload: e.payload, at: e.createdAt.toISOString() })) };
  });

  // ---------------------------------------------------------- MOCKS ERP/CRM/MARKETPLACE
  for (const system of ['erp', 'crm', 'marketplace'] as const) {
    app.post(`/sandbox/${system}/sync`, {
      schema: { tags: ['Comunicações'], summary: `[FAKE] Sincroniza um payload com o ${system.toUpperCase()} mock`, security: sec, body: { type: 'object' } },
    }, async (req) => {
      const payload = (req.body ?? {}) as Record<string, unknown>;
      const response = { ok: true, system: system.toUpperCase(), externalId: `${system}_${randomBytes(8).toString('hex')}`, syncedAt: new Date().toISOString() };
      await prisma.integrationSyncLog.create({ data: { groupId: req.group!.id, system: system.toUpperCase() as IntegrationSystem, payload: payload as any, response: response as any } });
      return response;
    });
  }
}

function serializeInvoice(inv: any) {
  return { number: inv.number, orderId: inv.orderId, xml: inv.xmlStub, createdAt: inv.createdAt.toISOString() };
}
