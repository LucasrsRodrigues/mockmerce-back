import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { slugify } from '../../lib/slug.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { createProduct, deleteProduct, getProductForCaller, visibleWhere } from './service.js';
import {
  productDetailInclude, serializeProduct, serializeProductSummary,
  serializeVariant, serializeImage, variantInclude, variantLabel,
} from './serialize.js';
import { ratingsFor, ratingSummary } from '../reviews/service.js';
import { notifyPriceDrop } from '../push/service.js';
import { money } from '../../lib/serialize.js';

const sec = [{ apiKey: [], studentRm: [] }];

/**
 * Cliente-view = esconde rascunho/oculto/agendado (só produtos publicados).
 * O painel do ALUNO (authVia='student') gerencia a loja e deve ver TUDO, mesmo
 * usando Authorization: Bearer. Só a loja/app (via X-API-Key) com token de
 * comprador é tratada como visão de cliente.
 */
function isCustomerView(request: FastifyRequest): boolean {
  if (request.authVia === 'student') return false;
  const h = request.headers['authorization'];
  return typeof h === 'string' && h.startsWith('Bearer ');
}

export async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  // =====================================================================
  // CATEGORIAS / MARCAS / COLEÇÕES / TAGS
  // =====================================================================
  app.get('/categories', { schema: { tags: ['Catálogo'], summary: 'Lista categorias', security: sec } },
    async (req) => prisma.category.findMany({ where: tenantScope(req.group!.id), orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } }));

  app.post('/categories', {
    schema: { tags: ['Catálogo'], summary: 'Cria categoria', security: sec,
      body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } } } },
  }, async (req, reply) => reply.code(201).send(await createNamed(req.group!.id, 'category', (req.body as any).name)));

  app.get('/brands', { schema: { tags: ['Catálogo'], summary: 'Lista marcas', security: sec } },
    async (req) => prisma.brand.findMany({ where: tenantScope(req.group!.id), orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } }));

  app.post('/brands', {
    schema: { tags: ['Catálogo'], summary: 'Cria marca', security: sec,
      body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } } } },
  }, async (req, reply) => reply.code(201).send(await createNamed(req.group!.id, 'brand', (req.body as any).name)));

  app.get('/collections', { schema: { tags: ['Catálogo'], summary: 'Lista coleções', security: sec } },
    async (req) => prisma.collection.findMany({ where: tenantScope(req.group!.id), orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } }));

  app.post('/collections', {
    schema: { tags: ['Catálogo'], summary: 'Cria coleção', security: sec,
      body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } } } },
  }, async (req, reply) => reply.code(201).send(await createNamed(req.group!.id, 'collection', (req.body as any).name)));

  app.get('/tags', { schema: { tags: ['Catálogo'], summary: 'Lista tags', security: sec } },
    async (req) => prisma.tag.findMany({ where: tenantScope(req.group!.id), orderBy: { name: 'asc' }, select: { id: true, name: true } }));

  // =====================================================================
  // PRODUTOS
  // =====================================================================
  app.get('/products', {
    schema: {
      tags: ['Catálogo'], summary: 'Lista produtos (filtros + paginação)', security: sec,
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' }, categoryId: { type: 'string' }, brandId: { type: 'string' },
          collectionId: { type: 'string' }, tag: { type: 'string' },
          state: { type: 'string', enum: ['DRAFT', 'PUBLISHED', 'HIDDEN'] },
          minPrice: { type: 'number' }, maxPrice: { type: 'number' },
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
  }, async (req) => {
    const q = req.query as any;
    const groupId = req.group!.id;
    const priceFilter = (q.minPrice != null || q.maxPrice != null)
      ? { some: { price: { ...(q.minPrice != null ? { gte: q.minPrice } : {}), ...(q.maxPrice != null ? { lte: q.maxPrice } : {}) } } }
      : undefined;

    const where: any = tenantScope(groupId, {
      ...(isCustomerView(req) ? visibleWhere(new Date()) : q.state ? { state: q.state } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.brandId ? { brandId: q.brandId } : {}),
      ...(q.collectionId ? { collections: { some: { id: q.collectionId } } } : {}),
      ...(q.tag ? { tags: { some: { name: q.tag } } } : {}),
      ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}),
      ...(priceFilter ? { variants: priceFilter } : {}),
    });

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where, orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { brand: true, variants: true, images: { where: { variantId: null } } },
      }),
    ]);
    // Uma consulta agregada para a página inteira (evita N+1 por produto).
    const ratings = await ratingsFor(products.map((p) => p.id));
    return {
      data: products.map((p) => serializeProductSummary(p, ratings.get(p.id))),
      page: q.page, pageSize: q.pageSize, total,
    };
  });

  app.get('/products/:id', {
    schema: { tags: ['Catálogo'], summary: 'Detalha um produto', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => {
    const id = (req.params as any).id;
    const product = await getProductForCaller(req.group!.id, id, isCustomerView(req));
    const rating = await ratingSummary(product.id);
    return serializeProduct(product, rating);
  });

  app.post('/products', {
    schema: {
      tags: ['Catálogo'], summary: 'Cria produto (SIMPLE ou VARIABLE)', security: sec,
      body: {
        type: 'object', required: ['name'],
        properties: {
          type: { type: 'string', enum: ['SIMPLE', 'VARIABLE'] },
          name: { type: 'string', minLength: 1 }, description: { type: 'string' }, slug: { type: 'string' },
          categoryId: { type: 'string' }, brandId: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          collectionIds: { type: 'array', items: { type: 'string' } },
          state: { type: 'string', enum: ['DRAFT', 'PUBLISHED', 'HIDDEN'] },
          publishAt: { type: 'string', format: 'date-time' },
          metaTitle: { type: 'string' }, metaDescription: { type: 'string' },
          // SIMPLE:
          sku: { type: 'string' }, price: { type: 'number', minimum: 0 },
          stock: { type: 'integer', minimum: 0 }, minStock: { type: 'integer', minimum: 0 },
          barcode: { type: 'string' }, weightGr: { type: 'integer', minimum: 0 },
          heightMm: { type: 'integer', minimum: 0 }, widthMm: { type: 'integer', minimum: 0 }, depthMm: { type: 'integer', minimum: 0 },
          // VARIABLE:
          options: {
            type: 'array',
            items: { type: 'object', required: ['name', 'values'], properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } } },
          },
          variants: {
            type: 'array',
            items: {
              type: 'object', required: ['sku', 'price'],
              properties: {
                sku: { type: 'string' }, price: { type: 'number', minimum: 0 },
                stock: { type: 'integer', minimum: 0 }, minStock: { type: 'integer', minimum: 0 },
                barcode: { type: 'string' }, weightGr: { type: 'integer' },
                heightMm: { type: 'integer' }, widthMm: { type: 'integer' }, depthMm: { type: 'integer' },
                options: { type: 'object', additionalProperties: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  }, async (req, reply) => reply.code(201).send(serializeProduct(await createProduct(req.group!.id, req.body as any))));

  app.put('/products/:id', {
    schema: {
      tags: ['Catálogo'], summary: 'Atualiza um produto', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' }, description: { type: 'string' }, slug: { type: 'string' },
          categoryId: { type: 'string', nullable: true }, brandId: { type: 'string', nullable: true },
          tags: { type: 'array', items: { type: 'string' } },
          collectionIds: { type: 'array', items: { type: 'string' } },
          state: { type: 'string', enum: ['DRAFT', 'PUBLISHED', 'HIDDEN'] },
          publishAt: { type: 'string', format: 'date-time', nullable: true },
          metaTitle: { type: 'string' }, metaDescription: { type: 'string' },
        },
      },
    },
  }, async (req) => serializeProduct(await updateProduct(req.group!.id, (req.params as any).id, req.body as any)));

  app.delete('/products/:id', {
    schema: { tags: ['Catálogo'], summary: 'Remove um produto', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req, reply) => { await deleteProduct(req.group!.id, (req.params as any).id); return reply.code(204).send(); });

  // Produtos relacionados / cross-sell / upsell
  app.put('/products/:id/relations', {
    schema: {
      tags: ['Catálogo'], summary: 'Define produtos relacionados/cross-sell/upsell', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', required: ['kind', 'relatedIds'],
        properties: { kind: { type: 'string', enum: ['RELATED', 'CROSS_SELL', 'UPSELL'] }, relatedIds: { type: 'array', items: { type: 'string' } } },
      },
    },
  }, async (req) => setRelations(req.group!.id, (req.params as any).id, req.body as any));

  // =====================================================================
  // VARIANTES
  // =====================================================================
  app.post('/products/:id/variants', {
    schema: {
      tags: ['Catálogo'], summary: 'Adiciona uma variante a um produto variável', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', required: ['sku', 'price', 'options'],
        properties: {
          sku: { type: 'string' }, price: { type: 'number', minimum: 0 },
          stock: { type: 'integer', minimum: 0 }, minStock: { type: 'integer', minimum: 0 },
          barcode: { type: 'string' }, weightGr: { type: 'integer' },
          heightMm: { type: 'integer' }, widthMm: { type: 'integer' }, depthMm: { type: 'integer' },
          options: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
    },
  }, async (req, reply) => reply.code(201).send(await addVariant(req.group!.id, (req.params as any).id, req.body as any)));

  app.patch('/variants/:id', {
    schema: {
      tags: ['Catálogo'], summary: 'Atualiza uma variante', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      description: 'O estoque NÃO é editado aqui — use os endpoints de Estoque (/variants/:id/stock/receive|adjust).',
      body: {
        type: 'object',
        properties: {
          price: { type: 'number', minimum: 0 },
          minStock: { type: 'integer', minimum: 0 }, barcode: { type: 'string' }, active: { type: 'boolean' },
          weightGr: { type: 'integer' }, heightMm: { type: 'integer' }, widthMm: { type: 'integer' }, depthMm: { type: 'integer' },
        },
      },
    },
  }, async (req) => updateVariant(req.group!.id, (req.params as any).id, req.body as any));

  app.delete('/variants/:id', {
    schema: { tags: ['Catálogo'], summary: 'Remove uma variante (não a última)', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req, reply) => { await deleteVariant(req.group!.id, (req.params as any).id); return reply.code(204).send(); });

  // =====================================================================
  // IMAGENS
  // =====================================================================
  app.post('/products/:id/images', {
    schema: {
      tags: ['Catálogo'],
      summary: 'Vincula uma mídia ao produto (por mediaId de um upload ou por URL externa)',
      description:
        'Informe **mediaId** (de um POST /uploads) ou **url** (link externo). ' +
        'Para subir o arquivo e vincular de uma vez, use POST /products/{id}/media.',
      security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          mediaId: { type: 'string' }, url: { type: 'string' }, variantId: { type: 'string' },
          position: { type: 'integer' }, isPrimary: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => reply.code(201).send(await addImage(req.group!.id, (req.params as any).id, req.body as any)));

  app.patch('/images/:id', {
    schema: {
      tags: ['Catálogo'], summary: 'Ajusta a mídia do produto (capa, ordem ou variante)', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          isPrimary: { type: 'boolean' },
          position: { type: 'integer', minimum: 0 },
          variantId: { type: 'string', nullable: true },
        },
      },
    },
  }, async (req) => updateImage(req.group!.id, (req.params as any).id, req.body as any));

  app.delete('/images/:id', {
    schema: { tags: ['Catálogo'], summary: 'Desvincula a mídia do produto (o arquivo continua na biblioteca)', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req, reply) => { await deleteImage(req.group!.id, (req.params as any).id); return reply.code(204).send(); });
}

// =====================================================================
// Helpers de escrita (usam tenantScope — ADR-G2)
// =====================================================================
async function createNamed(groupId: string, model: 'category' | 'brand' | 'collection', name: string) {
  const slug = slugify(name);
  const table: any = (prisma as any)[model];
  const exists = await table.findFirst({ where: tenantScope(groupId, { slug }), select: { id: true } });
  if (exists) throw conflict(`Já existe com o slug "${slug}".`);
  return table.create({ data: { groupId, name, slug }, select: { id: true, name: true, slug: true } });
}

async function updateProduct(groupId: string, id: string, body: any) {
  const product = await prisma.product.findFirst({ where: tenantScope(groupId, { id }), select: { id: true } });
  if (!product) throw notFound('Produto não encontrado.');

  if (body.categoryId) { const c = await prisma.category.findFirst({ where: tenantScope(groupId, { id: body.categoryId }), select: { id: true } }); if (!c) throw badRequest('categoryId inválido.'); }
  if (body.brandId) { const b = await prisma.brand.findFirst({ where: tenantScope(groupId, { id: body.brandId }), select: { id: true } }); if (!b) throw badRequest('brandId inválido.'); }

  let slug: string | undefined;
  if (body.slug) {
    slug = slugify(body.slug);
    const clash = await prisma.product.findFirst({ where: tenantScope(groupId, { slug, id: { not: id } }), select: { id: true } });
    if (clash) throw conflict(`slug "${slug}" já em uso.`);
  }

  const tagIds = body.tags ? await resolveTags(groupId, body.tags) : undefined;

  await prisma.product.update({
    where: { id },
    data: {
      name: body.name, description: body.description, slug,
      state: body.state, publishAt: body.publishAt !== undefined ? (body.publishAt ? new Date(body.publishAt) : null) : undefined,
      categoryId: body.categoryId, brandId: body.brandId,
      metaTitle: body.metaTitle, metaDescription: body.metaDescription,
      ...(tagIds ? { tags: { set: tagIds.map((t) => ({ id: t })) } } : {}),
      ...(body.collectionIds ? { collections: { set: body.collectionIds.map((c: string) => ({ id: c })) } } : {}),
    },
  });
  return prisma.product.findUniqueOrThrow({ where: { id }, include: productDetailInclude });
}

async function resolveTags(groupId: string, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const raw of names) {
    const name = raw.trim(); if (!name) continue;
    const tag = await prisma.tag.upsert({ where: { groupId_name: { groupId, name } }, create: { groupId, name }, update: {}, select: { id: true } });
    ids.push(tag.id);
  }
  return ids;
}

async function setRelations(groupId: string, productId: string, body: { kind: any; relatedIds: string[] }) {
  const product = await prisma.product.findFirst({ where: tenantScope(groupId, { id: productId }), select: { id: true } });
  if (!product) throw notFound('Produto não encontrado.');
  const n = await prisma.product.count({ where: tenantScope(groupId, { id: { in: body.relatedIds } }) });
  if (n !== body.relatedIds.length) throw badRequest('Algum relatedId não pertence ao grupo.');
  await prisma.$transaction(async (tx) => {
    await tx.productRelation.deleteMany({ where: { productId, kind: body.kind } });
    await tx.productRelation.createMany({ data: body.relatedIds.filter((r) => r !== productId).map((relatedId) => ({ productId, relatedId, kind: body.kind })) });
  });
  return { kind: body.kind, relatedIds: body.relatedIds };
}

async function loadVariableProduct(groupId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: tenantScope(groupId, { id: productId }),
    include: { options: { include: { values: true } }, variants: { include: { optionValues: true } } },
  });
  if (!product) throw notFound('Produto não encontrado.');
  return product;
}

async function addVariant(groupId: string, productId: string, body: any) {
  const product = await loadVariableProduct(groupId, productId);
  if (product.type !== 'VARIABLE') throw badRequest('Só produtos VARIABLE aceitam novas variantes.');

  const dup = await prisma.productVariant.findFirst({ where: tenantScope(groupId, { sku: body.sku }), select: { sku: true } });
  if (dup) throw conflict(`SKU "${body.sku}" já existe.`);

  const optionByName = new Map(product.options.map((o) => [o.name, o]));
  // combinação alvo
  const targetKey = product.options.map((o) => `${o.id}=${resolveValueId(o, body.options?.[o.name])}`).join('|');
  const existingKeys = product.variants.map((v) => v.optionValues.map((ov) => `${ov.optionId}=${ov.optionValueId}`).sort().join('|'));

  const variant = await prisma.$transaction(async (tx) => {
    const created = await tx.productVariant.create({
      data: {
        groupId, productId, sku: body.sku, barcode: body.barcode, price: body.price,
        stock: body.stock ?? 0, minStock: body.minStock ?? 0,
        weightGr: body.weightGr, heightMm: body.heightMm, widthMm: body.widthMm, depthMm: body.depthMm,
      },
    });
    const links: string[] = [];
    for (const o of product.options) {
      const valName = body.options?.[o.name];
      const val = o.values.find((vv) => vv.value === valName);
      if (!val) throw badRequest(`Opção inválida: ${o.name}=${valName}.`);
      await tx.variantOptionValue.create({ data: { variantId: created.id, optionId: o.id, optionValueId: val.id } });
      links.push(`${o.id}=${val.id}`);
    }
    if (existingKeys.includes(links.sort().join('|'))) throw conflict('Combinação de variante já existe.');
    return created.id;
  });

  const full = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant }, include: variantInclude });
  return serializeVariant(full);

  function resolveValueId(o: any, valName?: string) { return o.values.find((vv: any) => vv.value === valName)?.id ?? '?'; }
}

async function updateVariant(groupId: string, id: string, body: any) {
  const v = await prisma.productVariant.findFirst({ where: tenantScope(groupId, { id }), select: { id: true, price: true } });
  if (!v) throw notFound('Variante não encontrada.');
  const precoAntes = money(v.price);
  await prisma.productVariant.update({
    where: { id },
    data: {
      price: body.price, minStock: body.minStock, barcode: body.barcode, active: body.active,
      weightGr: body.weightGr, heightMm: body.heightMm, widthMm: body.widthMm, depthMm: body.depthMm,
    },
  });
  const full = await prisma.productVariant.findUniqueOrThrow({ where: { id }, include: variantInclude });

  // Preço caiu -> quem favoritou recebe push. É aguardado (e não disparado em
  // segundo plano) para que o registro já esteja no inspector quando a
  // resposta chegar — em aula, ver a causa e o efeito juntos vale o
  // milissegundo. notifyPriceDrop nunca lança: o preço muda mesmo sem push.
  const precoDepois = money(full.price);
  if (precoDepois < precoAntes) await notifyPriceDrop(groupId, id, precoAntes, precoDepois);

  return serializeVariant(full);
}

async function deleteVariant(groupId: string, id: string) {
  const v = await prisma.productVariant.findFirst({ where: tenantScope(groupId, { id }), select: { id: true, productId: true } });
  if (!v) throw notFound('Variante não encontrada.');
  const count = await prisma.productVariant.count({ where: { productId: v.productId } });
  if (count <= 1) throw conflict('Não é possível remover a última variante do produto.');
  await prisma.productVariant.delete({ where: { id } });
}

async function addImage(groupId: string, productId: string, body: any) {
  const product = await prisma.product.findFirst({ where: tenantScope(groupId, { id: productId }), select: { id: true } });
  if (!product) throw notFound('Produto não encontrado.');
  if (body.variantId) {
    const v = await prisma.productVariant.findFirst({ where: tenantScope(groupId, { id: body.variantId, productId }), select: { id: true } });
    if (!v) throw badRequest('variantId não pertence a este produto.');
  }

  // Dois jeitos de apontar o arquivo: uma mídia da biblioteca (upload no S3) ou
  // uma URL externa digitada. A mídia manda no tipo (IMAGE/VIDEO) e na URL.
  let url: string = body.url;
  let kind: 'IMAGE' | 'VIDEO' = 'IMAGE';
  let mediaId: string | null = null;
  if (body.mediaId) {
    const media = await prisma.mediaAsset.findFirst({ where: tenantScope(groupId, { id: body.mediaId }), select: { id: true, url: true, kind: true } });
    if (!media) throw badRequest('mediaId não encontrado na biblioteca desta loja.');
    mediaId = media.id;
    url = media.url;
    kind = media.kind;
  } else if (!url) {
    throw badRequest('Informe "mediaId" (upload) ou "url" (link externo).');
  }

  const [count, imageCount] = await Promise.all([
    prisma.productImage.count({ where: { productId } }),
    prisma.productImage.count({ where: { productId, kind: 'IMAGE' } }),
  ]);
  const img = await prisma.productImage.create({
    data: {
      productId, variantId: body.variantId, mediaId, kind, url,
      position: body.position ?? count,
      // Capa automática: a PRIMEIRA imagem do produto. Vídeo nunca vira capa
      // sozinho (o card da listagem mostra imagem), e um vídeo enviado antes
      // não pode "roubar" a vaga de capa da primeira foto.
      isPrimary: body.isPrimary ?? (kind === 'IMAGE' && imageCount === 0),
    },
  });
  if (img.isPrimary) await prisma.productImage.updateMany({ where: { productId, id: { not: img.id } }, data: { isPrimary: false } });
  return serializeImage(img);
}

async function updateImage(groupId: string, id: string, body: any) {
  const img = await prisma.productImage.findFirst({
    where: { id, product: tenantScope(groupId) },
    select: { id: true, productId: true, kind: true },
  });
  if (!img) throw notFound('Imagem não encontrada.');

  if (body.isPrimary === true && img.kind !== 'IMAGE') {
    throw badRequest('Só uma imagem pode ser a capa do produto.');
  }
  if (body.variantId) {
    const v = await prisma.productVariant.findFirst({
      where: tenantScope(groupId, { id: body.variantId, productId: img.productId }), select: { id: true },
    });
    if (!v) throw badRequest('variantId não pertence a este produto.');
  }

  const updated = await prisma.productImage.update({
    where: { id },
    data: {
      ...(body.isPrimary !== undefined ? { isPrimary: body.isPrimary } : {}),
      ...(body.position !== undefined ? { position: body.position } : {}),
      ...(body.variantId !== undefined ? { variantId: body.variantId } : {}),
    },
  });
  // Capa é exclusiva: promover uma rebaixa as outras do mesmo produto.
  if (updated.isPrimary) {
    await prisma.productImage.updateMany({
      where: { productId: img.productId, id: { not: id } }, data: { isPrimary: false },
    });
  }
  return serializeImage(updated);
}

async function deleteImage(groupId: string, id: string) {
  const img = await prisma.productImage.findFirst({ where: { id, product: tenantScope(groupId) }, select: { id: true } });
  if (!img) throw notFound('Imagem não encontrada.');
  await prisma.productImage.delete({ where: { id } });
}

export { variantLabel };
