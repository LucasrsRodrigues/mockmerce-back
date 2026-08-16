import type { FastifyInstance } from 'fastify';
import { prisma } from '../../prisma.js';
import { badRequest } from '../../lib/errors.js';
import { dashboard, ranking, submit, studentProfile } from './service.js';

const sec = [{ apiKey: [], studentRm: [] }];

/** Rotas da camada de ensino visíveis ao GRUPO (via X-API-Key). */
export async function teachingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  app.get('/teaching/dashboard', {
    schema: { tags: ['Ensino'], summary: 'Painel do grupo: missões, XP, badges, nota e o que falta', security: sec },
  }, async (req) => dashboard(req.group!.id));

  app.get('/teaching/profile', {
    schema: { tags: ['Ensino'], summary: 'Perfil do aluno logado: badges individuais (conquistadas + bloqueadas com progresso)', security: sec },
  }, async (req) => {
    if (!req.rm) throw badRequest('Perfil individual requer login de aluno (header X-Student-RM).');
    return studentProfile(req.group!.id, req.rm);
  });

  app.get('/teaching/ranking', {
    schema: { tags: ['Ensino'], summary: 'Ranking de grupos por XP (respeita opt-out)', security: sec },
  }, async () => ranking(false));

  app.post('/teaching/submit', {
    schema: { tags: ['Ensino'], summary: 'Enviar para correção (snapshot imutável + nota)', security: sec },
  }, async (req) => submit(req.group!.id, req.rm ?? null));

  app.put('/teaching/settings', {
    schema: {
      tags: ['Ensino'], summary: 'Config de ensino do grupo (ex.: opt-out do ranking público)', security: sec,
      body: { type: 'object', properties: { rankingOptOut: { type: 'boolean' } } },
    },
  }, async (req) => {
    const groupId = req.group!.id;
    const { rankingOptOut } = req.body as { rankingOptOut?: boolean };
    return prisma.groupTeachingSettings.upsert({
      where: { groupId },
      create: { groupId, rankingOptOut: rankingOptOut ?? false },
      update: { rankingOptOut },
      select: { rankingOptOut: true },
    });
  });
}
