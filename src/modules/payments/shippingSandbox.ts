import { randomBytes } from 'node:crypto';
import type { ShipmentStatus } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { emitEvent } from '../../lib/outbox.js';
import { money } from '../../lib/serialize.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

const ORIGIN_REGION = 1; // "loja" em São Paulo (CEP começando 0/1)
const round = (v: number) => Number(v.toFixed(2));

export interface QuoteItem { weightGr: number; quantity: number }

/** Cotação de frete PURA e DETERMINÍSTICA a partir do CEP e do peso. */
export function quoteShipping(cepDestino: string, items: QuoteItem[]) {
  const cep = cepDestino.replace(/\D/g, '');
  if (cep.length !== 8) throw badRequest('CEP inválido (informe 8 dígitos).');
  const region = parseInt(cep.slice(0, 2), 10);
  const zone = Math.min(5, Math.floor(Math.abs(region - ORIGIN_REGION) / 20)); // 0..5
  const weightKg = Math.max(0.3, items.reduce((s, i) => s + ((i.weightGr || 500) / 1000) * i.quantity, 0));

  return {
    cepDestino: cep,
    weightKg: round(weightKg),
    zone,
    options: [
      { service: 'PAC', price: round(15 + weightKg * 8 + zone * 3), etaDays: 5 + zone * 2 },
      { service: 'SEDEX', price: round(25 + weightKg * 12 + zone * 4), etaDays: 2 + zone },
      { service: 'TRANSPORTADORA', price: round(20 + weightKg * 10 + zone * 2), etaDays: 4 + zone },
      { service: 'RETIRADA_LOJA', price: 0, etaDays: 0 },
    ],
  };
}

async function orderItemsWeights(groupId: string, orderId: string): Promise<QuoteItem[]> {
  const order = await prisma.order.findFirst({
    where: tenantScope(groupId, { id: orderId }),
    include: { items: { include: { variant: { select: { weightGr: true } } } } },
  });
  if (!order) throw notFound('Pedido não encontrado.');
  return order.items.map((it) => ({ weightGr: it.variant.weightGr ?? 500, quantity: it.quantity }));
}

/** Cotação a partir de um pedido (usa o peso das variantes) ou de itens explícitos. */
export async function quoteForRequest(groupId: string, input: { cepDestino: string; orderId?: string; items?: QuoteItem[] }) {
  const items = input.orderId ? await orderItemsWeights(groupId, input.orderId) : input.items ?? [{ weightGr: 500, quantity: 1 }];
  return quoteShipping(input.cepDestino, items);
}

// ------------------------------------------------------------- Rastreamento
const FLOW: ShipmentStatus[] = ['CREATED', 'POSTED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'];
const DESC: Record<ShipmentStatus, string> = {
  CREATED: 'Envio criado',
  POSTED: 'Objeto postado',
  IN_TRANSIT: 'Em trânsito',
  OUT_FOR_DELIVERY: 'Saiu para entrega',
  DELIVERED: 'Objeto entregue ao destinatário',
};

function serializeShipment(s: any) {
  return {
    id: s.id, orderId: s.orderId, service: s.service, cost: money(s.cost), etaDays: s.etaDays,
    status: s.status, trackingCode: s.trackingCode,
    events: (s.events ?? []).map((e: any) => ({ status: e.status, description: e.description, at: e.createdAt.toISOString() })),
    createdAt: s.createdAt.toISOString(),
  };
}

export async function createShipment(groupId: string, input: { orderId: string; service: string; cepDestino: string }) {
  const quote = await quoteForRequest(groupId, { cepDestino: input.cepDestino, orderId: input.orderId });
  const option = quote.options.find((o) => o.service === input.service);
  if (!option) throw badRequest(`Serviço inválido. Opções: ${quote.options.map((o) => o.service).join(', ')}.`);

  const trackingCode = `BR${randomBytes(5).toString('hex').toUpperCase()}BR`;
  const shipment = await prisma.shipment.create({
    data: {
      groupId, orderId: input.orderId, service: input.service, cost: option.price, etaDays: option.etaDays,
      status: 'CREATED', trackingCode,
      events: { create: [{ status: 'CREATED', description: DESC.CREATED }] },
    },
    include: { events: { orderBy: { createdAt: 'asc' } } },
  });
  return serializeShipment(shipment);
}

export async function getShipment(groupId: string, id: string) {
  const s = await prisma.shipment.findFirst({ where: tenantScope(groupId, { id }), include: { events: { orderBy: { createdAt: 'asc' } } } });
  if (!s) throw notFound('Envio não encontrado.');
  return serializeShipment(s);
}

/** Avança o rastreamento para o próximo estado e emite shipment.updated. */
export async function advanceShipment(groupId: string, id: string) {
  const s = await prisma.shipment.findFirst({ where: tenantScope(groupId, { id }) });
  if (!s) throw notFound('Envio não encontrado.');
  const idx = FLOW.indexOf(s.status);
  if (idx >= FLOW.length - 1) throw conflict('Envio já foi entregue.');
  const next = FLOW[idx + 1];

  await prisma.$transaction(async (tx) => {
    await tx.shipment.update({ where: { id }, data: { status: next } });
    await tx.trackingEvent.create({ data: { shipmentId: id, status: next, description: DESC[next] } });
    await emitEvent(tx, groupId, 'shipment.updated', { shipmentId: id, orderId: s.orderId, status: next, trackingCode: s.trackingCode });
  });

  return getShipment(groupId, id);
}
