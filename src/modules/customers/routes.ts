import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../prisma.js';
import { parseCoords } from '../../lib/geo.js';
import { hashPassword, verifyPassword, signCustomerToken } from '../../lib/security.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { isValidDocument, normalizeDocument } from '../../lib/document.js';
import { badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js';

const customerSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    email: { type: 'string' },
  },
};

/** Endereço com o ponto no formato que o mapa do app consome. */
function serializeAddress(a: {
  id: string; type: string; isDefault: boolean; recipientName: string | null;
  cep: string; street: string; number: string; complement: string | null;
  district: string | null; city: string; state: string;
  latitude: number | null; longitude: number | null; createdAt: Date;
}) {
  return {
    id: a.id, type: a.type, isDefault: a.isDefault, recipientName: a.recipientName,
    cep: a.cep, street: a.street, number: a.number, complement: a.complement,
    district: a.district, city: a.city, state: a.state,
    coordinate: a.latitude !== null && a.longitude !== null
      ? { latitude: a.latitude, longitude: a.longitude }
      : null,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function customerRoutes(app: FastifyInstance) {
  // Exigem a API key do grupo (o cadastro/login acontece DENTRO de um grupo).
  app.addHook('preHandler', app.requireGroup);

  app.post('/auth/register', {
    schema: {
      tags: ['Auth Cliente'],
      summary: 'Cadastra um cliente final e já retorna o token',
      security: [{ apiKey: [], studentRm: [] }],
      body: {
        type: 'object',
        required: ['name', 'email', 'password'],
        properties: {
          name: { type: 'string', minLength: 1 },
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 6 },
          document: { type: 'string', description: 'CPF ou CNPJ (opcional, validado)' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: { token: { type: 'string' }, customer: customerSchema },
        },
      },
    },
  }, async (request, reply) => {
    const groupId = request.group!.id;
    const { name, email, password, document } = request.body as {
      name: string; email: string; password: string; document?: string;
    };

    if (document && !isValidDocument(document)) throw badRequest('CPF/CNPJ inválido.');

    const exists = await prisma.customer.findUnique({
      where: { groupId_email: { groupId, email } },
    });
    if (exists) throw conflict('Já existe um cliente com este e-mail neste grupo.');

    const customer = await prisma.customer.create({
      data: { groupId, name, email, passwordHash: await hashPassword(password), document: document ? normalizeDocument(document) : null },
      select: { id: true, name: true, email: true },
    });

    const token = signCustomerToken({ sub: customer.id, groupId, email });
    return reply.code(201).send({ token, customer });
  });

  app.post('/auth/login', {
    schema: {
      tags: ['Auth Cliente'],
      summary: 'Login do cliente final',
      security: [{ apiKey: [], studentRm: [] }],
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { token: { type: 'string' }, customer: customerSchema },
        },
      },
    },
  }, async (request) => {
    const groupId = request.group!.id;
    const { email, password } = request.body as { email: string; password: string };

    const customer = await prisma.customer.findUnique({
      where: { groupId_email: { groupId, email } },
    });
    if (!customer || !(await verifyPassword(password, customer.passwordHash))) {
      throw unauthorized('E-mail ou senha inválidos.');
    }

    const token = signCustomerToken({ sub: customer.id, groupId, email });
    return {
      token,
      customer: { id: customer.id, name: customer.name, email: customer.email },
    };
  });

  // ---- Esqueci a senha: pede um código (cai no mock de e-mails) --------------
  app.post('/auth/forgot-password', {
    schema: {
      tags: ['Auth Cliente'],
      summary: 'Solicita um código de redefinição de senha (cai no mock de e-mails)',
      security: [{ apiKey: [], studentRm: [] }],
      body: {
        type: 'object',
        required: ['email'],
        properties: { email: { type: 'string', format: 'email' } },
      },
      response: { 200: { type: 'object', properties: { message: { type: 'string' } } } },
    },
  }, async (request) => {
    const groupId = request.group!.id;
    const { email } = request.body as { email: string };

    const customer = await prisma.customer.findUnique({ where: { groupId_email: { groupId, email } } });
    // Anti-enumeração: a resposta é sempre a mesma, exista o e-mail ou não.
    if (customer) {
      const code = String(randomInt(100000, 1000000)); // 6 dígitos
      const codeHash = await hashPassword(code);
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

      // Invalida qualquer código anterior não usado deste cliente.
      await prisma.passwordReset.updateMany({
        where: { customerId: customer.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await prisma.passwordReset.create({ data: { customerId: customer.id, codeHash, expiresAt } });

      // O código em texto vai só no "e-mail" (mock). No banco fica só o hash.
      await prisma.emailOutbox.create({
        data: {
          groupId,
          to: customer.email,
          template: 'password_reset',
          payload: { name: customer.name, code, expiresInMinutes: 30 },
        },
      });
    }

    return { message: 'Se o e-mail existir, enviamos um código de redefinição.' };
  });

  // ---- Redefine a senha com o código -----------------------------------------
  app.post('/auth/reset-password', {
    schema: {
      tags: ['Auth Cliente'],
      summary: 'Redefine a senha com o código recebido por e-mail',
      security: [{ apiKey: [], studentRm: [] }],
      body: {
        type: 'object',
        required: ['email', 'code', 'newPassword'],
        properties: {
          email: { type: 'string', format: 'email' },
          code: { type: 'string', minLength: 4 },
          newPassword: { type: 'string', minLength: 6 },
        },
      },
      response: { 200: { type: 'object', properties: { token: { type: 'string' }, customer: customerSchema } } },
    },
  }, async (request) => {
    const groupId = request.group!.id;
    const { email, code, newPassword } = request.body as { email: string; code: string; newPassword: string };

    const customer = await prisma.customer.findUnique({ where: { groupId_email: { groupId, email } } });
    if (!customer) throw unauthorized('Código inválido ou expirado.');

    const reset = await prisma.passwordReset.findFirst({
      where: { customerId: customer.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!reset || !(await verifyPassword(code, reset.codeHash))) {
      throw unauthorized('Código inválido ou expirado.');
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction([
      prisma.customer.update({ where: { id: customer.id }, data: { passwordHash } }),
      prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
    ]);

    // Já devolve um token (login automático após redefinir).
    const token = signCustomerToken({ sub: customer.id, groupId, email });
    return { token, customer: { id: customer.id, name: customer.name, email: customer.email } };
  });

  app.get('/auth/me', {
    schema: {
      tags: ['Auth Cliente'],
      summary: 'Dados do cliente logado',
      security: [{ apiKey: [], customerToken: [] }],
      response: { 200: customerSchema },
    },
    preHandler: app.requireCustomer,
  }, async (request) => {
    return request.customer;
  });

  // =====================================================================
  // ENDEREÇOS (do cliente logado)
  //
  // O endereço pode ter um PONTO no mapa (latitude/longitude), preenchido pelo
  // app via GPS. O `coordinate` na resposta já sai no formato que o
  // react-native-maps consome; null quando o cliente nunca marcou no mapa.
  // =====================================================================
  const custSec = [{ apiKey: [], customerToken: [] }];
  const addressBody = {
    type: 'object', required: ['cep', 'street', 'number', 'city', 'state'],
    properties: {
      type: { type: 'string', enum: ['SHIPPING', 'BILLING'], default: 'SHIPPING' },
      isDefault: { type: 'boolean' }, recipientName: { type: 'string' },
      cep: { type: 'string' }, street: { type: 'string' }, number: { type: 'string' },
      complement: { type: 'string' }, district: { type: 'string' }, city: { type: 'string' }, state: { type: 'string', minLength: 2, maxLength: 2 },
      // Ponto no mapa (f6-locations). Opcional: o app manda quando o cliente
      // usa o GPS ou arrasta o pin; sem isso o endereço vale como sempre valeu.
      latitude: { type: 'number', minimum: -90, maximum: 90, nullable: true },
      longitude: { type: 'number', minimum: -180, maximum: 180, nullable: true },
    },
  };

  app.get('/customers/me/addresses', { schema: { tags: ['Cliente'], summary: 'Lista os endereços', security: custSec }, preHandler: app.requireCustomer },
    async (req) => (await prisma.address.findMany({ where: { customerId: req.customer!.id }, orderBy: { createdAt: 'asc' } })).map(serializeAddress));

  // Atualiza o endereço — na prática, o que o app mais manda aqui é a
  // coordenada, depois que o cliente arrasta o pin no mapa.
  app.patch('/customers/me/addresses/:id', {
    schema: {
      tags: ['Cliente'], summary: 'Atualiza um endereço (inclusive o ponto no mapa)', security: custSec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', properties: addressBody.properties },
    },
    preHandler: app.requireCustomer,
  }, async (req) => {
    const b = req.body as any;
    const atual = await prisma.address.findFirst({ where: { id: (req.params as any).id, customerId: req.customer!.id }, select: { id: true, type: true } });
    if (!atual) throw notFound('Endereço não encontrado.');
    const coords = parseCoords(b.latitude, b.longitude);
    if (b.isDefault) await prisma.address.updateMany({ where: { customerId: req.customer!.id, type: b.type ?? atual.type }, data: { isDefault: false } });
    const campos = ['type', 'isDefault', 'recipientName', 'cep', 'street', 'number', 'complement', 'district', 'city', 'state'] as const;
    const data: Record<string, unknown> = {};
    for (const c of campos) if (b[c] !== undefined) data[c] = b[c];
    return serializeAddress(await prisma.address.update({ where: { id: atual.id }, data: { ...data, ...(coords ?? {}) } }));
  });

  app.post('/customers/me/addresses', { schema: { tags: ['Cliente'], summary: 'Adiciona um endereço', security: custSec, body: addressBody }, preHandler: app.requireCustomer },
    async (req, reply) => {
      const b = req.body as any;
      if (b.isDefault) await prisma.address.updateMany({ where: { customerId: req.customer!.id, type: b.type ?? 'SHIPPING' }, data: { isDefault: false } });
      const coords = parseCoords(b.latitude, b.longitude);
      const addr = await prisma.address.create({ data: { groupId: req.group!.id, customerId: req.customer!.id, type: b.type ?? 'SHIPPING', isDefault: b.isDefault ?? false, recipientName: b.recipientName, cep: b.cep, street: b.street, number: b.number, complement: b.complement, district: b.district, city: b.city, state: b.state, ...(coords ?? {}) } });
      return reply.code(201).send(serializeAddress(addr));
    });

  app.delete('/customers/me/addresses/:id', { schema: { tags: ['Cliente'], summary: 'Remove um endereço', security: custSec, params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }, preHandler: app.requireCustomer },
    async (req, reply) => {
      const addr = await prisma.address.findFirst({ where: { id: (req.params as any).id, customerId: req.customer!.id }, select: { id: true } });
      if (!addr) throw notFound('Endereço não encontrado.');
      await prisma.address.delete({ where: { id: addr.id } });
      return reply.code(204).send();
    });

  // =====================================================================
  // FAVORITOS / WISHLIST
  // =====================================================================
  app.get('/customers/me/favorites', { schema: { tags: ['Cliente'], summary: 'Lista os favoritos', security: custSec }, preHandler: app.requireCustomer },
    async (req) => {
      const favs = await prisma.favorite.findMany({ where: { customerId: req.customer!.id }, orderBy: { createdAt: 'desc' } });
      const variants = await prisma.productVariant.findMany({ where: tenantScope(req.group!.id, { id: { in: favs.map((f) => f.variantId) } }), include: { product: { select: { name: true } } } });
      const vmap = new Map(variants.map((v) => [v.id, v]));
      return favs.map((f) => ({ variantId: f.variantId, product: vmap.get(f.variantId)?.product.name ?? null, sku: vmap.get(f.variantId)?.sku ?? null, price: vmap.get(f.variantId) ? Number(vmap.get(f.variantId)!.price) : null }));
    });

  app.post('/customers/me/favorites', { schema: { tags: ['Cliente'], summary: 'Adiciona aos favoritos', security: custSec, body: { type: 'object', required: ['variantId'], properties: { variantId: { type: 'string' } } } }, preHandler: app.requireCustomer },
    async (req, reply) => {
      const { variantId } = req.body as { variantId: string };
      const variant = await prisma.productVariant.findFirst({ where: tenantScope(req.group!.id, { id: variantId }), select: { id: true } });
      if (!variant) throw badRequest('Variante não pertence a este grupo.');
      await prisma.favorite.upsert({ where: { customerId_variantId: { customerId: req.customer!.id, variantId } }, create: { groupId: req.group!.id, customerId: req.customer!.id, variantId }, update: {} });
      return reply.code(201).send({ variantId });
    });

  app.delete('/customers/me/favorites/:variantId', { schema: { tags: ['Cliente'], summary: 'Remove dos favoritos', security: custSec, params: { type: 'object', required: ['variantId'], properties: { variantId: { type: 'string' } } } }, preHandler: app.requireCustomer },
    async (req, reply) => {
      await prisma.favorite.deleteMany({ where: { customerId: req.customer!.id, variantId: (req.params as any).variantId } });
      return reply.code(204).send();
    });
}
