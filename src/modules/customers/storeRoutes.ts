import type { FastifyInstance } from 'fastify';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { runAbandonment } from '../cart/abandonment.js';

const sec = [{ apiKey: [], studentRm: [] }];

export async function customerStoreRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  // Força a varredura de carrinhos abandonados do grupo (útil em testes).
  app.post('/store/carts/run-abandonment', { schema: { tags: ['Clientes (loja)'], summary: 'Marca carrinhos abandonados do grupo (evento + e-mail)', security: sec } },
    async (req) => ({ abandonados: await runAbandonment(req.group!.id) }));

  // ---------------------------------------------------------- Lista de clientes
  app.get('/store/customers', {
    schema: {
      tags: ['Clientes (loja)'], summary: 'Lista os clientes do grupo', security: sec,
      querystring: { type: 'object', properties: { search: { type: 'string' }, page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } },
    },
  }, async (req) => {
    const q = req.query as any;
    const where = tenantScope(req.group!.id, q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' as const } }, { email: { contains: q.search, mode: 'insensitive' as const } }] } : {});
    const [total, customers] = await Promise.all([
      prisma.customer.count({ where }),
      prisma.customer.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true, name: true, email: true, document: true, createdAt: true, _count: { select: { orders: true } } } }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, data: customers.map((c) => ({ id: c.id, name: c.name, email: c.email, document: c.document, pedidos: c._count.orders, createdAt: c.createdAt.toISOString() })) };
  });

  // ---------------------------------------------------------- Segmentos
  app.get('/customer-segments', { schema: { tags: ['Clientes (loja)'], summary: 'Lista segmentos', security: sec } },
    async (req) => {
      const segs = await prisma.customerSegment.findMany({ where: tenantScope(req.group!.id), orderBy: { name: 'asc' }, include: { _count: { select: { members: true } } } });
      return segs.map((s) => ({ id: s.id, name: s.name, membros: s._count.members }));
    });

  app.post('/customer-segments', {
    schema: { tags: ['Clientes (loja)'], summary: 'Cria um segmento', security: sec, body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } } } },
  }, async (req, reply) => {
    const name = (req.body as any).name;
    const exists = await prisma.customerSegment.findFirst({ where: tenantScope(req.group!.id, { name }), select: { id: true } });
    if (exists) throw conflict('Já existe um segmento com esse nome.');
    const seg = await prisma.customerSegment.create({ data: { groupId: req.group!.id, name }, select: { id: true, name: true } });
    return reply.code(201).send(seg);
  });

  app.get('/customer-segments/:id/members', { schema: { tags: ['Clientes (loja)'], summary: 'Lista membros do segmento', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const seg = await prisma.customerSegment.findFirst({ where: tenantScope(req.group!.id, { id: (req.params as any).id }), select: { id: true } });
    if (!seg) throw notFound('Segmento não encontrado.');
    const members = await prisma.customerSegmentMember.findMany({ where: { segmentId: seg.id }, include: { customer: { select: { id: true, name: true, email: true } } } });
    return members.map((m) => m.customer);
  });

  app.post('/customer-segments/:id/members', {
    schema: { tags: ['Clientes (loja)'], summary: 'Adiciona um cliente ao segmento', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, body: { type: 'object', required: ['customerId'], properties: { customerId: { type: 'string' } } } },
  }, async (req, reply) => {
    const groupId = req.group!.id;
    const seg = await prisma.customerSegment.findFirst({ where: tenantScope(groupId, { id: (req.params as any).id }), select: { id: true } });
    if (!seg) throw notFound('Segmento não encontrado.');
    const { customerId } = req.body as { customerId: string };
    const cust = await prisma.customer.findFirst({ where: tenantScope(groupId, { id: customerId }), select: { id: true } });
    if (!cust) throw badRequest('customerId não pertence a este grupo.');
    await prisma.customerSegmentMember.upsert({ where: { segmentId_customerId: { segmentId: seg.id, customerId } }, create: { segmentId: seg.id, customerId }, update: {} });
    return reply.code(201).send({ segmentId: seg.id, customerId });
  });

  app.delete('/customer-segments/:id/members/:customerId', {
    schema: { tags: ['Clientes (loja)'], summary: 'Remove um cliente do segmento', security: sec, params: { type: 'object', required: ['id', 'customerId'], properties: { id: { type: 'string' }, customerId: { type: 'string' } } } },
  }, async (req, reply) => {
    const seg = await prisma.customerSegment.findFirst({ where: tenantScope(req.group!.id, { id: (req.params as any).id }), select: { id: true } });
    if (!seg) throw notFound('Segmento não encontrado.');
    await prisma.customerSegmentMember.deleteMany({ where: { segmentId: seg.id, customerId: (req.params as any).customerId } });
    return reply.code(204).send();
  });
}
