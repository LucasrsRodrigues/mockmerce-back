import type { FastifyInstance } from 'fastify';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { badRequest } from '../../lib/errors.js';
import {
  ensureWarehouses, balanceView, listMovements, receive, adjust, applyCount,
} from './service.js';
import { expireReservations } from './expirer.js';

const sec = [{ apiKey: [], studentRm: [] }];

async function resolveWarehouseId(groupId: string, provided?: string): Promise<string> {
  const whs = await ensureWarehouses(groupId);
  if (provided) {
    const w = whs.find((x) => x.id === provided);
    if (!w) throw badRequest('warehouseId não pertence a este grupo.');
    return w.id;
  }
  return (whs.find((w) => w.isDefault) ?? whs[0]).id;
}

export async function inventoryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  // -------------------------------------------------------------- DEPÓSITOS
  app.get('/warehouses', { schema: { tags: ['Estoque'], summary: 'Lista depósitos', security: sec } },
    async (req) => (await ensureWarehouses(req.group!.id)).map((w) => ({ id: w.id, name: w.name, isDefault: w.isDefault })));

  app.post('/warehouses', {
    schema: { tags: ['Estoque'], summary: 'Cria um depósito', security: sec,
      body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } } } },
  }, async (req, reply) => {
    await ensureWarehouses(req.group!.id);
    const w = await prisma.warehouse.create({ data: { groupId: req.group!.id, name: (req.body as any).name, isDefault: false }, select: { id: true, name: true, isDefault: true } });
    return reply.code(201).send(w);
  });

  // -------------------------------------------------------------- SALDO
  app.get('/variants/:id/stock', {
    schema: { tags: ['Estoque'], summary: 'Saldo por depósito (onHand/reserved/disponível)', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => balanceView(req.group!.id, (req.params as any).id));

  app.post('/variants/:id/stock/receive', {
    schema: {
      tags: ['Estoque'], summary: 'Entrada de estoque', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer', minimum: 1 }, warehouseId: { type: 'string' }, reason: { type: 'string' } } },
    },
  }, async (req) => {
    const groupId = req.group!.id;
    const body = req.body as any;
    const warehouseId = await resolveWarehouseId(groupId, body.warehouseId);
    return receive(groupId, (req.params as any).id, warehouseId, body.quantity, body.reason, req.rm ?? null);
  });

  app.post('/variants/:id/stock/adjust', {
    schema: {
      tags: ['Estoque'], summary: 'Ajuste de estoque (define o onHand do depósito)', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['onHand'], properties: { onHand: { type: 'integer', minimum: 0 }, warehouseId: { type: 'string' }, reason: { type: 'string' } } },
    },
  }, async (req) => {
    const groupId = req.group!.id;
    const body = req.body as any;
    const warehouseId = await resolveWarehouseId(groupId, body.warehouseId);
    return adjust(groupId, (req.params as any).id, warehouseId, body.onHand, body.reason, req.rm ?? null);
  });

  app.get('/variants/:id/stock/movements', {
    schema: {
      tags: ['Estoque'], summary: 'Histórico de movimentação', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: { type: 'object', properties: { type: { type: 'string', enum: ['RECEIVE', 'SALE', 'ADJUST', 'RESERVE', 'RELEASE'] }, page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } },
    },
  }, async (req) => listMovements(req.group!.id, (req.params as any).id, req.query as any));

  // -------------------------------------------------------------- INVENTÁRIO
  app.post('/inventory/counts', {
    schema: {
      tags: ['Estoque'], summary: 'Inventário: submete contagem e gera ajustes', security: sec,
      body: {
        type: 'object', required: ['counts'],
        properties: { counts: { type: 'array', items: { type: 'object', required: ['variantId', 'warehouseId', 'counted'], properties: { variantId: { type: 'string' }, warehouseId: { type: 'string' }, counted: { type: 'integer', minimum: 0 } } } } },
      },
    },
  }, async (req) => applyCount(req.group!.id, req.rm ?? null, (req.body as any).counts));

  // -------------------------------------------------------------- EXPIRAÇÃO (teste/determinismo)
  app.post('/inventory/run-expiration', {
    schema: { tags: ['Estoque'], summary: 'Força a expiração de reservas vencidas do grupo (útil para testes)', security: sec },
  }, async (req) => ({ expiredOrders: await expireReservations(req.group!.id) }));
}
