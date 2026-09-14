import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { serializeImage } from '../catalog/serialize.js';
import { deleteMedia, getMedia, serializeMedia, storageUsage, uploadMedia } from './service.js';
import type { UploadedFile } from './service.js';

const sec = [{ apiKey: [], studentRm: [] }];

/**
 * Nas rotas multipart o `schema.body` existe só para DOCUMENTAR o formulário
 * (é ele que faz o Swagger UI mostrar o botão "escolher arquivo"). O corpo real
 * é lido em streaming por `req.parts()`, então o Fastify não tem um objeto para
 * validar e reprovaria toda requisição. Este compilador dispensa a validação
 * automática; quem valida arquivo e campos é o service (formato, tamanho, cota).
 */
const skipBodyValidation = () => () => true;

/** Formato de erro da API (o mesmo que o errorHandler global devolve). */
const errorSchema = (description: string) => ({
  description,
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
});

/** Corpo de uma mídia. `additionalProperties` evita que o schema filtre campos novos. */
const mediaSchema = {
  description: 'Arquivo enviado.',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['IMAGE', 'VIDEO'] },
    url: { type: 'string', description: 'URL pública, pronta para usar no app.' },
    mimeType: { type: 'string', description: 'Tipo detectado pelos bytes do arquivo.' },
    sizeBytes: { type: 'integer' },
    originalName: { type: 'string', nullable: true },
    folder: { type: 'string', nullable: true },
    uploadedByRm: { type: 'string', nullable: true },
    createdAt: { type: 'string' },
  },
} as const;

/** Erros que todo upload pode devolver — a parte que mais confunde quem está aprendendo. */
const uploadErrorResponses = {
  413: errorSchema('FILE_TOO_LARGE — arquivo acima do limite por arquivo (UPLOAD_MAX_MB).'),
  415: errorSchema('UNSUPPORTED_MEDIA_TYPE — o conteúdo do arquivo não é um formato aceito.'),
  422: errorSchema('UNPROCESSABLE — a loja estourou a cota de armazenamento.'),
  503: errorSchema('UPLOAD_DISABLED — ambiente sem bucket configurado.'),
} as const;

/**
 * Upload de mídia (f4-media-uploads).
 *
 * O arquivo sobe em `multipart/form-data` (campo `file`), o backend valida e
 * repassa para o S3, e a API devolve a URL pública final — pronta para usar no
 * `<Image source={{ uri }} />` do app. O binário nunca volta pela API: o
 * consumo é direto do bucket/CDN.
 *
 * Fluxo típico do aluno:
 *   1. POST /v1/uploads                      → { id, url }
 *   2. POST /v1/products/:id/images { mediaId } → vincula ao produto
 * ou, num passo só:
 *      POST /v1/products/:id/media  (multipart) → sobe E vincula.
 */
export async function mediaRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  // =====================================================================
  // BIBLIOTECA DE MÍDIA
  // =====================================================================
  app.post('/uploads', {
    schema: {
      tags: ['Mídia'],
      summary: 'Envia uma imagem ou vídeo (multipart/form-data, campo "file")',
      description:
        'Campo obrigatório: **file**. Campo opcional: **folder** (pasta lógica, ex.: "produtos").\n\n' +
        'O tipo é detectado pelo conteúdo do arquivo, não pela extensão. ' +
        'Aceitos: JPEG, PNG, WebP, GIF, AVIF, MP4, WebM e MOV.',
      security: sec,
      consumes: ['multipart/form-data'],
      // Descreve o formulário para o Swagger UI mostrar o botão de escolher
      // arquivo. Sem `required` de propósito: o corpo é lido em streaming
      // (req.parts()), então o Fastify não tem um body parseado para validar —
      // quem valida a presença do arquivo é o service.
      body: {
        type: 'object',
        properties: {
          file: { type: 'string', format: 'binary' },
          folder: { type: 'string' },
        },
      },
      response: { 201: mediaSchema, ...uploadErrorResponses },
    },
    validatorCompiler: skipBodyValidation,
  }, async (req, reply) => {
    const { file, fields } = await readMultipart(req);
    const media = await uploadMedia({
      groupId: req.group!.id,
      rm: req.rm,
      file,
      folder: fields.folder,
    });
    return reply.code(201).send(serializeMedia(media));
  });

  app.get('/media', {
    schema: {
      tags: ['Mídia'], summary: 'Lista a biblioteca de mídia da loja', security: sec,
      querystring: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['IMAGE', 'VIDEO'] },
          folder: { type: 'string' },
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
  }, async (req) => {
    const q = req.query as { kind?: 'IMAGE' | 'VIDEO'; folder?: string; page: number; pageSize: number };
    const where = tenantScope(req.group!.id, {
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.folder ? { folder: q.folder } : {}),
    });
    const [total, rows] = await Promise.all([
      prisma.mediaAsset.count({ where }),
      prisma.mediaAsset.findMany({
        where, orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
    ]);
    return { data: rows.map(serializeMedia), page: q.page, pageSize: q.pageSize, total };
  });

  // Vem antes de /media/:id para o "usage" não ser lido como um id.
  app.get('/media/usage', {
    schema: {
      tags: ['Mídia'], summary: 'Espaço usado, cota da loja e limites de upload', security: sec,
      response: {
        200: {
          description: 'Uso e limites da loja.',
          type: 'object',
          additionalProperties: true,
          properties: {
            files: { type: 'integer' },
            usedBytes: { type: 'integer' },
            quotaBytes: { type: 'integer' },
            availableBytes: { type: 'integer' },
            usedPercent: { type: 'number' },
            maxFileBytes: { type: 'integer', description: 'Limite por arquivo.' },
            acceptedMimeTypes: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }, async (req) => storageUsage(req.group!.id));

  app.get('/media/:id', {
    schema: { tags: ['Mídia'], summary: 'Detalha um arquivo', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (req) => serializeMedia(await getMedia(req.group!.id, (req.params as { id: string }).id)));

  app.delete('/media/:id', {
    schema: {
      tags: ['Mídia'], summary: 'Apaga o arquivo do bucket e da biblioteca', security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: { force: { type: 'boolean', default: false, description: 'Apaga mesmo se estiver em uso por um produto.' } },
      },
      response: {
        200: {
          description: 'Arquivo apagado.',
          type: 'object',
          additionalProperties: true,
          properties: { deleted: { type: 'boolean' }, unlinkedFrom: { type: 'integer', description: 'Quantos vínculos com produtos saíram junto.' } },
        },
        404: errorSchema('NOT_FOUND — arquivo não encontrado nesta loja.'),
        409: errorSchema('CONFLICT — arquivo em uso por algum produto; repita com ?force=true.'),
      },
    },
  }, async (req) => deleteMedia(req.group!.id, (req.params as { id: string }).id, (req.query as { force?: boolean }).force === true));

  // =====================================================================
  // ATALHO: sobe o arquivo E já vincula ao produto/variante
  // =====================================================================
  app.post('/products/:id/media', {
    schema: {
      tags: ['Mídia'],
      summary: 'Envia uma mídia e já vincula ao produto (multipart/form-data)',
      description:
        'Campo obrigatório: **file**. Opcionais: **variantId** (vincula à variante), ' +
        '**isPrimary** ("true" para virar a capa) e **position**.',
      security: sec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      consumes: ['multipart/form-data'],
      body: {
        type: 'object',
        properties: {
          file: { type: 'string', format: 'binary' },
          variantId: { type: 'string' },
          isPrimary: { type: 'string', enum: ['true', 'false'] },
          position: { type: 'integer' },
          folder: { type: 'string' },
        },
      },
      response: {
        201: {
          description: 'Mídia enviada e vinculada ao produto.',
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', description: 'Id do VÍNCULO (use em PATCH/DELETE /images/:id).' },
            url: { type: 'string' },
            kind: { type: 'string', enum: ['IMAGE', 'VIDEO'] },
            mediaId: { type: 'string', nullable: true },
            position: { type: 'integer' },
            isPrimary: { type: 'boolean' },
            media: mediaSchema,
          },
        },
        404: errorSchema('NOT_FOUND — produto não encontrado nesta loja.'),
        ...uploadErrorResponses,
      },
    },
    validatorCompiler: skipBodyValidation,
  }, async (req, reply) => {
    const groupId = req.group!.id;
    const productId = (req.params as { id: string }).id;

    const product = await prisma.product.findFirst({ where: tenantScope(groupId, { id: productId }), select: { id: true } });
    if (!product) throw notFound('Produto não encontrado.');

    const { file, fields } = await readMultipart(req);
    if (fields.variantId) {
      const variant = await prisma.productVariant.findFirst({
        where: tenantScope(groupId, { id: fields.variantId, productId }), select: { id: true },
      });
      if (!variant) throw badRequest('variantId não pertence a este produto.');
    }

    const media = await uploadMedia({ groupId, rm: req.rm, file, folder: fields.folder ?? 'produtos' });

    const [count, imageCount] = await Promise.all([
      prisma.productImage.count({ where: { productId } }),
      prisma.productImage.count({ where: { productId, kind: 'IMAGE' } }),
    ]);
    const position = fields.position != null ? Number(fields.position) : count;
    // Capa automática = primeira IMAGEM do produto (vídeo nunca vira capa sozinho).
    const isPrimary = fields.isPrimary === 'true'
      ? true
      : media.kind === 'IMAGE' && imageCount === 0;

    const link = await prisma.productImage.create({
      data: {
        productId,
        variantId: fields.variantId ?? null,
        mediaId: media.id,
        kind: media.kind,
        url: media.url,
        position: Number.isFinite(position) ? position : count,
        isPrimary,
      },
    });
    if (link.isPrimary) {
      await prisma.productImage.updateMany({ where: { productId, id: { not: link.id } }, data: { isPrimary: false } });
    }

    return reply.code(201).send({ ...serializeImage(link), media: serializeMedia(media) });
  });
}

/**
 * Lê o multipart inteiro: o primeiro arquivo (já bufferizado) mais os campos de
 * texto — em QUALQUER ordem, porque o FormData do app pode mandar o arquivo
 * antes ou depois dos campos. Usamos `req.parts()` (streaming) em vez de
 * `attachFieldsToBody` para o Fastify não tentar validar o corpo contra o
 * schema JSON das rotas.
 */
async function readMultipart(req: FastifyRequest) {
  if (!req.isMultipart()) {
    throw badRequest('Envie o arquivo como multipart/form-data (campo "file").');
  }
  const fields: Record<string, string | undefined> = {};
  let file: UploadedFile | undefined;

  for await (const item of req.parts()) {
    if (item.type === 'file') {
      // O stream de cada part PRECISA ser consumido antes de ir para o próximo.
      // Uma chamada = uma mídia: arquivos extras são drenados e descartados,
      // sem passar pela memória.
      if (file) {
        item.file.resume();
        continue;
      }
      const buffer = await item.toBuffer();
      file = { buffer, filename: item.filename, truncated: item.file.truncated };
    } else if (typeof item.value === 'string') {
      fields[item.fieldname] = item.value;
    }
  }
  return { file, fields };
}
