import type { FastifyInstance } from 'fastify';
import { createCharge, getCharge, settleCharge, createSubscription, advanceSubscription } from './paymentSandbox.js';
import { quoteForRequest, createShipment, getShipment, advanceShipment } from './shippingSandbox.js';

const sec = [{ apiKey: [], studentRm: [] }];

export async function sandboxRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  // ====================================================================
  // PAGAMENTO FAKE  (imita um PSP: criar cobrança → status → webhook)
  // ====================================================================
  app.post('/sandbox/payments', {
    schema: {
      tags: ['Sandbox'], summary: '[FAKE] Cria uma cobrança (PIX/cartão/boleto)', security: sec,
      description: 'Cartão resolve na hora; PIX/boleto ficam PENDING até o settle. Use orderId para ligar a um pedido.',
      body: {
        type: 'object', required: ['method'],
        properties: {
          method: { type: 'string', enum: ['CREDIT_CARD', 'PIX', 'BOLETO'] },
          amount: { type: 'number', minimum: 0 },
          orderId: { type: 'string' },
          installments: { type: 'integer', minimum: 1, maximum: 12 },
          simulate: { type: 'string', enum: ['approve', 'decline'], default: 'approve' },
        },
      },
    },
  }, async (req, reply) => reply.code(201).send(await createCharge(req.group!.id, req.rm ?? null, req.body as any)));

  app.get('/sandbox/payments/:id', {
    schema: { tags: ['Sandbox'], summary: '[FAKE] Consulta o status de uma cobrança', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => getCharge(req.group!.id, (req.params as any).id));

  app.post('/sandbox/payments/:id/settle', {
    schema: {
      tags: ['Sandbox'], summary: '[FAKE] Confirma (settle) uma cobrança PIX/boleto → dispara webhook', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', properties: { simulate: { type: 'string', enum: ['approve', 'decline'], default: 'approve' } } },
    },
  }, async (req) => settleCharge(req.group!.id, (req.params as any).id, req.rm ?? null, (req.body as any)?.simulate ?? 'approve'));

  app.post('/sandbox/subscriptions', {
    schema: {
      tags: ['Sandbox'], summary: '[FAKE] Cria uma assinatura recorrente', security: sec,
      body: { type: 'object', required: ['amount', 'intervalDays'], properties: { amount: { type: 'number', minimum: 0 }, intervalDays: { type: 'integer', minimum: 1 }, customerId: { type: 'string' } } },
    },
  }, async (req, reply) => reply.code(201).send(await createSubscription(req.group!.id, req.body as any)));

  app.post('/sandbox/subscriptions/:id/advance', {
    schema: { tags: ['Sandbox'], summary: '[FAKE] Avança um ciclo da assinatura (gera cobrança + webhook)', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => advanceSubscription(req.group!.id, (req.params as any).id, req.rm ?? null));

  // ====================================================================
  // FRETE FAKE  (cotação por CEP + rastreamento)
  // ====================================================================
  app.post('/sandbox/shipping/quote', {
    schema: {
      tags: ['Sandbox'], summary: '[FAKE] Cotação de frete por CEP (PAC/SEDEX/Transportadora/Retirada)', security: sec,
      body: {
        type: 'object', required: ['cepDestino'],
        properties: {
          cepDestino: { type: 'string' },
          orderId: { type: 'string', description: 'Usa o peso das variantes do pedido.' },
          items: { type: 'array', items: { type: 'object', properties: { weightGr: { type: 'integer' }, quantity: { type: 'integer' } } } },
        },
      },
    },
  }, async (req) => quoteForRequest(req.group!.id, req.body as any));

  app.post('/sandbox/shipments', {
    schema: {
      tags: ['Sandbox'], summary: '[FAKE] Despacha um pedido (cria envio + rastreamento)', security: sec,
      body: {
        type: 'object', required: ['orderId', 'service', 'cepDestino'],
        properties: {
          orderId: { type: 'string' },
          service: { type: 'string', enum: ['PAC', 'SEDEX', 'TRANSPORTADORA', 'RETIRADA_LOJA'] },
          cepDestino: { type: 'string' },
          // Destino do trajeto no mapa. Sem isto, usa o endereço padrão do
          // cliente (quando ele marcou o ponto no mapa).
          latitude: { type: 'number', minimum: -90, maximum: 90 },
          longitude: { type: 'number', minimum: -180, maximum: 180 },
        },
      },
    },
  }, async (req, reply) => reply.code(201).send(await createShipment(req.group!.id, req.body as any)));

  app.get('/sandbox/shipments/:id', {
    schema: { tags: ['Sandbox'], summary: '[FAKE] Detalha um envio + rastreamento', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => getShipment(req.group!.id, (req.params as any).id));

  app.post('/sandbox/shipments/:id/advance', {
    schema: { tags: ['Sandbox'], summary: '[FAKE] Avança o rastreamento (postado→trânsito→entregue) + webhook', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => advanceShipment(req.group!.id, (req.params as any).id));
}
