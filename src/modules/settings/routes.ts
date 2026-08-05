import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { generateApiKey } from '../../lib/apiKey.js';
import { recordAudit } from '../admin/rbac.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { normalizeRm } from '../../lib/rm.js';

const sec = [{ apiKey: [], studentRm: [] }];

// Campos da configuração da loja (regional + identidade/contato/tema/fiscal).
const CONFIG_SELECT = {
  locale: true, currency: true, timezone: true,
  storeName: true, storeDescription: true, logoUrl: true,
  supportEmail: true, whatsapp: true, instagram: true,
  primaryColor: true, address: true, cnpj: true,
} as const;

const CONFIG_BODY_PROPS = {
  locale: { type: 'string' }, currency: { type: 'string' }, timezone: { type: 'string' },
  storeName: { type: 'string', nullable: true }, storeDescription: { type: 'string', nullable: true }, logoUrl: { type: 'string', nullable: true },
  supportEmail: { type: 'string', nullable: true }, whatsapp: { type: 'string', nullable: true }, instagram: { type: 'string', nullable: true },
  primaryColor: { type: 'string', nullable: true }, address: { type: 'string', nullable: true }, cnpj: { type: 'string', nullable: true },
} as const;

const CONFIG_KEYS = Object.keys(CONFIG_SELECT) as (keyof typeof CONFIG_SELECT)[];

export async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  // ------------------------------------------------------------- CHAVES DE API
  // O grupo cria N chaves NOMEADAS (estilo Shopify) para autenticar seus apps
  // no header X-API-Key. A chave em texto aparece UMA vez (na criação); depois
  // só o prefixo é visível. Revogar não apaga o registro (mantém o histórico).
  app.get('/store/api-keys', {
    schema: { tags: ['Configurações'], summary: 'Lista as chaves de API do grupo (só o prefixo é visível)', security: sec },
  }, async (req) => {
    const groupId = req.group!.id;
    const [group, keys] = await Promise.all([
      prisma.group.findUnique({ where: { id: groupId }, select: { apiKeyPrefix: true, apiKeyLastUsedAt: true, createdAt: true } }),
      prisma.apiKey.findMany({
        where: { groupId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, keyPrefix: true, lastUsedAt: true, revokedAt: true, createdAt: true, createdByRm: true },
      }),
    ]);
    const named = keys.map((k) => ({
      id: k.id, name: k.name, prefix: k.keyPrefix,
      revoked: k.revokedAt !== null,
      createdByRm: k.createdByRm,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
      isPrimary: false,
    }));
    // A chave "principal" é gerada junto com a loja e mora no próprio Group
    // (apiKeyHash/apiKeyPrefix), NÃO na tabela ApiKey — por isso não aparecia
    // nesta lista. Incluímos como entrada sintética (id fixo "primary",
    // não revogável) para o aluno enxergar a chave que recebeu na criação.
    const primary = group?.apiKeyPrefix
      ? [{
          id: 'primary', name: 'Chave principal da loja', prefix: group.apiKeyPrefix,
          revoked: false, createdByRm: null,
          lastUsedAt: group.apiKeyLastUsedAt?.toISOString() ?? null,
          createdAt: group.createdAt.toISOString(), isPrimary: true,
        }]
      : [];
    return [...primary, ...named];
  });

  app.post('/store/api-keys', {
    schema: {
      tags: ['Configurações'],
      summary: 'Cria uma nova API key nomeada. A chave em texto aparece só uma vez.',
      security: sec,
      body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 60 } } },
      response: { 201: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, prefix: { type: 'string' }, apiKey: { type: 'string' } } } },
    },
  }, async (req, reply) => {
    const groupId = req.group!.id;
    const { name } = req.body as { name: string };
    const { key, hash, prefix } = generateApiKey();
    const created = await prisma.apiKey.create({
      data: { groupId, name: name.trim(), keyHash: hash, keyPrefix: prefix, createdByRm: req.rm ?? null },
      select: { id: true, name: true, keyPrefix: true },
    });
    await recordAudit(req.operator ?? { id: null, email: null, role: 'ADMIN', isMaster: false }, 'apikey.created', { targetType: 'apiKey', targetId: created.id, groupId, meta: { name, rm: req.rm } });
    return reply.code(201).send({ id: created.id, name: created.name, prefix: created.keyPrefix, apiKey: key });
  });

  app.delete('/store/api-keys/:id', {
    schema: {
      tags: ['Configurações'], summary: 'Revoga uma API key (deixa de autenticar imediatamente)', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    const groupId = req.group!.id;
    const id = (req.params as any).id;
    // "primary" é a chave da loja (entrada sintética em GET) — não vive na tabela ApiKey.
    if (id === 'primary') throw badRequest('A chave principal da loja não pode ser revogada aqui. Crie chaves nomeadas para poder revogar quando quiser.');
    const key = await prisma.apiKey.findFirst({ where: tenantScope(groupId, { id }), select: { id: true, revokedAt: true } });
    if (!key) throw notFound('Chave não encontrada.');
    if (!key.revokedAt) {
      await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
      await recordAudit(req.operator ?? { id: null, email: null, role: 'ADMIN', isMaster: false }, 'apikey.revoked', { targetType: 'apiKey', targetId: id, groupId, meta: { rm: req.rm } });
    }
    return { id, revoked: true };
  });

  // ------------------------------------------------------ CONFIGURAÇÃO DA LOJA
  app.get('/store/settings', { schema: { tags: ['Configurações'], summary: 'Configuração da loja (regional + identidade/contato/tema/fiscal)', security: sec } },
    async (req) => {
      const groupId = req.group!.id;
      return prisma.groupConfig.upsert({ where: { groupId }, create: { groupId }, update: {}, select: CONFIG_SELECT });
    });

  app.put('/store/settings', {
    schema: {
      tags: ['Configurações'], summary: 'Atualiza a configuração da loja', security: sec,
      body: { type: 'object', additionalProperties: false, properties: CONFIG_BODY_PROPS },
    },
  }, async (req) => {
    const groupId = req.group!.id;
    const b = req.body as Record<string, string | null | undefined>;
    // Só grava os campos enviados; strings vazias viram null (campo "apagado").
    const data: Record<string, string | null> = {};
    for (const key of CONFIG_KEYS) {
      if (b[key] === undefined) continue;
      const v = b[key];
      data[key] = typeof v === 'string' && v.trim() === '' ? null : v ?? null;
    }
    return prisma.groupConfig.upsert({
      where: { groupId },
      create: { groupId, ...data },
      update: data,
      select: CONFIG_SELECT,
    });
  });

  // --------------------------------------------------------- MEMBROS DO GRUPO
  // Os alunos linkam colegas por RM para compor o grupo (facilita a avaliação).
  app.get('/store/members', { schema: { tags: ['Configurações'], summary: 'Lista os alunos (RM) do grupo', security: sec } },
    async (req) => {
      const students = await prisma.student.findMany({
        where: tenantScope(req.group!.id),
        orderBy: { createdAt: 'asc' },
        select: { rm: true, name: true, passwordHash: true, createdAt: true },
      });
      return students.map((s) => ({
        rm: s.rm, name: s.name,
        jaAcessou: s.passwordHash !== null,
        isYou: s.rm === req.rm,
        addedAt: s.createdAt.toISOString(),
      }));
    });

  app.post('/store/members', {
    schema: {
      tags: ['Configurações'], summary: 'Adiciona um aluno (RM) ao grupo', security: sec,
      body: { type: 'object', required: ['rm', 'name'], properties: { rm: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 } } },
      response: { 201: { type: 'object', properties: { rm: { type: 'string' }, name: { type: 'string' } } } },
    },
  }, async (req, reply) => {
    const groupId = req.group!.id;
    const rm = normalizeRm((req.body as any).rm);
    const name = (req.body as any).name.trim();
    const existing = await prisma.student.findUnique({ where: { rm }, select: { id: true, groupId: true } });
    if (existing) {
      if (existing.groupId === groupId) throw conflict(`RM ${rm} já está neste grupo.`);
      if (existing.groupId) throw conflict(`RM ${rm} já pertence a outro grupo. Fale com o professor.`);
      // Aluno importado (sem grupo) → VINCULA a esta loja, preservando o nome do roster.
      const linked = await prisma.student.update({ where: { id: existing.id }, data: { groupId }, select: { rm: true, name: true } });
      await recordAudit(req.operator ?? { id: null, email: null, role: 'ADMIN', isMaster: false }, 'member.linked', { targetType: 'student', targetId: rm, groupId, meta: { byRm: req.rm } });
      return reply.code(201).send(linked);
    }
    // RM ainda não existe na turma → cria já dentro do grupo.
    const created = await prisma.student.create({ data: { rm, name, groupId }, select: { rm: true, name: true } });
    await recordAudit(req.operator ?? { id: null, email: null, role: 'ADMIN', isMaster: false }, 'member.added', { targetType: 'student', targetId: rm, groupId, meta: { name, byRm: req.rm } });
    return reply.code(201).send(created);
  });

  app.delete('/store/members/:rm', {
    schema: {
      tags: ['Configurações'], summary: 'Remove um aluno do grupo (não pode remover a si mesmo)', security: sec,
      params: { type: 'object', required: ['rm'], properties: { rm: { type: 'string' } } },
    },
  }, async (req) => {
    const groupId = req.group!.id;
    const rm = normalizeRm((req.params as any).rm);
    if (rm === req.rm) throw badRequest('Você não pode remover a si mesmo do grupo.');
    const student = await prisma.student.findFirst({ where: tenantScope(groupId, { rm }), select: { id: true } });
    if (!student) throw notFound('Aluno não encontrado neste grupo.');
    const total = await prisma.student.count({ where: tenantScope(groupId) });
    if (total <= 1) throw badRequest('O grupo precisa ter ao menos um aluno.');
    // Desvincula (mantém o login do aluno, que pode entrar/criar outra loja).
    await prisma.student.update({ where: { id: student.id }, data: { groupId: null } });
    await recordAudit(req.operator ?? { id: null, email: null, role: 'ADMIN', isMaster: false }, 'member.removed', { targetType: 'student', targetId: rm, groupId, meta: { byRm: req.rm } });
    return { rm, removed: true };
  });

  // ---------------------------------------------------------- LGPD: EXPORTAR
  app.get('/store/customers/:id/export', {
    schema: { tags: ['Configurações'], summary: '[LGPD] Exporta todos os dados de um cliente', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const groupId = req.group!.id;
    const id = (req.params as any).id;
    const customer = await prisma.customer.findFirst({
      where: tenantScope(groupId, { id }),
      select: {
        id: true, name: true, email: true, document: true, createdAt: true,
        addresses: true, favorites: true,
        orders: { select: { id: true, status: true, total: true, createdAt: true, items: true } },
        carts: { select: { id: true, status: true, items: true } },
      },
    });
    if (!customer) throw notFound('Cliente não encontrado.');
    return { exportedAt: new Date().toISOString(), customer };
  });

  // ---------------------------------------------------------- LGPD: APAGAR/ANONIMIZAR
  app.delete('/store/customers/:id', {
    schema: { tags: ['Configurações'], summary: '[LGPD] Anonimiza um cliente (mantém pedidos p/ integridade)', security: sec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const groupId = req.group!.id;
    const id = (req.params as any).id;
    const customer = await prisma.customer.findFirst({ where: tenantScope(groupId, { id }), select: { id: true } });
    if (!customer) throw notFound('Cliente não encontrado.');

    await prisma.$transaction(async (tx) => {
      // Remove PII e dados pessoais; PEDIDOS permanecem (anonimizados) por integridade contábil.
      await tx.address.deleteMany({ where: { customerId: id } });
      await tx.favorite.deleteMany({ where: { customerId: id } });
      await tx.customerSegmentMember.deleteMany({ where: { customerId: id } });
      await tx.cart.deleteMany({ where: { customerId: id } });
      await tx.customer.update({
        where: { id },
        data: { name: '[removido]', email: `anon+${id}@anonimo.local`, document: null, passwordHash: randomBytes(24).toString('hex') },
      });
    });
    await recordAudit(req.operator ?? { id: null, email: null, role: 'ADMIN', isMaster: false }, 'lgpd.customer_anonymized', { targetType: 'customer', targetId: id, groupId });
    return { anonymized: true, customerId: id };
  });
}
