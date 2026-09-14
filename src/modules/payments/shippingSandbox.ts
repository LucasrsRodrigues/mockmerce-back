import { randomBytes } from 'node:crypto';
import type { ShipmentStatus } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { emitEvent } from '../../lib/outbox.js';
import { DEFAULT_ORIGIN, interpolate, parseCoords, type Coords } from '../../lib/geo.js';
import { storeOrigin } from '../locations/routes.js';
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
  const coord = (lat: number | null, lng: number | null) =>
    lat !== null && lat !== undefined && lng !== null && lng !== undefined ? { latitude: lat, longitude: lng } : null;

  const events = (s.events ?? []).map((e: any) => ({
    status: e.status, description: e.description,
    coordinate: coord(e.latitude, e.longitude),
    at: e.createdAt.toISOString(),
  }));

  return {
    id: s.id, orderId: s.orderId, service: s.service, cost: money(s.cost), etaDays: s.etaDays,
    status: s.status, trackingCode: s.trackingCode,
    events,
    /// Tudo que o app precisa para desenhar o mapa do rastreio:
    ///   origin/destination → as pontas (e a região a enquadrar);
    ///   current            → onde o pin está agora;
    ///   path               → os pontos por onde passou, para a Polyline.
    tracking: {
      origin: coord(s.originLat, s.originLng),
      destination: coord(s.destinationLat, s.destinationLng),
      current: [...events].reverse().find((e: any) => e.coordinate)?.coordinate ?? null,
      path: events.filter((e: any) => e.coordinate).map((e: any) => e.coordinate),
    },
    createdAt: s.createdAt.toISOString(),
  };
}

export async function createShipment(groupId: string, input: { orderId: string; service: string; cepDestino: string; latitude?: number; longitude?: number }) {
  const quote = await quoteForRequest(groupId, { cepDestino: input.cepDestino, orderId: input.orderId });
  const option = quote.options.find((o) => o.service === input.service);
  if (!option) throw badRequest(`Serviço inválido. Opções: ${quote.options.map((o) => o.service).join(', ')}.`);

  // Pontas do trajeto (f6-locations), congeladas aqui:
  //   origem  = a loja (GroupConfig) ou o centro de SP, como no cálculo do frete;
  //   destino = o que o app mandou ou, na falta, o endereço padrão do cliente.
  const origem = (await storeOrigin(groupId)) ?? DEFAULT_ORIGIN;
  const destino = parseCoords(input.latitude, input.longitude) ?? (await destinoDoPedido(groupId, input.orderId));

  const trackingCode = `BR${randomBytes(5).toString('hex').toUpperCase()}BR`;
  const shipment = await prisma.shipment.create({
    data: {
      groupId, orderId: input.orderId, service: input.service, cost: option.price, etaDays: option.etaDays,
      status: 'CREATED', trackingCode,
      originLat: origem.latitude, originLng: origem.longitude,
      destinationLat: destino?.latitude ?? null, destinationLng: destino?.longitude ?? null,
      events: {
        create: [{
          status: 'CREATED', description: DESC.CREATED,
          latitude: origem.latitude, longitude: origem.longitude,
        }],
      },
    },
    include: { events: { orderBy: { createdAt: 'asc' } } },
  });
  return serializeShipment(shipment);
}

/** Coordenada do endereço padrão de quem fez o pedido (quando ele marcou no mapa). */
async function destinoDoPedido(groupId: string, orderId: string): Promise<Coords | null> {
  const order = await prisma.order.findFirst({ where: tenantScope(groupId, { id: orderId }), select: { customerId: true } });
  if (!order) return null;
  const addr = await prisma.address.findFirst({
    where: { customerId: order.customerId, type: 'SHIPPING', latitude: { not: null }, longitude: { not: null } },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    select: { latitude: true, longitude: true },
  });
  if (!addr?.latitude || !addr?.longitude) return null;
  return { latitude: addr.latitude, longitude: addr.longitude };
}

export async function getShipment(groupId: string, id: string) {
  const s = await prisma.shipment.findFirst({ where: tenantScope(groupId, { id }), include: { events: { orderBy: { createdAt: 'asc' } } } });
  if (!s) throw notFound('Envio não encontrado.');
  return serializeShipment(s);
}

/** Avança o rastreamento para o próximo estado e emite shipment.updated. */
/**
 * Quanto do caminho já foi andado em cada status. É o que faz o pin do app se
 * mexer: SIMULADO, interpolando em linha reta entre a loja e o destino.
 */
const PROGRESSO: Record<string, number> = {
  CREATED: 0,
  POSTED: 0.1,
  IN_TRANSIT: 0.55,
  OUT_FOR_DELIVERY: 0.9,
  DELIVERED: 1,
};

/** Onde o pedido está quando o envio chega a determinado status. */
function posicaoNoStatus(s: { originLat: number | null; originLng: number | null; destinationLat: number | null; destinationLng: number | null }, status: string): Coords | null {
  if (s.originLat === null || s.originLng === null || s.destinationLat === null || s.destinationLng === null) return null;
  return interpolate(
    { latitude: s.originLat, longitude: s.originLng },
    { latitude: s.destinationLat, longitude: s.destinationLng },
    PROGRESSO[status] ?? 0,
  );
}

export async function advanceShipment(groupId: string, id: string) {
  const s = await prisma.shipment.findFirst({ where: tenantScope(groupId, { id }) });
  if (!s) throw notFound('Envio não encontrado.');
  const idx = FLOW.indexOf(s.status);
  if (idx >= FLOW.length - 1) throw conflict('Envio já foi entregue.');
  const next = FLOW[idx + 1];

  const posicao = posicaoNoStatus(s, next);

  await prisma.$transaction(async (tx) => {
    await tx.shipment.update({ where: { id }, data: { status: next } });
    await tx.trackingEvent.create({
      data: { shipmentId: id, status: next, description: DESC[next], latitude: posicao?.latitude, longitude: posicao?.longitude },
    });
    await emitEvent(tx, groupId, 'shipment.updated', { shipmentId: id, orderId: s.orderId, status: next, trackingCode: s.trackingCode });
  });

  return getShipment(groupId, id);
}
