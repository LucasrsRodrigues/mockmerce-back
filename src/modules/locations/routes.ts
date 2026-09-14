import type { FastifyInstance } from 'fastify';
import type { PickupPoint } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parseCoords, sortByDistance, type Coords } from '../../lib/geo.js';

const sec = [{ apiKey: [], studentRm: [] }];

const pointBodyProps = {
  name: { type: 'string', minLength: 1, maxLength: 80, description: 'Ex.: "Loja Paulista".' },
  latitude: { type: 'number', minimum: -90, maximum: 90 },
  longitude: { type: 'number', minimum: -180, maximum: 180 },
  cep: { type: 'string', nullable: true },
  street: { type: 'string', nullable: true },
  number: { type: 'string', nullable: true },
  complement: { type: 'string', nullable: true },
  district: { type: 'string', nullable: true },
  city: { type: 'string', nullable: true },
  state: { type: 'string', nullable: true },
  hours: { type: 'string', nullable: true, description: 'Ex.: "Seg a Sex, 9h às 18h".' },
  active: { type: 'boolean' },
} as const;

function serializePoint(p: PickupPoint & { distanceKm?: number | null }) {
  return {
    id: p.id,
    name: p.name,
    address: {
      cep: p.cep, street: p.street, number: p.number, complement: p.complement,
      district: p.district, city: p.city, state: p.state,
    },
    /// Formato que o react-native-maps espera direto no <Marker coordinate={} />.
    coordinate: { latitude: p.latitude, longitude: p.longitude },
    hours: p.hours,
    active: p.active,
    /// Preenchido só quando a busca informa de onde o cliente está.
    distanceKm: p.distanceKm ?? null,
  };
}

/**
 * Localização e mapa (f6-locations).
 *
 * Pontos de retirada da loja: a loja cadastra onde o cliente pode buscar o
 * pedido; o app lista no mapa, ordenado por distância de quem está olhando.
 *
 * A distância é em LINHA RETA (Haversine), não de rua — serve para ordenar e
 * dar noção de perto/longe, não para estimar tempo de trajeto.
 */
export async function locationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  // =====================================================================
  // VITRINE — o app lista os pontos no mapa
  // =====================================================================
  app.get('/pickup-points', {
    schema: {
      tags: ['Localização'],
      summary: 'Pontos de retirada ativos, ordenados por distância',
      description:
        'Informe **latitude** e **longitude** (a posição do cliente) para ordenar por proximidade ' +
        'e receber `distanceKm` em cada ponto. Sem elas, a lista vem por nome e `distanceKm` é null.',
      security: sec,
      querystring: {
        type: 'object',
        properties: {
          latitude: { type: 'number', minimum: -90, maximum: 90 },
          longitude: { type: 'number', minimum: -180, maximum: 180 },
          maxKm: { type: 'number', minimum: 0, description: 'Descarta pontos além deste raio.' },
        },
      },
    },
  }, async (req) => {
    const q = req.query as { latitude?: number; longitude?: number; maxKm?: number };
    const de = parseCoords(q.latitude, q.longitude);

    const pontos = await prisma.pickupPoint.findMany({
      where: tenantScope(req.group!.id, { active: true }),
      orderBy: { name: 'asc' },
    });

    let lista = sortByDistance(pontos, de);
    if (de && q.maxKm !== undefined) {
      lista = lista.filter((p) => p.distanceKm !== null && p.distanceKm <= q.maxKm!);
    }
    return { data: lista.map(serializePoint), origin: de };
  });

  // =====================================================================
  // LOJA — cadastro dos pontos (painel do aluno)
  // =====================================================================
  app.get('/store/pickup-points', {
    schema: { tags: ['Localização'], summary: 'Lista os pontos da loja (inclusive inativos)', security: sec },
  }, async (req) => {
    const pontos = await prisma.pickupPoint.findMany({
      where: tenantScope(req.group!.id), orderBy: { createdAt: 'desc' },
    });
    return { data: pontos.map((p) => serializePoint(p)) };
  });

  app.post('/store/pickup-points', {
    schema: {
      tags: ['Localização'], summary: 'Cadastra um ponto de retirada', security: sec,
      body: { type: 'object', required: ['name', 'latitude', 'longitude'], properties: pointBodyProps },
    },
  }, async (req, reply) => {
    const body = req.body as any;
    const coords = parseCoords(body.latitude, body.longitude);
    if (!coords) throw badRequest('Informe latitude e longitude do ponto.');
    const ponto = await prisma.pickupPoint.create({
      // `name` sai explícito porque é obrigatório — o resto vem do pickBody.
      data: { ...pickBody(body), name: String(body.name), ...coords, groupId: req.group!.id },
    });
    return reply.code(201).send(serializePoint(ponto));
  });

  app.patch('/store/pickup-points/:id', {
    schema: {
      tags: ['Localização'], summary: 'Edita um ponto de retirada', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', properties: pointBodyProps },
    },
  }, async (req) => {
    const id = (req.params as { id: string }).id;
    const body = req.body as any;
    await findPoint(req.group!.id, id);
    const coords = parseCoords(body.latitude, body.longitude);
    const ponto = await prisma.pickupPoint.update({
      where: { id },
      data: { ...pickBody(body), ...(coords ?? {}) },
    });
    return serializePoint(ponto);
  });

  app.delete('/store/pickup-points/:id', {
    schema: {
      tags: ['Localização'], summary: 'Remove um ponto de retirada', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    await findPoint(req.group!.id, id);
    // Pedidos antigos apontam para o ponto (SetNull), então apagar não os quebra.
    await prisma.pickupPoint.delete({ where: { id } });
    return reply.code(204).send();
  });
}

/** Só os campos de endereço/exibição — coordenada é tratada à parte (validada). */
function pickBody(body: any) {
  const campos = ['name', 'cep', 'street', 'number', 'complement', 'district', 'city', 'state', 'hours', 'active'] as const;
  const out: Record<string, unknown> = {};
  for (const c of campos) if (body[c] !== undefined) out[c] = body[c];
  return out;
}

async function findPoint(groupId: string, id: string) {
  const ponto = await prisma.pickupPoint.findFirst({ where: tenantScope(groupId, { id }), select: { id: true } });
  if (!ponto) throw notFound('Ponto de retirada não encontrado.');
  return ponto;
}

/** Coordenada da loja (origem do trajeto e referência de distância). */
export async function storeOrigin(groupId: string): Promise<Coords | null> {
  const cfg = await prisma.groupConfig.findUnique({
    where: { groupId }, select: { latitude: true, longitude: true },
  });
  if (!cfg?.latitude || !cfg?.longitude) return null;
  return { latitude: cfg.latitude, longitude: cfg.longitude };
}
