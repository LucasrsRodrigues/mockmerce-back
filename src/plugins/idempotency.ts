import fp from 'fastify-plugin';
import { prisma } from '../prisma.js';
import { hashApiKey } from '../lib/apiKey.js';

/**
 * Idempotência (secure-coding: anti-replay/dupla execução). Se um POST traz o
 * header `Idempotency-Key` e uma `X-API-Key`, a MESMA chave não reprocessa: a
 * primeira resposta 2xx é guardada e devolvida nas repetições. Escopo por tenant
 * (hash da API key). Não depende do requireGroup (roda como hook global).
 */
export const idempotencyPlugin = fp(async (app) => {
  app.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'POST') return;
    const key = request.headers['idempotency-key'];
    const apiKey = request.headers['x-api-key'];
    if (typeof key !== 'string' || !key || typeof apiKey !== 'string' || !apiKey) return;

    const tenantKey = hashApiKey(apiKey);
    const existing = await prisma.idempotencyKey.findUnique({ where: { tenantKey_key: { tenantKey, key } } });
    if (existing) {
      reply.header('Idempotent-Replay', 'true');
      return reply.code(existing.statusCode).send(existing.responseJson);
    }
    request.idempotencyToStore = { tenantKey, key };
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const store = request.idempotencyToStore;
    if (!store) return payload;
    if (reply.statusCode < 200 || reply.statusCode >= 300) return payload; // só guarda sucesso

    let responseJson: unknown;
    try {
      responseJson = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch {
      responseJson = { raw: String(payload) };
    }
    // Fire-and-forget; upsert evita corrida na mesma chave.
    void prisma.idempotencyKey
      .upsert({
        where: { tenantKey_key: { tenantKey: store.tenantKey, key: store.key } },
        create: { tenantKey: store.tenantKey, key: store.key, method: request.method, path: request.url.split('?')[0], statusCode: reply.statusCode, responseJson: responseJson as any },
        update: {},
      })
      .catch((err) => request.log.error({ err }, 'Falha ao gravar IdempotencyKey'));
    return payload;
  });
});
