import type { FastifyInstance, FastifyRequest } from 'fastify';
import { OrderStatus } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { notFound } from '../../lib/errors.js';

const adminSec = [{ adminToken: [] }];

// Status de pedido que contam como receita (pós-pagamento, exceto reembolso).
const PAID_STATUSES: OrderStatus[] = [OrderStatus.PAID, OrderStatus.FULFILLED, OrderStatus.SHIPPED, OrderStatus.DELIVERED];

/** Garante que o grupo do :id existe; devolve-o (id+name). */
async function loadGroup(req: FastifyRequest) {
  const { id } = req.params as { id: string };
  const group = await prisma.group.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!group) throw notFound('Grupo não encontrado.');
  return group;
}

function pageParams(req: FastifyRequest) {
  const q = req.query as { page?: number; pageSize?: number };
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 20;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * Rotas de INSPEÇÃO de um grupo para o professor (control plane, read-only).
 * "Entrar no grupo" e ver o que estão fazendo: visão geral, catálogo, pedidos,
 * clientes e webhooks — tudo escopado por groupId. Nunca expõe segredos.
 */
export async function adminInspectRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAdmin);
  const read = app.requirePermission('groups:read');

  // ------------------------------------------------------------- VISÃO GERAL
  app.get('/admin/groups/:id/overview', {
    preHandler: read,
    schema: { tags: ['Admin'], summary: 'Visão geral de um grupo (para o professor entrar no grupo)', security: adminSec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const group = await loadGroup(req);
    const gid = group.id;

    const [full, byRmLogs, xpByRm, ordersByStatus, paidAgg, recent] = await Promise.all([
      prisma.group.findUnique({
        where: { id: gid },
        select: {
          id: true, name: true, apiKeyPrefix: true, active: true, createdAt: true,
          students: { select: { rm: true, name: true, passwordHash: true } },
          _count: { select: { products: true, orders: true, customers: true, logs: true } },
        },
      }),
      prisma.requestLog.groupBy({ by: ['rm'], where: { groupId: gid, rm: { not: null } }, _count: { _all: true }, _max: { createdAt: true } }),
      prisma.xpLedger.groupBy({ by: ['rm'], where: { groupId: gid, rm: { not: null } }, _sum: { points: true } }),
      prisma.order.groupBy({ by: ['status'], where: { groupId: gid }, _count: { _all: true } }),
      prisma.order.aggregate({ where: { groupId: gid, status: { in: PAID_STATUSES } }, _sum: { total: true } }),
      prisma.requestLog.findMany({ where: { groupId: gid }, orderBy: { createdAt: 'desc' }, take: 15, select: { method: true, path: true, statusCode: true, rm: true, createdAt: true, latencyMs: true } }),
    ]);

    const reqByRm = new Map(byRmLogs.map((r) => [r.rm, { count: r._count._all, last: r._max.createdAt }]));
    const xpMap = new Map(xpByRm.map((r) => [r.rm, r._sum.points ?? 0]));

    return {
      id: full!.id,
      name: full!.name,
      apiKeyPrefix: full!.apiKeyPrefix,
      active: full!.active,
      createdAt: full!.createdAt.toISOString(),
      counts: {
        alunos: full!.students.length,
        produtos: full!._count.products,
        pedidos: full!._count.orders,
        clientes: full!._count.customers,
        requisicoes: full!._count.logs,
      },
      revenuePaid: Number(paidAgg._sum?.total ?? 0),
      xpTotal: Array.from(xpMap.values()).reduce((a, b) => a + b, 0),
      ordersByStatus: ordersByStatus.map((o) => ({ status: o.status, count: o._count._all })),
      students: full!.students
        .map((s) => ({
          rm: s.rm,
          name: s.name,
          jaAcessou: !!s.passwordHash,
          requisicoes: reqByRm.get(s.rm)?.count ?? 0,
          ultimaAtividade: reqByRm.get(s.rm)?.last?.toISOString() ?? null,
          xp: xpMap.get(s.rm) ?? 0,
        }))
        .sort((a, b) => b.requisicoes - a.requisicoes),
      recentActivity: recent.map((l) => ({
        method: l.method, path: l.path, statusCode: l.statusCode, rm: l.rm,
        latencyMs: l.latencyMs, at: l.createdAt.toISOString(),
      })),
    };
  });

  // ---------------------------------------------------------------- CATÁLOGO
  app.get('/admin/groups/:id/products', {
    preHandler: read,
    schema: { tags: ['Admin'], summary: 'Catálogo de um grupo', security: adminSec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, querystring: { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } } },
  }, async (req) => {
    const group = await loadGroup(req);
    const { page, pageSize, skip, take } = pageParams(req);
    const [total, products] = await Promise.all([
      prisma.product.count({ where: { groupId: group.id } }),
      prisma.product.findMany({
        where: { groupId: group.id },
        orderBy: { createdAt: 'desc' },
        skip, take,
        select: {
          id: true, name: true, type: true, state: true, createdAt: true,
          brand: { select: { name: true } },
          images: { where: { isPrimary: true }, take: 1, select: { url: true } },
          variants: { select: { price: true, stock: true } },
        },
      }),
    ]);
    return {
      page, pageSize, total,
      data: products.map((p) => {
        const prices = p.variants.map((v) => Number(v.price));
        return {
          id: p.id, name: p.name, type: p.type, state: p.state,
          brand: p.brand?.name ?? null,
          image: p.images[0]?.url ?? null,
          variantsCount: p.variants.length,
          priceFrom: prices.length ? Math.min(...prices) : 0,
          priceTo: prices.length ? Math.max(...prices) : 0,
          stock: p.variants.reduce((a, v) => a + v.stock, 0),
          createdAt: p.createdAt.toISOString(),
        };
      }),
    };
  });

  // ----------------------------------------------------------------- PEDIDOS
  app.get('/admin/groups/:id/orders', {
    preHandler: read,
    schema: { tags: ['Admin'], summary: 'Pedidos de um grupo', security: adminSec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, querystring: { type: 'object', properties: { status: { type: 'string' }, page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } } },
  }, async (req) => {
    const group = await loadGroup(req);
    const { page, pageSize, skip, take } = pageParams(req);
    const status = (req.query as { status?: string }).status;
    const where = { groupId: group.id, ...(status ? { status: status as any } : {}) };
    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where, orderBy: { createdAt: 'desc' }, skip, take,
        select: {
          id: true, status: true, total: true, createdAt: true,
          customer: { select: { name: true, email: true } },
          _count: { select: { items: true } },
        },
      }),
    ]);
    return {
      page, pageSize, total,
      data: orders.map((o) => ({
        id: o.id, status: o.status, total: Number(o.total),
        customer: o.customer.name, email: o.customer.email,
        itens: o._count.items, createdAt: o.createdAt.toISOString(),
      })),
    };
  });

  // ------------------------------------------------------- DETALHE DO PEDIDO
  app.get('/admin/groups/:id/orders/:orderId', {
    preHandler: read,
    schema: { tags: ['Admin'], summary: 'Detalhe de um pedido (itens, pagamento, timeline)', security: adminSec, params: { type: 'object', required: ['id', 'orderId'], properties: { id: { type: 'string' }, orderId: { type: 'string' } } } },
  }, async (req) => {
    const group = await loadGroup(req);
    const { orderId } = req.params as { orderId: string };
    const o = await prisma.order.findFirst({
      where: { id: orderId, groupId: group.id },
      include: {
        items: true,
        payment: true,
        customer: { select: { id: true, name: true, email: true, document: true } },
        events: { orderBy: { createdAt: 'asc' } },
        internalComments: { orderBy: { createdAt: 'asc' } },
        invoice: { select: { number: true } },
      },
    });
    if (!o) throw notFound('Pedido não encontrado neste grupo.');
    return {
      id: o.id,
      status: o.status,
      total: Number(o.total),
      createdAt: o.createdAt.toISOString(),
      customer: o.customer,
      invoiceNumber: o.invoice?.number ?? null,
      items: o.items.map((it) => ({
        productName: it.productName, variantName: it.variantName, sku: it.variantSku,
        quantity: it.quantity, unitPrice: Number(it.unitPrice), lineTotal: Number(it.unitPrice) * it.quantity,
      })),
      payment: o.payment ? {
        method: o.payment.method, status: o.payment.status,
        amount: Number(o.payment.amount), transactionId: o.payment.transactionId,
        at: o.payment.createdAt.toISOString(),
      } : null,
      timeline: o.events.map((e) => ({ from: e.fromStatus, to: e.toStatus, actor: e.actor, rm: e.rm, note: e.note, at: e.createdAt.toISOString() })),
      internalComments: o.internalComments.map((c) => ({ rm: c.rm, body: c.body, at: c.createdAt.toISOString() })),
    };
  });

  // ---------------------------------------------------------------- CLIENTES
  app.get('/admin/groups/:id/customers', {
    preHandler: read,
    schema: { tags: ['Admin'], summary: 'Clientes finais de um grupo', security: adminSec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, querystring: { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } } },
  }, async (req) => {
    const group = await loadGroup(req);
    const { page, pageSize, skip, take } = pageParams(req);
    const [total, customers] = await Promise.all([
      prisma.customer.count({ where: { groupId: group.id } }),
      prisma.customer.findMany({
        where: { groupId: group.id }, orderBy: { createdAt: 'desc' }, skip, take,
        select: { id: true, name: true, email: true, createdAt: true, _count: { select: { orders: true } } },
      }),
    ]);
    return {
      page, pageSize, total,
      data: customers.map((c) => ({ id: c.id, name: c.name, email: c.email, pedidos: c._count.orders, createdAt: c.createdAt.toISOString() })),
    };
  });

  // ---------------------------------------------------------------- WEBHOOKS
  app.get('/admin/groups/:id/webhooks', {
    preHandler: read,
    schema: { tags: ['Admin'], summary: 'Webhooks de um grupo (sem expor o secret)', security: adminSec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const group = await loadGroup(req);
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { groupId: group.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, url: true, description: true, events: true, active: true, createdAt: true,
        deliveries: { select: { status: true } },
      },
    });
    return endpoints.map((e) => {
      const byStatus: Record<string, number> = {};
      for (const d of e.deliveries) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
      return {
        id: e.id, url: e.url, description: e.description, events: e.events, active: e.active,
        createdAt: e.createdAt.toISOString(),
        deliveries: { total: e.deliveries.length, byStatus },
      };
    });
  });

  // -------------------------------------------------------------------- PUSH
  /**
   * "Quem está pronto para a aula de notificações?"
   *
   * Uma linha por grupo, com as três coisas que decidem se o push daquele
   * grupo funciona: se registrou a credencial do Firebase, se o Google
   * aceitou, e se algum aparelho chegou a se registrar. Grupo sem aparelho
   * não é erro — é alguém que ainda não instalou o development build.
   */
  app.get('/admin/push/readiness', {
    preHandler: read,
    schema: {
      tags: ['Admin'],
      summary: 'Prontidão de push da turma inteira (credencial, aparelhos, envios)',
      security: adminSec,
    },
  }, async () => {
    const [grupos, configs, aparelhos, envios] = await Promise.all([
      prisma.group.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.groupPushConfig.findMany({ select: { groupId: true, projectId: true, lastCheckOk: true, lastCheckAt: true, lastCheckMsg: true } }),
      prisma.deviceToken.groupBy({ by: ['groupId', 'active'], _count: { _all: true } }),
      prisma.pushMessage.groupBy({ by: ['groupId', 'status'], _count: { _all: true }, _max: { createdAt: true } }),
    ]);

    const porGrupo = new Map(configs.map((c) => [c.groupId, c]));

    return grupos.map((g) => {
      const cfg = porGrupo.get(g.id);
      const ativos = aparelhos.find((a) => a.groupId === g.id && a.active)?._count._all ?? 0;
      const inativos = aparelhos.find((a) => a.groupId === g.id && !a.active)?._count._all ?? 0;
      const meus = envios.filter((e) => e.groupId === g.id);
      const porStatus = Object.fromEntries(meus.map((e) => [e.status, e._count._all]));
      const ultimoEnvio = meus.reduce<Date | null>((maior, e) => {
        const d = e._max.createdAt;
        return d && (!maior || d > maior) ? d : maior;
      }, null);

      return {
        groupId: g.id,
        name: g.name,
        credencial: cfg
          ? { projectId: cfg.projectId, ok: cfg.lastCheckOk, verificadaEm: cfg.lastCheckAt?.toISOString() ?? null, mensagem: cfg.lastCheckMsg }
          : null,
        aparelhos: { ativos, inativos },
        envios: { total: meus.reduce((t, e) => t + e._count._all, 0), porStatus, ultimoEm: ultimoEnvio?.toISOString() ?? null },
        /**
         * O semáforo que o painel do professor pinta. `pronto` exige os dois
         * lados: credencial aceita pelo Google E um aparelho registrado — ter
         * só um dos dois não entrega notificação nenhuma.
         */
        estado: !cfg ? 'sem-credencial'
          : cfg.lastCheckOk === false ? 'credencial-recusada'
          : ativos === 0 ? 'sem-aparelho'
          : 'pronto',
      };
    });
  });

  /** Detalhe de um grupo: credencial, aparelhos e os últimos envios. */
  app.get('/admin/groups/:id/push', {
    preHandler: read,
    schema: {
      tags: ['Admin'],
      summary: 'Push de um grupo (sem expor a chave privada)',
      security: adminSec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    const group = await loadGroup(req);

    const [config, devices, messages] = await Promise.all([
      prisma.groupPushConfig.findUnique({
        where: { groupId: group.id },
        // A chave privada (mesmo cifrada) NUNCA sai daqui.
        select: { projectId: true, clientEmail: true, lastCheckOk: true, lastCheckAt: true, lastCheckMsg: true, updatedAt: true },
      }),
      prisma.deviceToken.findMany({
        where: { groupId: group.id },
        orderBy: { lastSeenAt: 'desc' },
        select: { id: true, platform: true, deviceName: true, appVersion: true, active: true, disabledReason: true, lastSeenAt: true, customerId: true },
      }),
      prisma.pushMessage.findMany({
        where: { groupId: group.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, title: true, kind: true, status: true, reason: true, errorCode: true, errorDetail: true, createdAt: true },
      }),
    ]);

    return {
      group,
      credencial: config
        ? {
            projectId: config.projectId,
            clientEmail: config.clientEmail,
            ok: config.lastCheckOk,
            verificadaEm: config.lastCheckAt?.toISOString() ?? null,
            mensagem: config.lastCheckMsg,
            atualizadaEm: config.updatedAt.toISOString(),
          }
        : null,
      aparelhos: devices.map((d) => ({ ...d, lastSeenAt: d.lastSeenAt.toISOString() })),
      envios: messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    };
  });
}
