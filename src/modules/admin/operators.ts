import type { FastifyInstance } from 'fastify';
import { prisma } from '../../prisma.js';
import { hashPassword, verifyPassword, signOperatorToken } from '../../lib/security.js';
import { recordAudit } from './rbac.js';
import { conflict, unauthorized } from '../../lib/errors.js';

const adminSec = [{ adminToken: [] }];

export async function operatorRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------- LOGIN (sem auth)
  app.post('/admin/login', {
    schema: {
      tags: ['Admin'], summary: 'Login de operador (retorna token de 12h)',
      body: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } } },
    },
  }, async (req) => {
    const { email, password } = req.body as { email: string; password: string };
    const op = await prisma.operatorUser.findUnique({ where: { email } });
    if (!op || !op.active || !(await verifyPassword(password, op.passwordHash))) {
      throw unauthorized('E-mail ou senha inválidos.');
    }
    const token = signOperatorToken({ sub: op.id, email: op.email, role: op.role });
    return { token, operator: { id: op.id, email: op.email, role: op.role } };
  });

  // ---------------------------------------------------------- CRIAR OPERADOR
  app.post('/admin/operators', {
    preHandler: [app.requireAdmin, app.requirePermission('operators:write')],
    schema: {
      tags: ['Admin'], summary: 'Cria um operador (só ADMIN)', security: adminSec,
      body: { type: 'object', required: ['email', 'password', 'role'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 }, role: { type: 'string', enum: ['ADMIN', 'MONITOR', 'VIEWER'] } } },
    },
  }, async (req, reply) => {
    const { email, password, role } = req.body as { email: string; password: string; role: any };
    const exists = await prisma.operatorUser.findUnique({ where: { email }, select: { id: true } });
    if (exists) throw conflict('Já existe um operador com este e-mail.');
    const op = await prisma.operatorUser.create({ data: { email, passwordHash: await hashPassword(password), role }, select: { id: true, email: true, role: true, active: true } });
    await recordAudit(req.operator!, 'operator.created', { targetType: 'operator', targetId: op.id, meta: { email, role } });
    return reply.code(201).send(op);
  });

  app.get('/admin/operators', {
    preHandler: [app.requireAdmin, app.requirePermission('operators:read')],
    schema: { tags: ['Admin'], summary: 'Lista operadores (só ADMIN)', security: adminSec },
  }, async () => prisma.operatorUser.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, email: true, role: true, active: true, createdAt: true } }));

  // ---------------------------------------------------------- AUDITORIA
  app.get('/admin/audit', {
    preHandler: [app.requireAdmin, app.requirePermission('audit:read')],
    schema: {
      tags: ['Admin'], summary: 'Log de auditoria de ações sensíveis', security: adminSec,
      querystring: { type: 'object', properties: { action: { type: 'string' }, page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } },
    },
  }, async (req) => {
    const q = req.query as any;
    const where = q.action ? { action: q.action } : {};
    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, data: logs.map((l) => ({ action: l.action, by: l.tokenMaster ? 'master' : l.operatorEmail, targetType: l.targetType, targetId: l.targetId, groupId: l.groupId, meta: l.meta, at: l.createdAt.toISOString() })) };
  });
}
