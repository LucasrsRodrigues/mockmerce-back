import type { FastifyInstance } from 'fastify';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import {
  canReview, createReview, deleteReview, ratingSummary, reviewInclude,
  serializeReview, serializeReviewForStore, setHidden, updateReview,
} from './service.js';

const sec = [{ apiKey: [], studentRm: [] }];
const secCustomer = [{ apiKey: [], customerToken: [] }];

/** Corpo de uma avaliação na resposta (additionalProperties não filtra campos). */
const reviewResponseSchema = {
  description: 'Avaliação.',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    rating: { type: 'integer' },
    title: { type: 'string', nullable: true },
    comment: { type: 'string' },
    images: { type: 'array', items: { type: 'object', additionalProperties: true } },
    author: { type: 'object', additionalProperties: true },
    verifiedPurchase: { type: 'boolean', description: 'A avaliação está ligada a um pedido pago.' },
    hidden: { type: 'boolean' },
    isMine: { type: 'boolean' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const reviewBodyProps = {
  rating: { type: 'integer', minimum: 1, maximum: 5, description: 'Nota de 1 a 5 estrelas.' },
  title: { type: 'string', maxLength: 120, nullable: true },
  comment: { type: 'string', maxLength: 2000 },
  mediaIds: {
    type: 'array',
    maxItems: 5,
    items: { type: 'string' },
    description: 'Fotos já enviadas em POST /uploads (máx. 5, só imagens).',
  },
} as const;

/**
 * Avaliações de produto (f5-reviews).
 *
 * Duas audiências no mesmo módulo:
 *   - CLIENTE FINAL (Authorization: Bearer) escreve, edita e apaga a própria.
 *   - LOJA (X-API-Key / painel do aluno) lê tudo e oculta o que for abusivo.
 *
 * A leitura da vitrine é pública dentro da loja (só X-API-Key): qualquer
 * visitante vê as avaliações, mesmo sem estar logado.
 */
export async function reviewRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  // =====================================================================
  // VITRINE — leitura (não exige cliente logado)
  // =====================================================================
  app.get('/products/:id/reviews', {
    schema: {
      tags: ['Avaliações'],
      summary: 'Lista as avaliações de um produto (com média e distribuição)',
      security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          rating: { type: 'integer', minimum: 1, maximum: 5, description: 'Filtra por nota.' },
          withPhotos: { type: 'boolean', default: false, description: 'Só avaliações com foto.' },
          sort: { type: 'string', enum: ['recent', 'rating_desc', 'rating_asc'], default: 'recent' },
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
      },
    },
  }, async (req) => {
    const q = req.query as { rating?: number; withPhotos?: boolean; sort: string; page: number; pageSize: number };
    const productId = (req.params as { id: string }).id;
    const groupId = req.group!.id;

    const where = tenantScope(groupId, {
      productId,
      hidden: false, // a vitrine nunca mostra o que a loja ocultou
      ...(q.rating ? { rating: q.rating } : {}),
      ...(q.withPhotos ? { images: { some: {} } } : {}),
    });

    const orderBy = q.sort === 'rating_desc' ? { rating: 'desc' as const }
      : q.sort === 'rating_asc' ? { rating: 'asc' as const }
      : { createdAt: 'desc' as const };

    const [total, rows, summary] = await Promise.all([
      prisma.review.count({ where }),
      prisma.review.findMany({
        where, orderBy, include: reviewInclude,
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      ratingSummary(productId),
    ]);

    return {
      data: rows.map((r) => serializeReview(r, req.customer?.id ?? null)),
      page: q.page, pageSize: q.pageSize, total,
      summary,
    };
  });

  // =====================================================================
  // CLIENTE FINAL — escrever a própria avaliação
  // =====================================================================
  app.get('/products/:id/reviews/can-review', {
    schema: {
      tags: ['Avaliações'],
      summary: 'Diz se o cliente logado pode avaliar este produto',
      description: 'Use na tela para decidir entre mostrar o formulário, um aviso de "compre para avaliar" ou a avaliação que ele já deixou.',
      security: secCustomer,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
    preHandler: app.requireCustomer,
  }, async (req) => canReview(req.group!.id, (req.params as { id: string }).id, req.customer!.id));

  app.post('/products/:id/reviews', {
    schema: {
      tags: ['Avaliações'],
      summary: 'Avalia um produto (só quem comprou)',
      description: 'Exige um pedido pago do cliente com este produto. Uma avaliação por cliente em cada produto.',
      security: secCustomer,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['rating'], properties: reviewBodyProps },
      response: {
        201: reviewResponseSchema,
        403: { description: 'FORBIDDEN — o cliente não comprou este produto.', type: 'object', additionalProperties: true },
        409: { description: 'CONFLICT — o cliente já avaliou este produto.', type: 'object', additionalProperties: true },
      },
    },
    preHandler: app.requireCustomer,
  }, async (req, reply) => {
    const review = await createReview(
      req.group!.id, (req.params as { id: string }).id, req.customer!.id, req.body as any,
    );
    return reply.code(201).send(serializeReview(review, req.customer!.id));
  });

  app.patch('/reviews/:id', {
    schema: {
      tags: ['Avaliações'], summary: 'Edita a própria avaliação', security: secCustomer,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', properties: reviewBodyProps },
    },
    preHandler: app.requireCustomer,
  }, async (req) => {
    const review = await updateReview(
      req.group!.id, (req.params as { id: string }).id, req.customer!.id, req.body as any,
    );
    return serializeReview(review, req.customer!.id);
  });

  app.delete('/reviews/:id', {
    schema: {
      tags: ['Avaliações'], summary: 'Apaga a própria avaliação', security: secCustomer,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
    preHandler: app.requireCustomer,
  }, async (req, reply) => {
    await deleteReview(req.group!.id, (req.params as { id: string }).id, req.customer!.id);
    return reply.code(204).send();
  });

  app.get('/me/reviews', {
    schema: { tags: ['Avaliações'], summary: 'Avaliações que o cliente logado escreveu', security: secCustomer },
    preHandler: app.requireCustomer,
  }, async (req) => {
    const rows = await prisma.review.findMany({
      where: tenantScope(req.group!.id, { customerId: req.customer!.id }),
      orderBy: { createdAt: 'desc' },
      include: { ...reviewInclude, product: { select: { id: true, name: true, slug: true } } },
    });
    return {
      data: rows.map((r) => ({
        ...serializeReview(r, req.customer!.id),
        product: r.product,
      })),
    };
  });

  // =====================================================================
  // LOJA — moderação (painel do aluno)
  // =====================================================================
  app.get('/store/reviews', {
    schema: {
      tags: ['Avaliações'],
      summary: 'Lista as avaliações da loja (inclusive as ocultas)',
      security: sec,
      querystring: {
        type: 'object',
        properties: {
          productId: { type: 'string' },
          rating: { type: 'integer', minimum: 1, maximum: 5 },
          hidden: { type: 'boolean', description: 'true = só ocultas; false = só visíveis; omitido = todas.' },
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
  }, async (req) => {
    const q = req.query as { productId?: string; rating?: number; hidden?: boolean; page: number; pageSize: number };
    const where = tenantScope(req.group!.id, {
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.rating ? { rating: q.rating } : {}),
      ...(q.hidden !== undefined ? { hidden: q.hidden } : {}),
    });
    const [total, rows] = await Promise.all([
      prisma.review.count({ where }),
      prisma.review.findMany({
        where, orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: {
          images: { orderBy: { position: 'asc' } },
          customer: { select: { id: true, name: true, email: true } },
          product: { select: { id: true, name: true } },
        },
      }),
    ]);
    return { data: rows.map(serializeReviewForStore), page: q.page, pageSize: q.pageSize, total };
  });

  app.patch('/store/reviews/:id', {
    schema: {
      tags: ['Avaliações'],
      summary: 'Oculta ou volta a exibir uma avaliação',
      description: 'Ocultar tira da vitrine e da média do produto; o registro continua no painel.',
      security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', required: ['hidden'],
        properties: {
          hidden: { type: 'boolean' },
          reason: { type: 'string', maxLength: 200, description: 'Anotação interna do motivo.' },
        },
      },
    },
  }, async (req) => {
    const body = req.body as { hidden: boolean; reason?: string };
    return setHidden(req.group!.id, (req.params as { id: string }).id, body.hidden, body.reason);
  });
}
