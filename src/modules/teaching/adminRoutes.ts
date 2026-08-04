import type { FastifyInstance } from 'fastify';
import { prisma } from '../../prisma.js';
import { notFound } from '../../lib/errors.js';
import { evaluateGroup, evaluateAllGroups, classView, dashboard, ranking } from './service.js';
import { syncRegistry } from './missions.js';

const adminSec = [{ adminToken: [] }];

/** Rotas da camada de ensino para o PROFESSOR (control plane). */
export async function teachingAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAdmin);

  // Dispara a avaliação (um grupo ou a turma toda).
  app.post('/admin/teaching/evaluate', {
    preHandler: app.requirePermission('groups:write'),
    schema: {
      tags: ['Admin'], summary: 'Avalia as missões (um grupo ou todos)', security: adminSec,
      body: { type: 'object', properties: { groupId: { type: 'string' } } },
    },
  }, async (req) => {
    const groupId = (req.body as any)?.groupId;
    if (groupId) { await evaluateGroup(groupId); return { evaluated: 1, groupId }; }
    return { evaluated: await evaluateAllGroups() };
  });

  // Visão da turma inteira (por grupo e por RM).
  app.get('/admin/teaching/class', {
    preHandler: app.requirePermission('activity:read'),
    schema: { tags: ['Admin'], summary: 'Visão da turma: XP/nota por grupo e por aluno', security: adminSec },
  }, async () => classView());

  // Ranking completo (inclui grupos em opt-out — o professor vê tudo).
  app.get('/admin/teaching/ranking', {
    preHandler: app.requirePermission('activity:read'),
    schema: { tags: ['Admin'], summary: 'Ranking completo (professor vê todos)', security: adminSec },
  }, async () => ranking(true));

  // Detalhe de um grupo (mesmo dashboard, com evidências).
  app.get('/admin/teaching/groups/:id', {
    preHandler: app.requirePermission('activity:read'),
    schema: { tags: ['Admin'], summary: 'Painel de um grupo específico', security: adminSec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const g = await prisma.group.findUnique({ where: { id: (req.params as any).id }, select: { id: true } });
    if (!g) throw notFound('Grupo não encontrado.');
    return dashboard(g.id);
  });

  // Catálogo de missões.
  app.get('/admin/missions', {
    preHandler: app.requirePermission('groups:read'),
    schema: { tags: ['Admin'], summary: 'Lista as missões', security: adminSec },
  }, async () => {
    await syncRegistry();
    return prisma.mission.findMany({ orderBy: [{ phase: 'asc' }, { points: 'asc' }], select: { key: true, title: true, description: true, phase: true, points: true, badgeKey: true, active: true, criteria: true } });
  });

  // Cria/edita uma missão personalizada.
  app.post('/admin/missions', {
    preHandler: app.requirePermission('groups:write'),
    schema: {
      tags: ['Admin'], summary: 'Cria ou atualiza uma missão', security: adminSec,
      body: {
        type: 'object', required: ['key', 'title', 'points', 'criteria'],
        properties: {
          key: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
          phase: { type: 'string' }, points: { type: 'integer', minimum: 0 }, badgeKey: { type: 'string' },
          active: { type: 'boolean' },
          criteria: { type: 'object', description: "{ type:'request'|'flow'|'state', ... }" },
        },
      },
    },
  }, async (req) => {
    const b = req.body as any;
    return prisma.mission.upsert({
      where: { key: b.key },
      create: { key: b.key, title: b.title, description: b.description ?? '', phase: b.phase ?? 'custom', points: b.points, badgeKey: b.badgeKey, criteria: b.criteria },
      update: { title: b.title, description: b.description, phase: b.phase, points: b.points, badgeKey: b.badgeKey, active: b.active, criteria: b.criteria },
      select: { key: true, title: true, points: true, active: true },
    });
  });
}
