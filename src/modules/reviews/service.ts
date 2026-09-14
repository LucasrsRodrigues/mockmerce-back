import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { emitEvent } from '../../lib/outbox.js';

/**
 * Avaliações de produto (f5-reviews).
 *
 * Regras de negócio que valem para toda a plataforma:
 *   - Só avalia quem comprou: precisa existir um pedido PAGO do cliente com
 *     aquele produto (ver `findPurchase`).
 *   - Uma avaliação por cliente em cada produto (unique no banco).
 *   - Nasce visível; a loja oculta depois (`hidden`) — nada fica esperando
 *     aprovação para aparecer.
 */

/** Status de pedido que comprovam a compra: já pagou, então já pode opinar. */
const PURCHASED_STATUSES = ['PAID', 'SHIPPED', 'DELIVERED', 'FULFILLED'] as const;

/** Máximo de fotos por avaliação — evita o cliente despejar a galeria inteira. */
const MAX_IMAGES = 5;

export const reviewInclude = {
  customer: { select: { id: true, name: true } },
  images: { orderBy: { position: 'asc' } },
} as const;

/** Primeiro nome + inicial ("Maria S."), como as lojas fazem. */
function displayName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export function serializeReview(r: any, viewerId?: string | null) {
  return {
    id: r.id,
    rating: r.rating,
    title: r.title,
    comment: r.comment,
    images: (r.images ?? []).map((i: any) => ({ id: i.id, url: i.url, mediaId: i.mediaId })),
    author: { name: displayName(r.customer?.name ?? 'Cliente'), id: r.customer?.id ?? null },
    /// true quando a avaliação está amarrada a um pedido pago (selo da vitrine).
    verifiedPurchase: Boolean(r.orderId),
    /// Só o dono vê que a própria avaliação foi ocultada pela loja.
    hidden: r.hidden,
    isMine: viewerId ? r.customerId === viewerId : false,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Serialização para o painel da loja — mostra quem avaliou e o motivo do bloqueio. */
export function serializeReviewForStore(r: any) {
  return {
    id: r.id,
    rating: r.rating,
    title: r.title,
    comment: r.comment,
    images: (r.images ?? []).map((i: any) => ({ id: i.id, url: i.url })),
    customer: r.customer ? { id: r.customer.id, name: r.customer.name, email: r.customer.email } : null,
    product: r.product ? { id: r.product.id, name: r.product.name } : null,
    verifiedPurchase: Boolean(r.orderId),
    hidden: r.hidden,
    hiddenReason: r.hiddenReason,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Média e distribuição das notas de um produto (só as visíveis).
 *
 * A distribuição (quantas notas 5, quantas 4…) é o que desenha aquela barrinha
 * por estrela na tela do produto.
 */
export async function ratingSummary(productId: string) {
  const rows = await prisma.review.groupBy({
    by: ['rating'],
    where: { productId, hidden: false },
    _count: { rating: true },
  });
  const distribution: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let total = 0;
  let soma = 0;
  for (const r of rows) {
    distribution[String(r.rating)] = r._count.rating;
    total += r._count.rating;
    soma += r.rating * r._count.rating;
  }
  return {
    average: total ? Math.round((soma / total) * 10) / 10 : 0,
    count: total,
    distribution,
  };
}

/**
 * Média e contagem de VÁRIOS produtos de uma vez.
 *
 * Usado na listagem do catálogo: uma consulta agregada para a página inteira,
 * em vez de uma por produto (o clássico problema N+1).
 */
export async function ratingsFor(productIds: string[]): Promise<Map<string, { average: number; count: number }>> {
  const map = new Map<string, { average: number; count: number }>();
  if (productIds.length === 0) return map;
  const rows = await prisma.review.groupBy({
    by: ['productId'],
    where: { productId: { in: productIds }, hidden: false },
    _avg: { rating: true },
    _count: { rating: true },
  });
  for (const r of rows) {
    map.set(r.productId, {
      average: Math.round((r._avg.rating ?? 0) * 10) / 10,
      count: r._count.rating,
    });
  }
  return map;
}

/** Pedido pago do cliente que contém este produto — a prova da compra. */
async function findPurchase(groupId: string, productId: string, customerId: string) {
  return prisma.order.findFirst({
    where: tenantScope(groupId, {
      customerId,
      status: { in: [...PURCHASED_STATUSES] },
      items: { some: { variant: { productId } } },
    }),
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
}

/**
 * O cliente pode avaliar este produto? Responde ANTES de ele escrever — é o que
 * a tela usa para decidir entre mostrar o formulário, o botão desabilitado ou a
 * avaliação que ele já deixou.
 */
export async function canReview(groupId: string, productId: string, customerId: string) {
  const product = await prisma.product.findFirst({ where: tenantScope(groupId, { id: productId }), select: { id: true } });
  if (!product) throw notFound('Produto não encontrado.');

  const [existing, purchase] = await Promise.all([
    prisma.review.findFirst({ where: { productId, customerId }, select: { id: true } }),
    findPurchase(groupId, productId, customerId),
  ]);

  if (existing) {
    return { canReview: false, reason: 'ALREADY_REVIEWED', message: 'Você já avaliou este produto.', reviewId: existing.id };
  }
  if (!purchase) {
    return { canReview: false, reason: 'NOT_PURCHASED', message: 'Só quem comprou este produto pode avaliá-lo.', reviewId: null };
  }
  return { canReview: true, reason: null, message: 'Pode avaliar.', reviewId: null };
}

/** Valida os mediaIds e devolve as fotos prontas para gravar. */
async function resolveImages(groupId: string, mediaIds: string[] | undefined) {
  if (!mediaIds || mediaIds.length === 0) return [];
  if (mediaIds.length > MAX_IMAGES) throw badRequest(`No máximo ${MAX_IMAGES} fotos por avaliação.`);

  const medias = await prisma.mediaAsset.findMany({
    where: tenantScope(groupId, { id: { in: mediaIds } }),
    select: { id: true, url: true, kind: true },
  });
  if (medias.length !== new Set(mediaIds).size) {
    throw badRequest('Algum mediaId não existe nesta loja. Envie a foto em POST /uploads primeiro.');
  }
  const video = medias.find((m) => m.kind !== 'IMAGE');
  if (video) throw badRequest('Avaliação aceita apenas imagens.');

  // Preserva a ordem em que o cliente mandou.
  return mediaIds.map((id, position) => {
    const media = medias.find((m) => m.id === id)!;
    return { mediaId: media.id, url: media.url, position };
  });
}

export interface ReviewInput {
  rating: number;
  title?: string | null;
  comment?: string;
  mediaIds?: string[];
}

export async function createReview(
  groupId: string,
  productId: string,
  customerId: string,
  input: ReviewInput,
) {
  const product = await prisma.product.findFirst({
    where: tenantScope(groupId, { id: productId }), select: { id: true, name: true },
  });
  if (!product) throw notFound('Produto não encontrado.');

  const purchase = await findPurchase(groupId, productId, customerId);
  if (!purchase) throw forbidden('Só quem comprou este produto pode avaliá-lo.');

  const existente = await prisma.review.findFirst({ where: { productId, customerId }, select: { id: true } });
  if (existente) throw conflict('Você já avaliou este produto. Edite a avaliação existente.');

  const images = await resolveImages(groupId, input.mediaIds);

  const review = await prisma.$transaction(async (tx) => {
    const created = await tx.review.create({
      data: {
        groupId,
        productId,
        customerId,
        orderId: purchase.id,
        rating: input.rating,
        title: input.title ?? null,
        comment: input.comment ?? '',
        images: { create: images },
      },
      include: reviewInclude,
    });
    // Outbox (ADR-G5): a loja recebe no webhook e pode responder/moderar.
    await emitEvent(tx, groupId, 'review.created', {
      reviewId: created.id,
      productId,
      productName: product.name,
      rating: created.rating,
      hasImages: images.length > 0,
    });
    return created;
  });

  return review;
}

/** Busca a avaliação garantindo que ela é DO CLIENTE logado. */
async function ownReview(groupId: string, id: string, customerId: string) {
  const review = await prisma.review.findFirst({ where: tenantScope(groupId, { id }), select: { id: true, customerId: true } });
  if (!review) throw notFound('Avaliação não encontrada.');
  if (review.customerId !== customerId) throw forbidden('Esta avaliação não é sua.');
  return review;
}

export async function updateReview(
  groupId: string,
  id: string,
  customerId: string,
  input: Partial<ReviewInput>,
) {
  await ownReview(groupId, id, customerId);
  // Trocar as fotos substitui a lista inteira (é como a tela funciona: o
  // cliente vê as fotos atuais e reenvia o conjunto que quer manter).
  const images = input.mediaIds !== undefined ? await resolveImages(groupId, input.mediaIds) : null;

  return prisma.$transaction(async (tx) => {
    if (images !== null) {
      await tx.reviewImage.deleteMany({ where: { reviewId: id } });
      if (images.length) await tx.reviewImage.createMany({ data: images.map((i) => ({ ...i, reviewId: id })) });
    }
    return tx.review.update({
      where: { id },
      data: {
        ...(input.rating !== undefined ? { rating: input.rating } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
      },
      include: reviewInclude,
    });
  });
}

export async function deleteReview(groupId: string, id: string, customerId: string) {
  await ownReview(groupId, id, customerId);
  await prisma.review.delete({ where: { id } });
}

/** Moderação: a loja oculta (ou volta a exibir) uma avaliação. */
export async function setHidden(groupId: string, id: string, hidden: boolean, reason?: string | null) {
  const review = await prisma.review.findFirst({ where: tenantScope(groupId, { id }), select: { id: true } });
  if (!review) throw notFound('Avaliação não encontrada.');
  const updated = await prisma.review.update({
    where: { id },
    data: { hidden, hiddenReason: hidden ? (reason ?? null) : null },
    include: { ...reviewInclude, product: { select: { id: true, name: true } }, customer: { select: { id: true, name: true, email: true } } },
  });
  return serializeReviewForStore(updated);
}
