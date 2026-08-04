import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';

// Todas as consultas são READ-ONLY e sempre filtram por groupId (ADR-G2).
// Receita = apenas pedidos PAID (fonte da verdade). SQL parametrizado (anti-injeção).

const round = (v: number) => Number((v ?? 0).toFixed(2));

// -------------------------------------------------------------------- Vendas
export async function salesReport(groupId: string, from: Date, to: Date) {
  const [agg] = await prisma.$queryRaw<{ revenue: number; orders: number }[]>(Prisma.sql`
    SELECT COALESCE(sum(total), 0)::float8 AS revenue, count(*)::int AS orders
    FROM "Order"
    WHERE "groupId" = ${groupId} AND status = 'PAID' AND "createdAt" BETWEEN ${from} AND ${to}`);

  const [it] = await prisma.$queryRaw<{ items: number }[]>(Prisma.sql`
    SELECT COALESCE(sum(oi.quantity), 0)::int AS items
    FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
    WHERE o."groupId" = ${groupId} AND o.status = 'PAID' AND o."createdAt" BETWEEN ${from} AND ${to}`);

  const series = await prisma.$queryRaw<{ day: Date; revenue: number; orders: number }[]>(Prisma.sql`
    SELECT date_trunc('day', "createdAt") AS day, sum(total)::float8 AS revenue, count(*)::int AS orders
    FROM "Order"
    WHERE "groupId" = ${groupId} AND status = 'PAID' AND "createdAt" BETWEEN ${from} AND ${to}
    GROUP BY day ORDER BY day`);

  const revenue = round(agg.revenue);
  const orders = agg.orders;
  return {
    summary: { revenue, orders, itemsSold: it.items, ticketMedio: orders > 0 ? round(revenue / orders) : 0 },
    series: series.map((s) => ({ day: s.day.toISOString().slice(0, 10), revenue: round(s.revenue), orders: s.orders })),
  };
}

// -------------------------------------------------------------- Mais vendidos
export async function topProducts(groupId: string, from: Date, to: Date, by: 'qty' | 'revenue', limit: number) {
  const orderBy = by === 'revenue' ? Prisma.raw('revenue') : Prisma.raw('qty'); // allowlist (não é input livre)
  const rows = await prisma.$queryRaw<{ variantId: string; productName: string; sku: string; label: string | null; qty: number; revenue: number }[]>(Prisma.sql`
    SELECT oi."variantId", oi."productName", oi."variantSku" AS sku, oi."variantName" AS label,
           sum(oi.quantity)::int AS qty, sum(oi.quantity * oi."unitPrice")::float8 AS revenue
    FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
    WHERE o."groupId" = ${groupId} AND o.status = 'PAID' AND o."createdAt" BETWEEN ${from} AND ${to}
    GROUP BY oi."variantId", oi."productName", oi."variantSku", oi."variantName"
    ORDER BY ${orderBy} DESC
    LIMIT ${limit}`);
  return rows.map((r) => ({ variantId: r.variantId, product: r.productName, sku: r.sku, variant: r.label, quantidade: r.qty, receita: round(r.revenue) }));
}

// ----------------------------------------------------------------- Clientes
export async function customersReport(groupId: string, from: Date, to: Date) {
  const rows = await prisma.$queryRaw<{ customerId: string; name: string; email: string; periodOrders: number; totalOrders: number; periodRevenue: number }[]>(Prisma.sql`
    SELECT o."customerId", c.name, c.email,
           count(*) FILTER (WHERE o."createdAt" BETWEEN ${from} AND ${to})::int AS "periodOrders",
           count(*)::int AS "totalOrders",
           COALESCE(sum(o.total) FILTER (WHERE o."createdAt" BETWEEN ${from} AND ${to}), 0)::float8 AS "periodRevenue"
    FROM "Order" o JOIN "Customer" c ON c.id = o."customerId"
    WHERE o."groupId" = ${groupId} AND o.status = 'PAID'
    GROUP BY o."customerId", c.name, c.email
    HAVING count(*) FILTER (WHERE o."createdAt" BETWEEN ${from} AND ${to}) > 0
    ORDER BY "periodRevenue" DESC`);

  const data = rows.map((r) => ({
    customerId: r.customerId, nome: r.name, email: r.email,
    pedidosNoPeriodo: r.periodOrders, pedidosTotais: r.totalOrders,
    segmento: r.totalOrders >= 2 ? 'recorrente' : 'novo', receita: round(r.periodRevenue),
  }));

  const recorrentes = data.filter((d) => d.segmento === 'recorrente');
  const novos = data.filter((d) => d.segmento === 'novo');
  return {
    resumo: {
      recorrentes: { clientes: recorrentes.length, receita: round(recorrentes.reduce((s, d) => s + d.receita, 0)) },
      novos: { clientes: novos.length, receita: round(novos.reduce((s, d) => s + d.receita, 0)) },
    },
    data,
  };
}

// ------------------------------------------------------------------ Estoque
export async function inventoryReport(groupId: string) {
  const rows = await prisma.$queryRaw<{ variantId: string; sku: string; product: string; available: number; minStock: number }[]>(Prisma.sql`
    SELECT v.id AS "variantId", v.sku, p.name AS product, v.stock AS available, v."minStock"
    FROM "ProductVariant" v JOIN "Product" p ON p.id = v."productId"
    WHERE v."groupId" = ${groupId} AND v.stock <= v."minStock"
    ORDER BY v.stock ASC`);
  return rows.map((r) => ({
    variantId: r.variantId, produto: r.product, sku: r.sku,
    disponivel: r.available, minimo: r.minStock,
    situacao: r.available <= 0 ? 'sem_estoque' : 'abaixo_do_minimo',
  }));
}
