import type { Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { emitEvent } from '../../lib/outbox.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { env } from '../../env.js';

type Tx = Prisma.TransactionClient;

// ------------------------------------------------------------- Depósitos
/** Garante os 2 depósitos padrão do grupo (Principal + Secundário). */
export async function ensureWarehouses(groupId: string) {
  let whs = await prisma.warehouse.findMany({ where: { groupId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
  if (whs.length === 0) {
    await prisma.warehouse.createMany({
      data: [{ groupId, name: 'Principal', isDefault: true }, { groupId, name: 'Secundário', isDefault: false }],
    });
    whs = await prisma.warehouse.findMany({ where: { groupId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
  }
  return whs;
}

async function defaultWarehouse(groupId: string) {
  const whs = await ensureWarehouses(groupId);
  return whs.find((w) => w.isDefault) ?? whs[0];
}

/**
 * Materializa o saldo do depósito Principal a partir do `variant.stock` inicial,
 * se ainda não existir nenhum saldo para a variante. Depois disso, StockBalance
 * passa a ser a fonte da verdade.
 */
export async function ensureBalance(groupId: string, variantId: string) {
  const existing = await prisma.stockBalance.findFirst({ where: { variantId } });
  if (existing) return;
  const variant = await prisma.productVariant.findFirst({ where: tenantScope(groupId, { id: variantId }), select: { stock: true } });
  if (!variant) throw notFound('Variante não encontrada.');
  const dw = await defaultWarehouse(groupId);
  await prisma.stockBalance.upsert({
    where: { variantId_warehouseId: { variantId, warehouseId: dw.id } },
    create: { groupId, variantId, warehouseId: dw.id, onHand: variant.stock, reserved: 0 },
    update: {},
  });
}

// ---------------------------------------------------- Cache + alerta de mínimo
/**
 * Recalcula `variant.stock` = disponível (Σ onHand - reserved) e, se o disponível
 * cruzou para <= minStock, emite `product.low_stock` no Outbox (1x por cruzamento).
 */
async function syncVariantCache(tx: Tx, variantId: string) {
  const balances = await tx.stockBalance.findMany({ where: { variantId }, select: { onHand: true, reserved: true } });
  const available = balances.reduce((s, b) => s + (b.onHand - b.reserved), 0);
  const variant = await tx.productVariant.findUnique({
    where: { id: variantId },
    select: { stock: true, minStock: true, groupId: true, sku: true, product: { select: { id: true, name: true } } },
  });
  if (!variant) return;
  const previous = variant.stock;
  await tx.productVariant.update({ where: { id: variantId }, data: { stock: available } });

  if (previous > variant.minStock && available <= variant.minStock) {
    await emitEvent(tx, variant.groupId, 'product.low_stock', {
      variantId, sku: variant.sku, productId: variant.product.id, productName: variant.product.name,
      available, minStock: variant.minStock,
    });
  }
}

// ---------------------------------------------------- RESERVA (checkout)
export interface ReserveItem { variantId: string; quantity: number }

/**
 * Reserva estoque para um pedido dentro de `tx`. Percorre os depósitos (Principal
 * primeiro) e usa UPDATE condicional atômico — nunca deixa `reserved > onHand`,
 * mesmo sob concorrência. Lança 422 (rollback) se faltar disponível.
 */
export async function reserveForOrder(tx: Tx, groupId: string, orderId: string, rm: string | null, items: ReserveItem[]) {
  const expiresAt = new Date(Date.now() + env.RESERVATION_TTL_MINUTES * 60_000);

  for (const item of items) {
    let remaining = item.quantity;
    const balances = await tx.stockBalance.findMany({
      where: { variantId: item.variantId },
      include: { warehouse: { select: { isDefault: true } } },
      orderBy: { warehouse: { isDefault: 'desc' } },
    });

    for (const b of balances) {
      if (remaining <= 0) break;
      // Até 3 tentativas por saldo (re-lê em caso de corrida).
      for (let attempt = 0; attempt < 3 && remaining > 0; attempt++) {
        const fresh = await tx.stockBalance.findUnique({ where: { id: b.id }, select: { onHand: true, reserved: true } });
        if (!fresh) break;
        const avail = fresh.onHand - fresh.reserved;
        if (avail <= 0) break;
        const take = Math.min(avail, remaining);
        const affected = await tx.$executeRaw`
          UPDATE "StockBalance" SET reserved = reserved + ${take}, version = version + 1
          WHERE id = ${b.id} AND "onHand" - reserved >= ${take}`;
        if (affected === 1) {
          remaining -= take;
          await tx.reservation.create({ data: { groupId, orderId, variantId: item.variantId, warehouseId: b.warehouseId, quantity: take, status: 'ACTIVE', expiresAt } });
          await tx.stockMovement.create({ data: { groupId, variantId: item.variantId, warehouseId: b.warehouseId, type: 'RESERVE', quantity: take, orderId, rm } });
          break;
        }
      }
    }

    if (remaining > 0) throw unprocessable(`Estoque insuficiente para a variante (faltam ${remaining}).`);
    await syncVariantCache(tx, item.variantId);
  }
  return expiresAt;
}

// ---------------------------------------------------- BAIXA (pagamento aprovado)
export async function commitForOrder(tx: Tx, groupId: string, orderId: string, rm: string | null) {
  const reservations = await tx.reservation.findMany({ where: { orderId, status: 'ACTIVE' } });
  for (const r of reservations) {
    const affected = await tx.$executeRaw`
      UPDATE "StockBalance" SET "onHand" = "onHand" - ${r.quantity}, reserved = reserved - ${r.quantity}, version = version + 1
      WHERE "variantId" = ${r.variantId} AND "warehouseId" = ${r.warehouseId} AND "onHand" >= ${r.quantity} AND reserved >= ${r.quantity}`;
    if (affected !== 1) throw unprocessable('Falha ao baixar o estoque reservado.');
    await tx.reservation.update({ where: { id: r.id }, data: { status: 'COMMITTED' } });
    await tx.stockMovement.create({ data: { groupId, variantId: r.variantId, warehouseId: r.warehouseId, type: 'SALE', quantity: r.quantity, orderId, rm } });
  }
  for (const vId of [...new Set(reservations.map((r) => r.variantId))]) await syncVariantCache(tx, vId);
}

// ---------------------------------------------------- LIBERAÇÃO (cancel/expira)
export async function releaseForOrder(tx: Tx, groupId: string, orderId: string, rm: string | null, reason: string) {
  const reservations = await tx.reservation.findMany({ where: { orderId, status: 'ACTIVE' } });
  for (const r of reservations) {
    await tx.$executeRaw`
      UPDATE "StockBalance" SET reserved = reserved - ${r.quantity}, version = version + 1
      WHERE "variantId" = ${r.variantId} AND "warehouseId" = ${r.warehouseId} AND reserved >= ${r.quantity}`;
    await tx.reservation.update({ where: { id: r.id }, data: { status: 'RELEASED' } });
    await tx.stockMovement.create({ data: { groupId, variantId: r.variantId, warehouseId: r.warehouseId, type: 'RELEASE', quantity: r.quantity, orderId, rm, reason } });
  }
  for (const vId of [...new Set(reservations.map((r) => r.variantId))]) await syncVariantCache(tx, vId);
}

// ---------------------------------------------------- REVERSÃO (reembolso)
/** Devolve ao estoque a quantidade já baixada (reservas COMMITTED) de um pedido. */
export async function reverseCommittedStock(tx: Tx, groupId: string, orderId: string, rm: string | null) {
  const reservations = await tx.reservation.findMany({ where: { orderId, status: 'COMMITTED' } });
  for (const r of reservations) {
    await tx.$executeRaw`
      UPDATE "StockBalance" SET "onHand" = "onHand" + ${r.quantity}, version = version + 1
      WHERE "variantId" = ${r.variantId} AND "warehouseId" = ${r.warehouseId}`;
    await tx.stockMovement.create({ data: { groupId, variantId: r.variantId, warehouseId: r.warehouseId, type: 'RECEIVE', quantity: r.quantity, orderId, rm, reason: 'estorno/reembolso' } });
  }
  for (const vId of [...new Set(reservations.map((r) => r.variantId))]) await syncVariantCache(tx, vId);
}

// ---------------------------------------------------- ENTRADA / AJUSTE
export async function receive(groupId: string, variantId: string, warehouseId: string, quantity: number, reason: string | undefined, rm: string | null) {
  if (quantity <= 0) throw badRequest('quantity deve ser > 0.');
  await ensureBalance(groupId, variantId);
  await assertWarehouse(groupId, warehouseId);
  await prisma.$transaction(async (tx) => {
    await tx.stockBalance.upsert({
      where: { variantId_warehouseId: { variantId, warehouseId } },
      create: { groupId, variantId, warehouseId, onHand: quantity, reserved: 0 },
      update: { onHand: { increment: quantity }, version: { increment: 1 } },
    });
    await tx.stockMovement.create({ data: { groupId, variantId, warehouseId, type: 'RECEIVE', quantity, reason, rm } });
    await syncVariantCache(tx, variantId);
  });
  return balanceView(groupId, variantId);
}

export async function adjust(groupId: string, variantId: string, warehouseId: string, newOnHand: number, reason: string | undefined, rm: string | null) {
  if (newOnHand < 0) throw badRequest('newOnHand não pode ser negativo.');
  await ensureBalance(groupId, variantId);
  await assertWarehouse(groupId, warehouseId);
  await prisma.$transaction(async (tx) => {
    const existing = await tx.stockBalance.findUnique({ where: { variantId_warehouseId: { variantId, warehouseId } }, select: { onHand: true, reserved: true } });
    const oldOnHand = existing?.onHand ?? 0;
    if (existing && newOnHand < existing.reserved) throw unprocessable(`Não é possível ajustar abaixo do reservado (${existing.reserved}).`);
    await tx.stockBalance.upsert({
      where: { variantId_warehouseId: { variantId, warehouseId } },
      create: { groupId, variantId, warehouseId, onHand: newOnHand, reserved: 0 },
      update: { onHand: newOnHand, version: { increment: 1 } },
    });
    await tx.stockMovement.create({ data: { groupId, variantId, warehouseId, type: 'ADJUST', quantity: newOnHand - oldOnHand, reason, rm } });
    await syncVariantCache(tx, variantId);
  });
  return balanceView(groupId, variantId);
}

// ---------------------------------------------------- CONSULTAS
export async function balanceView(groupId: string, variantId: string) {
  await ensureBalance(groupId, variantId);
  const variant = await prisma.productVariant.findFirst({ where: tenantScope(groupId, { id: variantId }), select: { id: true, sku: true, minStock: true } });
  if (!variant) throw notFound('Variante não encontrada.');
  const balances = await prisma.stockBalance.findMany({ where: { variantId }, include: { warehouse: { select: { id: true, name: true } } } });
  const perWarehouse = balances.map((b) => ({ warehouseId: b.warehouseId, warehouse: b.warehouse.name, onHand: b.onHand, reserved: b.reserved, available: b.onHand - b.reserved }));
  return {
    variantId: variant.id, sku: variant.sku, minStock: variant.minStock,
    onHand: perWarehouse.reduce((s, w) => s + w.onHand, 0),
    reserved: perWarehouse.reduce((s, w) => s + w.reserved, 0),
    available: perWarehouse.reduce((s, w) => s + w.available, 0),
    warehouses: perWarehouse,
  };
}

export async function listMovements(groupId: string, variantId: string, q: { type?: string; page: number; pageSize: number }) {
  const where = tenantScope(groupId, { variantId, ...(q.type ? { type: q.type as any } : {}) });
  const [total, movements] = await Promise.all([
    prisma.stockMovement.count({ where }),
    prisma.stockMovement.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { warehouse: { select: { name: true } } } }),
  ]);
  return {
    total, page: q.page, pageSize: q.pageSize,
    data: movements.map((m) => ({ type: m.type, quantity: m.quantity, warehouse: m.warehouse.name, reason: m.reason, orderId: m.orderId, rm: m.rm, createdAt: m.createdAt.toISOString() })),
  };
}

// ---------------------------------------------------- INVENTÁRIO (contagem)
export async function applyCount(groupId: string, rm: string | null, counts: { variantId: string; warehouseId: string; counted: number }[]) {
  const results = [];
  for (const c of counts) {
    const view = await adjust(groupId, c.variantId, c.warehouseId, c.counted, 'inventário', rm);
    results.push({ variantId: c.variantId, available: view.available });
  }
  return { adjusted: results.length, results };
}

async function assertWarehouse(groupId: string, warehouseId: string) {
  const w = await prisma.warehouse.findFirst({ where: tenantScope(groupId, { id: warehouseId }), select: { id: true } });
  if (!w) throw badRequest('warehouseId não pertence a este grupo.');
}
