import fp from 'fastify-plugin';
import { prisma } from '../prisma.js';

/** Rotas que NÃO precisam ir para o log de auditoria (ruído). */
const IGNORE_PREFIXES = ['/docs', '/health', '/favicon'];

/**
 * Loga TODA requisição à API (exceto ruído acima) na tabela RequestLog.
 * É a base do seu controle: grupo, RM, rota, status, latência, IP.
 * Escreve de forma assíncrona ("fire and forget") para não atrasar a resposta.
 */
export const requestLogPlugin = fp(async (app) => {
  app.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (IGNORE_PREFIXES.some((p) => path.startsWith(p))) return;

    const groupId = request.group?.id ?? null;
    const rm = request.rm ?? null;

    void prisma.requestLog
      .create({
        data: {
          groupId,
          rm,
          method: request.method,
          path,
          statusCode: reply.statusCode,
          latencyMs: Math.round(reply.elapsedTime),
          ip: request.ip,
          userAgent: (request.headers['user-agent'] ?? '').slice(0, 255) || null,
        },
      })
      .catch((err) => {
        request.log.error({ err }, 'Falha ao gravar RequestLog');
      });
  });
});
