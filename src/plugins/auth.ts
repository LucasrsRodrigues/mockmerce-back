import fp from 'fastify-plugin';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { hashApiKey } from '../lib/apiKey.js';
import { verifyCustomerToken, verifyOperatorToken, verifyStudentToken } from '../lib/security.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { hasPermission } from '../modules/admin/rbac.js';

/**
 * Registra as três camadas de autenticação como decorators reutilizáveis:
 *   - requireGroup   -> X-API-Key  (identifica o grupo/tenant)
 *   - requireCustomer-> JWT         (identifica o comprador do app)
 *   - requireAdmin   -> X-Admin-Token (só o professor)
 */
export const authPlugin = fp(async (app) => {
  // ---- Camada 1: API Key do grupo ----
  app.decorate('requireGroup', async (request) => {
    const apiKey = request.headers['x-api-key'];

    // Caminho 1: API key do grupo (apps dos alunos / integrações).
    if (typeof apiKey === 'string' && apiKey) {
      const keyHash = hashApiKey(apiKey);

      // 1a) Chaves NOMEADAS criadas pelo grupo (estilo Shopify). Ignora as revogadas.
      const named = await prisma.apiKey.findFirst({
        where: { keyHash, revokedAt: null },
        select: { id: true, group: { select: { id: true, name: true, active: true } } },
      });
      if (named) {
        if (!named.group.active) throw forbidden('Esta API key está desativada. Fale com o professor.');
        request.group = { id: named.group.id, name: named.group.name };
        request.authVia = 'apiKey';
        const rm = request.headers['x-student-rm'];
        request.rm = typeof rm === 'string' && rm.trim() ? rm.trim() : null;
        // Marca o último uso (best-effort, não bloqueia a request).
        void prisma.apiKey.update({ where: { id: named.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
        return;
      }

      // 1b) Fallback: chave "primária" do grupo (criada pelo professor).
      const group = await prisma.group.findUnique({
        where: { apiKeyHash: keyHash },
        select: { id: true, name: true, active: true },
      });
      if (!group) throw unauthorized('API key inválida.');
      if (!group.active) throw forbidden('Esta API key está desativada. Fale com o professor.');
      request.group = { id: group.id, name: group.name };
      request.authVia = 'apiKey';
      const rm = request.headers['x-student-rm'];
      request.rm = typeof rm === 'string' && rm.trim() ? rm.trim() : null;
      return;
    }

    // Caminho 2: token de ALUNO (admin web) — deriva grupo + RM do token.
    const header = request.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      let payload;
      try {
        payload = verifyStudentToken(header.slice(7));
      } catch {
        throw unauthorized('Sessão inválida ou expirada. Faça login de novo.');
      }
      const group = await prisma.group.findUnique({ where: { id: payload.groupId }, select: { id: true, name: true, active: true } });
      if (!group) throw unauthorized('Grupo não encontrado.');
      if (!group.active) throw forbidden('Grupo desativado. Fale com o professor.');
      request.group = { id: group.id, name: group.name };
      request.authVia = 'student';
      request.rm = payload.rm;
      return;
    }

    throw unauthorized('Autenticação ausente (X-API-Key ou login de aluno).');
  });

  // ---- Camada 2: JWT do cliente final (exige grupo antes) ----
  app.decorate('requireCustomer', async (request) => {
    if (!request.group) {
      // requireGroup deve rodar antes; garantimos aqui por segurança.
      throw unauthorized('Faltou o header X-API-Key.');
    }

    const header = request.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw unauthorized('Faltou o token do cliente (Authorization: Bearer <token>).');
    }

    try {
      const payload = verifyCustomerToken(header.slice(7));
      // O token só vale dentro do grupo que o emitiu.
      if (payload.groupId !== request.group.id) {
        throw forbidden('Este token não pertence a este grupo.');
      }
      const customer = await prisma.customer.findFirst({
        where: { id: payload.sub, groupId: request.group.id },
        select: { id: true, email: true, name: true },
      });
      if (!customer) throw unauthorized('Cliente não encontrado.');
      request.customer = customer;
    } catch (err) {
      if (err instanceof Error && (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError')) {
        throw unauthorized('Token do cliente inválido ou expirado.');
      }
      throw err;
    }
  });

  // ---- Camada 3: Admin (professor) — master token OU token de operador ----
  app.decorate('requireAdmin', async (request) => {
    const master = request.headers['x-admin-token'];
    if (typeof master === 'string' && master === env.ADMIN_TOKEN) {
      request.operator = { id: null, email: null, role: 'ADMIN', isMaster: true };
      return;
    }
    const header = request.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      let payload;
      try {
        payload = verifyOperatorToken(header.slice(7));
      } catch {
        throw unauthorized('Token de operador inválido ou expirado.');
      }
      const op = await prisma.operatorUser.findUnique({ where: { id: payload.sub }, select: { id: true, email: true, role: true, active: true } });
      if (!op || !op.active) throw unauthorized('Operador inválido ou inativo.');
      request.operator = { id: op.id, email: op.email, role: op.role, isMaster: false };
      return;
    }
    throw unauthorized('Autenticação de admin ausente (X-Admin-Token ou token de operador).');
  });

  // ---- Autorização por permissão (deny-by-default) ----
  app.decorate('requirePermission', (permission: string) => async (request: import('fastify').FastifyRequest) => {
    if (!request.operator) throw unauthorized('Não autenticado.');
    if (!hasPermission(request.operator.role, permission)) throw forbidden(`Sem permissão para "${permission}".`);
  });
});
