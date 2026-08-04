import type { FastifyInstance } from 'fastify';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { money } from '../../lib/serialize.js';
import { variantLabel } from '../catalog/serialize.js';
import { notFound, unprocessable } from '../../lib/errors.js';

const cartSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          variantId: { type: 'string' },
          name: { type: 'string' },
          sku: { type: 'string' },
          unitPrice: { type: 'number' },
          quantity: { type: 'integer' },
          subtotal: { type: 'number' },
        },
      },
    },
    total: { type: 'number' },
    itemCount: { type: 'integer' },
  },
};

async function getOrCreateActiveCart(groupId: string, customerId: string) {
  const existing = await prisma.cart.findFirst({ where: { customerId, status: 'ACTIVE' } });
  // Toda interação com o carrinho conta como atividade (reseta o timer de abandono).
  if (existing) return prisma.cart.update({ where: { id: existing.id }, data: { lastActivityAt: new Date() } });
  return prisma.cart.create({ data: { groupId, customerId, status: 'ACTIVE' } });
}

async function serializeCart(cartId: string) {
  const cart = await prisma.cart.findUniqueOrThrow({
    where: { id: cartId },
    include: {
      items: {
        orderBy: { id: 'asc' },
        include: {
          variant: {
            include: {
              product: { select: { name: true } },
              optionValues: { include: { option: true, optionValue: true } },
            },
          },
        },
      },
    },
  });

  const items = cart.items.map((it) => {
    const unitPrice = money(it.unitPrice);
    const label = variantLabel(it.variant);
    return {
      variantId: it.variantId,
      name: it.variant.product.name + (label ? ` (${label})` : ''),
      sku: it.variant.sku,
      unitPrice,
      quantity: it.quantity,
      subtotal: Number((unitPrice * it.quantity).toFixed(2)),
    };
  });

  return {
    id: cart.id,
    items,
    total: Number(items.reduce((s, i) => s + i.subtotal, 0).toFixed(2)),
    itemCount: items.reduce((s, i) => s + i.quantity, 0),
  };
}

export async function cartRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);
  app.addHook('preHandler', app.requireCustomer);

  app.get('/cart', {
    schema: { tags: ['Carrinho'], summary: 'Retorna o carrinho ativo', security: [{ apiKey: [], customerToken: [] }], response: { 200: cartSchema } },
  }, async (req) => {
    const cart = await getOrCreateActiveCart(req.group!.id, req.customer!.id);
    return serializeCart(cart.id);
  });

  app.post('/cart/items', {
    schema: {
      tags: ['Carrinho'], summary: 'Adiciona uma variante ao carrinho', security: [{ apiKey: [], customerToken: [] }],
      body: { type: 'object', required: ['variantId', 'quantity'], properties: { variantId: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } } },
      response: { 200: cartSchema },
    },
  }, async (req) => {
    const groupId = req.group!.id;
    const { variantId, quantity } = req.body as { variantId: string; quantity: number };

    const variant = await prisma.productVariant.findFirst({ where: tenantScope(groupId, { id: variantId }) });
    if (!variant) throw notFound('Variante não encontrada neste grupo.');
    if (!variant.active) throw unprocessable('Variante inativa.');

    const cart = await getOrCreateActiveCart(groupId, req.customer!.id);
    const current = await prisma.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId } } });
    const desired = (current?.quantity ?? 0) + quantity;
    if (desired > variant.stock) throw unprocessable(`Estoque insuficiente. Disponível: ${variant.stock}.`);

    await prisma.cartItem.upsert({
      where: { cartId_variantId: { cartId: cart.id, variantId } },
      create: { cartId: cart.id, variantId, quantity, unitPrice: variant.price },
      update: { quantity: desired, unitPrice: variant.price },
    });
    return serializeCart(cart.id);
  });

  app.patch('/cart/items/:variantId', {
    schema: {
      tags: ['Carrinho'], summary: 'Altera a quantidade de um item', security: [{ apiKey: [], customerToken: [] }],
      params: { type: 'object', required: ['variantId'], properties: { variantId: { type: 'string' } } },
      body: { type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer', minimum: 0 } } },
      response: { 200: cartSchema },
    },
  }, async (req) => {
    const groupId = req.group!.id;
    const { variantId } = req.params as { variantId: string };
    const { quantity } = req.body as { quantity: number };

    const cart = await getOrCreateActiveCart(groupId, req.customer!.id);
    const item = await prisma.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId } } });
    if (!item) throw notFound('Item não está no carrinho.');

    if (quantity === 0) {
      await prisma.cartItem.delete({ where: { id: item.id } });
    } else {
      const variant = await prisma.productVariant.findFirst({ where: tenantScope(groupId, { id: variantId }) });
      if (!variant) throw notFound('Variante não encontrada.');
      if (quantity > variant.stock) throw unprocessable(`Estoque insuficiente. Disponível: ${variant.stock}.`);
      await prisma.cartItem.update({ where: { id: item.id }, data: { quantity } });
    }
    return serializeCart(cart.id);
  });

  app.delete('/cart/items/:variantId', {
    schema: { tags: ['Carrinho'], summary: 'Remove um item', security: [{ apiKey: [], customerToken: [] }],
      params: { type: 'object', required: ['variantId'], properties: { variantId: { type: 'string' } } }, response: { 200: cartSchema } },
  }, async (req) => {
    const cart = await getOrCreateActiveCart(req.group!.id, req.customer!.id);
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id, variantId: (req.params as any).variantId } });
    return serializeCart(cart.id);
  });

  app.delete('/cart', {
    schema: { tags: ['Carrinho'], summary: 'Esvazia o carrinho', security: [{ apiKey: [], customerToken: [] }], response: { 200: cartSchema } },
  }, async (req) => {
    const cart = await getOrCreateActiveCart(req.group!.id, req.customer!.id);
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    return serializeCart(cart.id);
  });
}
