import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../../prisma.js';
import { hashPassword, verifyPassword, signStudentToken, verifyStudentToken } from '../../lib/security.js';
import { badRequest, conflict, forbidden, unauthorized } from '../../lib/errors.js';
import { generateApiKey } from '../../lib/apiKey.js';

const studentSchema = {
  type: 'object',
  // groupId/group podem ser null: aluno importado ainda sem loja.
  properties: { rm: { type: 'string' }, name: { type: 'string' }, groupId: { type: ['string', 'null'] }, group: { type: ['string', 'null'] }, mustChangePassword: { type: 'boolean' } },
};

/** Senha válida? 1º acesso (sem hash) → senha == RM. Senão, compara o hash. */
async function checkPassword(student: { rm: string; passwordHash: string | null }, password: string): Promise<boolean> {
  if (student.passwordHash) return verifyPassword(password, student.passwordHash);
  return password === student.rm;
}

function readToken(request: FastifyRequest) {
  const h = request.headers['authorization'];
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) throw unauthorized('Sessão ausente.');
  try {
    return verifyStudentToken(h.slice(7));
  } catch {
    throw unauthorized('Sessão inválida ou expirada.');
  }
}

/** Autenticação do ALUNO no admin web (login = RM; senha inicial = RM, troca forçada). */
export async function storeAuthRoutes(app: FastifyInstance) {
  app.post('/store/auth/login', {
    schema: {
      tags: ['Loja (aluno)'], summary: 'Login do aluno (login = RM; senha inicial = RM)',
      body: { type: 'object', required: ['rm', 'password'], properties: { rm: { type: 'string' }, password: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { token: { type: 'string' }, student: studentSchema, mustChangePassword: { type: 'boolean' } } } },
    },
  }, async (req) => {
    const { rm, password } = req.body as { rm: string; password: string };
    const student = await prisma.student.findUnique({ where: { rm }, include: { group: { select: { name: true, active: true } } } });
    if (!student) throw unauthorized('RM ou senha inválidos.');
    // Aluno pode não ter grupo ainda (só login). Só bloqueia se tiver grupo desativado.
    if (student.group && !student.group.active) throw forbidden('Grupo desativado. Fale com o professor.');
    if (!(await checkPassword(student, password))) throw unauthorized('RM ou senha inválidos.');

    const token = signStudentToken({ sub: student.id, rm: student.rm, groupId: student.groupId });
    return { token, student: { rm: student.rm, name: student.name, groupId: student.groupId, group: student.group?.name ?? null, mustChangePassword: student.mustChangePassword }, mustChangePassword: student.mustChangePassword };
  });

  app.get('/store/auth/me', {
    schema: { tags: ['Loja (aluno)'], summary: 'Dados do aluno logado', security: [{ studentToken: [] }], response: { 200: studentSchema } },
  }, async (req) => {
    const payload = readToken(req);
    const student = await prisma.student.findUnique({ where: { id: payload.sub }, include: { group: { select: { name: true } } } });
    if (!student) throw unauthorized('Aluno não encontrado.');
    return { rm: student.rm, name: student.name, groupId: student.groupId, group: student.group?.name ?? null, mustChangePassword: student.mustChangePassword };
  });

  app.post('/store/auth/change-password', {
    schema: {
      tags: ['Loja (aluno)'], summary: 'Troca a senha (obrigatória no 1º acesso)', security: [{ studentToken: [] }],
      body: { type: 'object', required: ['currentPassword', 'newPassword'], properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string', minLength: 6 } } },
    },
  }, async (req) => {
    const payload = readToken(req);
    const student = await prisma.student.findUnique({ where: { id: payload.sub } });
    if (!student) throw unauthorized('Aluno não encontrado.');
    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
    if (!(await checkPassword(student, currentPassword))) throw unauthorized('Senha atual incorreta.');
    if (newPassword === student.rm) throw badRequest('A nova senha não pode ser o RM.');

    await prisma.student.update({ where: { id: student.id }, data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false } });
    return { ok: true };
  });

  // Aluno logado (ainda SEM grupo) cria a PRÓPRIA loja e vira o 1º membro. Gera a
  // API key (mostrada UMA vez) e devolve um TOKEN novo já com o groupId — o painel
  // troca o token antigo por este e passa a ter acesso à loja.
  app.post('/store/groups', {
    schema: {
      tags: ['Loja (aluno)'], summary: 'Cria a loja do aluno (grupo) e gera a API key', security: [{ studentToken: [] }],
      body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } } },
      response: { 201: { type: 'object', properties: { token: { type: 'string' }, groupId: { type: 'string' }, name: { type: 'string' }, apiKey: { type: 'string', description: 'GUARDE AGORA. Não será mostrada de novo.' } } } },
    },
  }, async (req, reply) => {
    const payload = readToken(req);
    const student = await prisma.student.findUnique({ where: { id: payload.sub }, select: { id: true, rm: true, groupId: true } });
    if (!student) throw unauthorized('Aluno não encontrado.');
    if (student.groupId) throw conflict('Você já pertence a uma loja.');

    const name = (req.body as { name: string }).name.trim();
    if (!name) throw badRequest('Informe um nome para a loja.');

    const { key, hash, prefix } = generateApiKey();
    const group = await prisma.group.create({ data: { name, apiKeyHash: hash, apiKeyPrefix: prefix } });
    await prisma.student.update({ where: { id: student.id }, data: { groupId: group.id } });

    // Token novo com o grupo (o antigo tinha groupId null).
    const token = signStudentToken({ sub: student.id, rm: student.rm, groupId: group.id });
    return reply.code(201).send({ token, groupId: group.id, name: group.name, apiKey: key });
  });
}
