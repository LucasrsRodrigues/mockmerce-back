import fp from 'fastify-plugin';
import { env } from '../env.js';

/**
 * Rate limiting POR TENANT (chave = X-API-Key). Janela fixa de 60s em memória.
 * Defende contra noisy neighbor (multi-tenant-saas) — um grupo abusivo não
 * derruba os outros. 429 + Retry-After ao exceder. Requisições sem X-API-Key
 * (admin/docs/health) não são limitadas aqui.
 *
 * Obs.: em memória → correto para 1 instância. Em várias instâncias, migrar para
 * um store compartilhado (ex.: Redis). Documentado no design (ADR-3).
 */
export const rateLimitPlugin = fp(async (app) => {
  const buckets = new Map<string, { count: number; windowStart: number }>();
  const WINDOW_MS = 60_000;
  const LIMIT = env.RATE_LIMIT_PER_MINUTE;

  app.addHook('onRequest', async (request, reply) => {
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey !== 'string' || !apiKey) return; // só limita tráfego de grupo

    const now = Date.now();
    let bucket = buckets.get(apiKey);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      bucket = { count: 0, windowStart: now };
      buckets.set(apiKey, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, LIMIT - bucket.count);
    reply.header('X-RateLimit-Limit', String(LIMIT));
    reply.header('X-RateLimit-Remaining', String(remaining));

    if (bucket.count > LIMIT) {
      const retryAfter = Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000);
      reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: `Limite de ${LIMIT} req/min excedido. Tente em ${retryAfter}s.` } });
    }
  });

  // Limpeza periódica de buckets velhos (evita vazamento de memória).
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now - b.windowStart >= WINDOW_MS * 2) buckets.delete(k);
  }, WINDOW_MS);
  sweeper.unref?.();
});
