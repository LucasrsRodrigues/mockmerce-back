import type { FastifyInstance } from 'fastify';
import { WEBHOOK_EVENTS } from './signer.js';
import {
  createEndpoint, listEndpoints, getEndpointOrThrow, updateEndpoint, deleteEndpoint,
  rotateSecret, listDeliveries,
} from './service.js';
import { pingEndpoint, resendDelivery, runRelayPass } from './relay.js';

const sec = [{ apiKey: [], studentRm: [] }];

export async function webhookRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  // Catálogo de eventos
  app.get('/webhooks/events', { schema: { tags: ['Webhooks'], summary: 'Lista os tipos de evento disponíveis', security: sec } },
    async () => ({ events: WEBHOOK_EVENTS }));

  // ------------------------------------------------------------- CRUD endpoints
  app.get('/webhooks', { schema: { tags: ['Webhooks'], summary: 'Lista os webhooks do grupo', security: sec } },
    async (req) => listEndpoints(req.group!.id));

  app.post('/webhooks', {
    schema: {
      tags: ['Webhooks'], summary: 'Registra um webhook (o signingSecret é mostrado UMA vez)', security: sec,
      body: {
        type: 'object', required: ['url'],
        properties: {
          url: { type: 'string', description: 'HTTPS. Interno/metadata é bloqueado (anti-SSRF).' },
          description: { type: 'string' },
          events: { type: 'array', items: { type: 'string' }, description: "Tipos assinados; ['*'] = todos." },
        },
      },
    },
  }, async (req, reply) => reply.code(201).send(await createEndpoint(req.group!.id, req.body as any)));

  app.get('/webhooks/:id', {
    schema: { tags: ['Webhooks'], summary: 'Detalha um webhook', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const e = await getEndpointOrThrow(req.group!.id, (req.params as any).id);
    return { id: e.id, url: e.url, description: e.description, events: e.events, active: e.active, createdAt: e.createdAt.toISOString() };
  });

  app.patch('/webhooks/:id', {
    schema: {
      tags: ['Webhooks'], summary: 'Atualiza um webhook', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', properties: { url: { type: 'string' }, description: { type: 'string' }, events: { type: 'array', items: { type: 'string' } }, active: { type: 'boolean' } } },
    },
  }, async (req) => updateEndpoint(req.group!.id, (req.params as any).id, req.body as any));

  app.delete('/webhooks/:id', {
    schema: { tags: ['Webhooks'], summary: 'Remove um webhook', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req, reply) => { await deleteEndpoint(req.group!.id, (req.params as any).id); return reply.code(204).send(); });

  app.post('/webhooks/:id/rotate-secret', {
    schema: { tags: ['Webhooks'], summary: 'Gera um novo signingSecret (invalida o anterior)', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => rotateSecret(req.group!.id, (req.params as any).id));

  app.post('/webhooks/:id/ping', {
    schema: { tags: ['Webhooks'], summary: 'Envia um evento de teste (webhook.ping) ao endpoint', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => pingEndpoint(req.group!.id, (req.params as any).id));

  // ------------------------------------------------------------- Inspector
  app.get('/webhooks/deliveries', {
    schema: {
      tags: ['Webhooks'], summary: 'Histórico de entregas (inspector)', security: sec,
      querystring: {
        type: 'object',
        properties: {
          endpointId: { type: 'string' }, status: { type: 'string', enum: ['PENDING', 'SUCCESS', 'DEAD_LETTER'] },
          page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async (req) => listDeliveries(req.group!.id, req.query as any));

  app.post('/webhooks/deliveries/:id/resend', {
    schema: { tags: ['Webhooks'], summary: 'Reenvia uma entrega manualmente', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => resendDelivery(req.group!.id, (req.params as any).id));

  // ------------------------------------------------------------- Deliver-now (teste/determinismo)
  app.post('/webhooks/deliver-now', {
    schema: { tags: ['Webhooks'], summary: 'Força uma passada do relay para o grupo (útil em testes)', security: sec },
  }, async (req) => runRelayPass(req.group!.id, true));
}
