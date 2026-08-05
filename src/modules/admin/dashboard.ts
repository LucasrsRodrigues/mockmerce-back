import type { FastifyInstance } from 'fastify';
import { Prisma, OrderStatus } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { classView } from '../teaching/service.js';

const adminSec = [{ adminToken: [] }];
const PAID_STATUSES: OrderStatus[] = [OrderStatus.PAID, OrderStatus.FULFILLED, OrderStatus.SHIPPED, OrderStatus.DELIVERED];

/** Gera os últimos N dias (YYYY-MM-DD) até hoje, para preencher buracos nas séries. */
function lastNDays(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Dashboard COMPARATIVO da turma (control plane): agrega todos os grupos numa tela.
 * Read-only. Reúne counts, receita, XP/nota por grupo + séries temporais da turma.
 */
export async function adminDashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAdmin);

  app.get('/admin/dashboard', {
    preHandler: app.requirePermission('activity:read'),
    schema: {
      tags: ['Admin'], summary: 'Dashboard comparativo da turma (todos os grupos)', security: adminSec,
      querystring: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 60, default: 14 } } },
    },
  }, async (req) => {
    const days = (req.query as { days?: number }).days ?? 14;
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (days - 1));

    const [groups, revenueByGroup, ordersStatus, teaching, activityRaw, ordersRaw] = await Promise.all([
      prisma.group.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, active: true, _count: { select: { students: true, products: true, orders: true, customers: true, logs: true } } },
      }),
      prisma.order.groupBy({ by: ['groupId'], where: { status: { in: PAID_STATUSES } }, _sum: { total: true } }),
      prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      classView(),
      prisma.$queryRaw<{ day: Date; total: number }[]>(Prisma.sql`
        SELECT date_trunc('day', "createdAt") AS day, count(*)::int AS total
        FROM "RequestLog" WHERE "createdAt" >= ${since} AND "groupId" IS NOT NULL
        GROUP BY day ORDER BY day`),
      prisma.$queryRaw<{ day: Date; orders: number; revenue: number }[]>(Prisma.sql`
        SELECT date_trunc('day', "createdAt") AS day, count(*)::int AS orders,
               COALESCE(sum(CASE WHEN status IN ('PAID','FULFILLED','SHIPPED','DELIVERED') THEN total ELSE 0 END), 0)::float8 AS revenue
        FROM "Order" WHERE "createdAt" >= ${since}
        GROUP BY day ORDER BY day`),
    ]);

    const revMap = new Map(revenueByGroup.map((r) => [r.groupId, Number(r._sum.total ?? 0)]));
    const teachMap = new Map(teaching.porGrupo.map((g) => [g.groupId, g]));

    const perGroup = groups.map((g) => {
      const t = teachMap.get(g.id);
      return {
        id: g.id, name: g.name, active: g.active,
        alunos: g._count.students,
        produtos: g._count.products,
        pedidos: g._count.orders,
        clientes: g._count.customers,
        requisicoes: g._count.logs,
        receitaPaga: revMap.get(g.id) ?? 0,
        xp: t?.xp ?? 0,
        nota: t?.nota ?? 0,
        missoes: t?.missoesCumpridas ?? 0,
      };
    });

    const totals = perGroup.reduce(
      (acc, g) => ({
        grupos: acc.grupos + 1,
        alunos: acc.alunos + g.alunos,
        produtos: acc.produtos + g.produtos,
        pedidos: acc.pedidos + g.pedidos,
        clientes: acc.clientes + g.clientes,
        requisicoes: acc.requisicoes + g.requisicoes,
        receitaPaga: acc.receitaPaga + g.receitaPaga,
        xp: acc.xp + g.xp,
      }),
      { grupos: 0, alunos: 0, produtos: 0, pedidos: 0, clientes: 0, requisicoes: 0, receitaPaga: 0, xp: 0 },
    );

    // Séries temporais preenchendo dias sem dado com 0.
    const actMap = new Map(activityRaw.map((r) => [r.day.toISOString().slice(0, 10), r.total]));
    const ordMap = new Map(ordersRaw.map((r) => [r.day.toISOString().slice(0, 10), { orders: r.orders, revenue: Number(r.revenue) }]));
    const dayList = lastNDays(days);

    return {
      totals: { ...totals, receitaPaga: Number(totals.receitaPaga.toFixed(2)) },
      groups: perGroup,
      ordersByStatus: ordersStatus.map((o) => ({ status: o.status, count: o._count._all })),
      activityByDay: dayList.map((d) => ({ date: d, requisicoes: actMap.get(d) ?? 0 })),
      ordersByDay: dayList.map((d) => ({ date: d, pedidos: ordMap.get(d)?.orders ?? 0, receita: Number((ordMap.get(d)?.revenue ?? 0).toFixed(2)) })),
    };
  });
}
