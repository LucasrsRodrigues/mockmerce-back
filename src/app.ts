import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { env } from './env.js';
import './types.js';

import { swaggerPlugin } from './plugins/swagger.js';
import { authPlugin } from './plugins/auth.js';
import { requestLogPlugin } from './plugins/requestLog.js';
import { rateLimitPlugin } from './plugins/rateLimit.js';
import { idempotencyPlugin } from './plugins/idempotency.js';
import { setErrorHandler } from './plugins/errorHandler.js';

import { catalogRoutes } from './modules/catalog/routes.js';
import { mediaRoutes } from './modules/media/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { webhookRoutes } from './modules/webhooks/routes.js';
import { sandboxRoutes } from './modules/payments/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { customerRoutes } from './modules/customers/routes.js';
import { cartRoutes } from './modules/cart/routes.js';
import { orderRoutes } from './modules/orders/routes.js';
import { storeOrderRoutes } from './modules/orders/storeRoutes.js';
import { customerStoreRoutes } from './modules/customers/storeRoutes.js';
import { commsRoutes } from './modules/comms/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { storeAuthRoutes } from './modules/store-auth/routes.js';
import { teachingRoutes } from './modules/teaching/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { adminInspectRoutes } from './modules/admin/inspect.js';
import { adminDashboardRoutes } from './modules/admin/dashboard.js';
import { adminAuthorshipRoutes } from './modules/admin/authorship.js';
import { operatorRoutes } from './modules/admin/operators.js';
import { teachingAdminRoutes } from './modules/teaching/adminRoutes.js';

/** Caminhos que NÃO recebem o prefixo /v1 (control plane, docs, infra). */
function keepAsIs(path: string): boolean {
  return path === '/' || path === '/health' || path === '/favicon.ico'
    || path === '/v1' || path.startsWith('/v1/')
    || path.startsWith('/docs') || path.startsWith('/admin');
}

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'development' ? 'info' : 'warn',
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
          : undefined,
    },
    // Versionamento (ADR-G6): as rotas de negócio vivem em /v1; caminhos antigos
    // (sem prefixo) são reescritos para /v1 de forma transparente (alias).
    rewriteUrl(req) {
      const url = req.url || '/';
      const path = url.split('?')[0];
      return keepAsIs(path) ? url : `/v1${url}`;
    },
  });

  // CORS por rota:
  //   - /admin/*  (control plane / painel do professor): restrito a ADMIN_CORS_ORIGIN.
  //   - resto     (/v1/* — API que os alunos consomem via API key/SDK): aberto.
  // Obs.: os painéis batem no backend pelo proxy /api do Nginx (same-origin), então
  // NUNCA disparam CORS; isto só afeta chamadas cross-origin diretas do browser.
  const openOrigin: true | string[] =
    env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((s) => s.trim());
  const adminOrigin: true | string[] = env.ADMIN_CORS_ORIGIN
    ? env.ADMIN_CORS_ORIGIN.split(',').map((s) => s.trim())
    : openOrigin; // sem ADMIN_CORS_ORIGIN, herda o geral (não trava em dev)

  await app.register(cors, {
    delegator: (req: { url?: string }, cb: (err: Error | null, opts: { origin: true | string[] }) => void) => {
      const path = (req.url || '/').split('?')[0];
      const isAdmin = path === '/admin' || path.startsWith('/admin/');
      cb(null, { origin: isAdmin ? adminOrigin : openOrigin });
    },
  });

  // Tolera body vazio com Content-Type: application/json (cilada comum de quem
  // usa fetch cru em rotas sem corpo, como checkout/cancel/DELETE).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (text === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  // Upload de arquivos (multipart/form-data). O limite por arquivo é o do .env;
  // 1 arquivo por requisição — o resto é descartado em media/routes.ts.
  await app.register(multipart, {
    limits: {
      fileSize: env.UPLOAD_MAX_MB * 1024 * 1024,
      files: 4,
      fields: 10,
    },
    // Em vez de estourar com o erro cru do plugin, o arquivo chega truncado e o
    // service devolve 413 FILE_TOO_LARGE com o limite em MB na mensagem.
    throwFileSizeLimit: false,
  });

  setErrorHandler(app);

  // Infra: docs, auth (decorators), logging, rate limit e idempotência (globais).
  await app.register(swaggerPlugin);
  await app.register(authPlugin);
  await app.register(requestLogPlugin);
  await app.register(rateLimitPlugin);
  await app.register(idempotencyPlugin);

  // Healthcheck + raiz (não versionados).
  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/', { schema: { hide: true } }, async () => ({ name: 'E-commerce API — Projeto da Turma', docs: '/docs', apiBase: '/v1' }));

  // Rotas de NEGÓCIO — todas sob /v1.
  await app.register(async (v1) => {
    await v1.register(storeAuthRoutes);
    await v1.register(catalogRoutes);
    await v1.register(mediaRoutes);
    await v1.register(inventoryRoutes);
    await v1.register(webhookRoutes);
    await v1.register(sandboxRoutes);
    await v1.register(reportRoutes);
    await v1.register(customerRoutes);
    await v1.register(cartRoutes);
    await v1.register(orderRoutes);
    await v1.register(storeOrderRoutes);
    await v1.register(customerStoreRoutes);
    await v1.register(commsRoutes);
    await v1.register(settingsRoutes);
    await v1.register(teachingRoutes);
  }, { prefix: '/v1' });

  // CONTROL PLANE — não versionado.
  await app.register(adminRoutes);
  await app.register(adminInspectRoutes);
  await app.register(adminDashboardRoutes);
  await app.register(adminAuthorshipRoutes);
  await app.register(operatorRoutes);
  await app.register(teachingAdminRoutes);

  return app;
}
