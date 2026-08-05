import type { FastifyInstance } from 'fastify';
import { prisma } from '../../prisma.js';
import { generateApiKey } from '../../lib/apiKey.js';
import { recordAudit } from './rbac.js';
import { conflict, notFound } from '../../lib/errors.js';

export async function adminRoutes(app: FastifyInstance) {
  // Autentica o control plane (master token OU operador). A autorização é por rota.
  app.addHook('preHandler', app.requireAdmin);

  // -------------------------------------------------------- CRIAR GRUPO + CHAVE
  app.post('/admin/groups', {
    preHandler: app.requirePermission('groups:write'),
    schema: {
      tags: ['Admin'],
      summary: 'Cria um grupo e gera a API key (mostrada UMA vez)',
      security: [{ adminToken: [] }],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          students: {
            type: 'array',
            items: {
              type: 'object',
              required: ['rm', 'name'],
              properties: { rm: { type: 'string' }, name: { type: 'string' } },
            },
          },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            apiKey: { type: 'string', description: 'GUARDE AGORA. Não será mostrada de novo.' },
            students: { type: 'array', items: { type: 'object', properties: { rm: { type: 'string' }, name: { type: 'string' } } } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { name, students = [] } = request.body as {
      name: string;
      students?: { rm: string; name: string }[];
    };

    const { key, hash, prefix } = generateApiKey();

    // RMs já cadastrados em outro grupo?
    const rms = students.map((s) => s.rm);
    if (rms.length) {
      const clash = await prisma.student.findMany({ where: { rm: { in: rms } }, select: { rm: true } });
      if (clash.length) {
        throw conflict(`RM(s) já cadastrados: ${clash.map((c) => c.rm).join(', ')}.`);
      }
    }

    const group = await prisma.group.create({
      data: {
        name,
        apiKeyHash: hash,
        apiKeyPrefix: prefix,
        students: { create: students.map((s) => ({ rm: s.rm, name: s.name })) },
      },
      include: { students: { select: { rm: true, name: true } } },
    });

    await recordAudit(request.operator!, 'group.created', { targetType: 'group', targetId: group.id, meta: { name } });
    return reply.code(201).send({
      id: group.id,
      name: group.name,
      apiKey: key, // única vez que a chave aparece
      students: group.students,
    });
  });

  // ------------------------------------------ IMPORTAR ALUNOS (roster, SEM grupo)
  // O professor sobe a lista da turma só para todos terem LOGIN (senha inicial = RM).
  // Depois cada aluno cria/entra numa loja pelo próprio painel. RMs já existentes
  // são ignorados (idempotente).
  app.post('/admin/students', {
    preHandler: app.requirePermission('groups:write'),
    schema: {
      tags: ['Admin'],
      summary: 'Importa alunos (RM + nome) SEM grupo — cria só o login',
      security: [{ adminToken: [] }],
      body: {
        type: 'object',
        required: ['students'],
        properties: {
          students: {
            type: 'array', minItems: 1,
            items: { type: 'object', required: ['rm', 'name'], properties: { rm: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 } } },
          },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            created: { type: 'integer' },
            skipped: { type: 'array', items: { type: 'string' }, description: 'RMs já existentes (não recriados)' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { students } = request.body as { students: { rm: string; name: string }[] };
    // Normaliza e deduplica dentro do próprio payload (último nome vence).
    const byRm = new Map<string, string>();
    for (const s of students) {
      const rm = s.rm.trim();
      if (rm) byRm.set(rm, s.name.trim());
    }
    const rms = [...byRm.keys()];

    const existing = await prisma.student.findMany({ where: { rm: { in: rms } }, select: { rm: true } });
    const existingSet = new Set(existing.map((e) => e.rm));
    const toCreate = rms.filter((rm) => !existingSet.has(rm)).map((rm) => ({ rm, name: byRm.get(rm)! }));

    if (toCreate.length) {
      await prisma.student.createMany({ data: toCreate }); // groupId = null (default)
    }
    await recordAudit(request.operator!, 'students.imported', { targetType: 'students', meta: { created: toCreate.length, skipped: existingSet.size } });
    return reply.code(201).send({ created: toCreate.length, skipped: [...existingSet] });
  });

  // -------------------------------------------------- LISTAR TODOS OS ALUNOS
  // Visão da turma inteira para o professor: quem está em qual loja e quem ainda
  // não foi alocado (groupId null) nem acessou.
  app.get('/admin/students', {
    preHandler: app.requirePermission('groups:read'),
    schema: {
      tags: ['Admin'], summary: 'Lista todos os alunos da turma (com/sem grupo)', security: [{ adminToken: [] }],
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              rm: { type: 'string' }, name: { type: 'string' }, jaAcessou: { type: 'boolean' },
              groupId: { type: ['string', 'null'] }, group: { type: ['string', 'null'] }, createdAt: { type: 'string' },
            },
          },
        },
      },
    },
  }, async () => {
    const students = await prisma.student.findMany({
      orderBy: { name: 'asc' },
      select: { rm: true, name: true, passwordHash: true, createdAt: true, group: { select: { id: true, name: true } } },
    });
    return students.map((s) => ({
      rm: s.rm, name: s.name, jaAcessou: s.passwordHash !== null,
      groupId: s.group?.id ?? null, group: s.group?.name ?? null, createdAt: s.createdAt.toISOString(),
    }));
  });

  // ------------------------------------------------------------- LISTAR GRUPOS
  app.get('/admin/groups', {
    preHandler: app.requirePermission('groups:read'),
    schema: {
      tags: ['Admin'],
      summary: 'Lista grupos com contagens (alunos, produtos, pedidos, requisições)',
      security: [{ adminToken: [] }],
    },
  }, async () => {
    const groups = await prisma.group.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        students: { select: { rm: true, name: true } },
        _count: { select: { products: true, orders: true, customers: true, logs: true } },
      },
    });
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      apiKeyPrefix: g.apiKeyPrefix,
      active: g.active,
      createdAt: g.createdAt.toISOString(),
      students: g.students,
      counts: {
        alunos: g.students.length,
        produtos: g._count.products,
        pedidos: g._count.orders,
        clientes: g._count.customers,
        requisicoes: g._count.logs,
      },
    }));
  });

  // ------------------------------------------------------------- ROTACIONAR CHAVE
  app.post('/admin/groups/:id/rotate-key', {
    preHandler: app.requirePermission('groups:write'),
    schema: {
      tags: ['Admin'],
      summary: 'Gera uma nova API key para o grupo (invalida a anterior)',
      security: [{ adminToken: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) throw notFound('Grupo não encontrado.');

    const { key, hash, prefix } = generateApiKey();
    await prisma.group.update({ where: { id }, data: { apiKeyHash: hash, apiKeyPrefix: prefix } });
    await recordAudit(request.operator!, 'group.key_rotated', { targetType: 'group', targetId: id });
    return { id, apiKey: key };
  });

  // ------------------------------------------------------------- ATIVAR/DESATIVAR
  app.patch('/admin/groups/:id', {
    preHandler: app.requirePermission('groups:write'),
    schema: {
      tags: ['Admin'],
      summary: 'Ativa ou desativa um grupo',
      security: [{ adminToken: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object', required: ['active'], properties: { active: { type: 'boolean' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { active } = request.body as { active: boolean };
    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) throw notFound('Grupo não encontrado.');
    await prisma.group.update({ where: { id }, data: { active } });
    await recordAudit(request.operator!, active ? 'group.activated' : 'group.deactivated', { targetType: 'group', targetId: id });
    return { id, active };
  });

  // ------------------------------------------------------------- ADD ALUNOS
  app.post('/admin/groups/:id/students', {
    preHandler: app.requirePermission('groups:write'),
    schema: {
      tags: ['Admin'],
      summary: 'Adiciona alunos (RM) a um grupo',
      security: [{ adminToken: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['students'],
        properties: {
          students: {
            type: 'array',
            items: {
              type: 'object',
              required: ['rm', 'name'],
              properties: { rm: { type: 'string' }, name: { type: 'string' } },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { students } = request.body as { students: { rm: string; name: string }[] };
    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) throw notFound('Grupo não encontrado.');

    const nameByRm = new Map<string, string>();
    for (const s of students) { const rm = s.rm.trim(); if (rm) nameByRm.set(rm, s.name.trim()); }
    const rms = [...nameByRm.keys()];

    const existing = await prisma.student.findMany({ where: { rm: { in: rms } }, select: { rm: true, groupId: true } });
    const inOther = existing.filter((e) => e.groupId && e.groupId !== id).map((e) => e.rm);
    if (inOther.length) throw conflict(`RM(s) já em outro grupo: ${inOther.join(', ')}.`);

    const existingRms = new Set(existing.map((e) => e.rm));
    // Alunos importados sem grupo → VINCULA a este grupo (preserva o nome do roster).
    const toLink = existing.filter((e) => e.groupId === null).map((e) => e.rm);
    // RMs ainda inexistentes → cria já no grupo.
    const toCreate = rms.filter((rm) => !existingRms.has(rm)).map((rm) => ({ rm, name: nameByRm.get(rm)!, groupId: id }));

    if (toLink.length) await prisma.student.updateMany({ where: { rm: { in: toLink } }, data: { groupId: id } });
    if (toCreate.length) await prisma.student.createMany({ data: toCreate });
    return { added: toLink.length + toCreate.length };
  });

  // ------------------------------------------------------------- LOGS DE ATIVIDADE
  app.get('/admin/logs', {
    preHandler: app.requirePermission('logs:read'),
    schema: {
      tags: ['Admin'],
      summary: 'Consulta o log bruto de requisições (com filtros)',
      security: [{ adminToken: [] }],
      querystring: {
        type: 'object',
        properties: {
          groupId: { type: 'string' },
          rm: { type: 'string' },
          path: { type: 'string' },
          since: { type: 'string', description: 'ISO date. Ex.: 2026-08-01' },
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async (request) => {
    const q = request.query as {
      groupId?: string; rm?: string; path?: string; since?: string;
      page: number; pageSize: number;
    };
    const where = {
      ...(q.groupId ? { groupId: q.groupId } : {}),
      ...(q.rm ? { rm: q.rm } : {}),
      ...(q.path ? { path: { contains: q.path } } : {}),
      ...(q.since ? { createdAt: { gte: new Date(q.since) } } : {}),
    };
    const [total, logs] = await Promise.all([
      prisma.requestLog.count({ where }),
      prisma.requestLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { group: { select: { name: true } } },
      }),
    ]);
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      data: logs.map((l) => ({
        createdAt: l.createdAt.toISOString(),
        group: l.group?.name ?? null,
        groupId: l.groupId,
        rm: l.rm,
        method: l.method,
        path: l.path,
        statusCode: l.statusCode,
        latencyMs: l.latencyMs,
        ip: l.ip,
      })),
    };
  });

  // ------------------------------------------------- PARTICIPAÇÃO (quem trabalhou)
  app.get('/admin/activity', {
    preHandler: app.requirePermission('activity:read'),
    schema: {
      tags: ['Admin'],
      summary: 'Resumo de participação: requisições por grupo e por RM',
      description:
        'A visão-chave de controle: quantas chamadas cada grupo e cada aluno (RM) fez, ' +
        'com a data da última atividade. Ajuda a ver quem realmente integrou.',
      security: [{ adminToken: [] }],
      querystring: {
        type: 'object',
        properties: { since: { type: 'string', description: 'ISO date opcional' } },
      },
    },
  }, async (request) => {
    const { since } = request.query as { since?: string };
    const dateFilter = since ? { createdAt: { gte: new Date(since) } } : {};

    // Agregado por grupo.
    const byGroupRaw = await prisma.requestLog.groupBy({
      by: ['groupId'],
      where: { groupId: { not: null }, ...dateFilter },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const groups = await prisma.group.findMany({ select: { id: true, name: true } });
    const groupName = new Map(groups.map((g) => [g.id, g.name]));

    // Agregado por RM.
    const byRmRaw = await prisma.requestLog.groupBy({
      by: ['rm', 'groupId'],
      where: { rm: { not: null }, ...dateFilter },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const students = await prisma.student.findMany({ select: { rm: true, name: true } });
    const studentName = new Map(students.map((s) => [s.rm, s.name]));

    return {
      porGrupo: byGroupRaw
        .map((r) => ({
          groupId: r.groupId,
          grupo: groupName.get(r.groupId!) ?? '(desconhecido)',
          requisicoes: r._count._all,
          ultimaAtividade: r._max.createdAt?.toISOString() ?? null,
        }))
        .sort((a, b) => b.requisicoes - a.requisicoes),
      porAluno: byRmRaw
        .map((r) => ({
          rm: r.rm,
          nome: studentName.get(r.rm!) ?? '(RM não cadastrado)',
          grupo: r.groupId ? groupName.get(r.groupId) ?? null : null,
          requisicoes: r._count._all,
          ultimaAtividade: r._max.createdAt?.toISOString() ?? null,
        }))
        .sort((a, b) => b.requisicoes - a.requisicoes),
    };
  });
}
