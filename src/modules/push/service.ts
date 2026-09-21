import type { DevicePlatform, PushKind } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { env } from '../../env.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { money } from '../../lib/serialize.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { emitEvent } from '../../lib/outbox.js';
import { requirePush, sendPush, type PushResult } from '../../lib/push.js';
import { resolveCredentials } from './credentials.js';

/**
 * Regras de push. O `lib/push.ts` sabe falar FCM; aqui está o que é do
 * negócio: quem tem aparelho, o que fica registrado, e o que acontece quando
 * o Google diz que um token morreu.
 */

// --------------------------------------------------------------- aparelhos

export interface RegisterInput {
  token: string;
  platform: DevicePlatform;
  deviceName?: string;
  appVersion?: string;
}

/**
 * Registra (ou reaproveita) o aparelho do cliente logado.
 *
 * É um UPSERT por token, e não um create, porque o token é por INSTALAÇÃO: o
 * mesmo aparelho reabre o app todo dia e manda o mesmo token. Pior — o mesmo
 * token pode reaparecer sob OUTRO cliente (duas pessoas no mesmo celular),
 * e nesse caso ele tem que trocar de dono, senão o push do cliente antigo
 * continua chegando no aparelho de quem logou depois.
 */
export async function registerDevice(groupId: string, customerId: string, input: RegisterInput) {
  const device = await prisma.deviceToken.upsert({
    where: { token: input.token },
    create: {
      groupId,
      customerId,
      token: input.token,
      platform: input.platform,
      deviceName: input.deviceName,
      appVersion: input.appVersion,
    },
    update: {
      groupId,
      customerId,
      platform: input.platform,
      deviceName: input.deviceName,
      appVersion: input.appVersion,
      // Reativa: o aparelho voltou, mesmo que um envio anterior tenha falhado.
      active: true,
      disabledReason: null,
      lastSeenAt: new Date(),
    },
  });
  return serializeDevice(device);
}

export async function listDevices(groupId: string, where: { customerId?: string } = {}) {
  const devices = await prisma.deviceToken.findMany({
    where: tenantScope(groupId, where.customerId ? { customerId: where.customerId } : {}),
    orderBy: { lastSeenAt: 'desc' },
  });
  return devices.map(serializeDevice);
}

/** Aceita o id do registro OU o token cru — o app costuma ter só o token. */
export async function removeDevice(groupId: string, idOrToken: string, customerId?: string) {
  const { count } = await prisma.deviceToken.deleteMany({
    where: tenantScope(groupId, {
      OR: [{ id: idOrToken }, { token: idOrToken }],
      ...(customerId ? { customerId } : {}),
    }),
  });
  if (count === 0) throw notFound('Aparelho não encontrado.');
}

// ------------------------------------------------------------------ envio

export interface DeliverInput {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  kind?: PushKind;
  androidChannelId?: string;
  /** O que originou o disparo (aparece no inspector). */
  reason?: string;
}

export interface TargetInput {
  customerId?: string;
  deviceId?: string;
  token?: string;
  /** true = todos os aparelhos ativos do grupo (o "avisar a loja toda"). */
  allDevices?: boolean;
}

/** Resolve o alvo em uma lista concreta de aparelhos ATIVOS do grupo. */
async function resolveTargets(groupId: string, target: TargetInput) {
  const filters: Record<string, unknown>[] = [];
  if (target.customerId) filters.push({ customerId: target.customerId });
  if (target.deviceId) filters.push({ id: target.deviceId });
  if (target.token) filters.push({ token: target.token });

  if (filters.length === 0 && !target.allDevices) {
    throw badRequest('Informe customerId, deviceId, token ou allDevices: true.');
  }

  return prisma.deviceToken.findMany({
    where: tenantScope(groupId, {
      active: true,
      ...(filters.length > 0 ? { OR: filters } : {}),
    }),
  });
}

/**
 * Dispara para todos os aparelhos do alvo e REGISTRA cada tentativa.
 *
 * O log não é auditoria burocrática: é o inspector que o aluno abre quando "a
 * notificação não chegou". Sem ele, o único retorno é o silêncio do aparelho.
 */
export async function deliver(groupId: string, target: TargetInput, payload: DeliverInput) {
  const devices = await resolveTargets(groupId, target);

  // Uma vez por disparo, não por aparelho: todos os aparelhos de um grupo são
  // alcançados pela mesma credencial (a do projeto Firebase daquele grupo).
  const resolved = await resolveCredentials(groupId);
  const cred = resolved?.cred ?? null;
  const origem = resolved?.source ?? 'server';

  if (devices.length === 0) {
    // Não é erro: é o caso comum de "ninguém instalou o app ainda". Fica
    // registrado como SKIPPED para a ausência ser VISÍVEL no inspector.
    await prisma.pushMessage.create({
      data: {
        groupId,
        customerId: target.customerId,
        title: payload.title,
        body: payload.body,
        data: (payload.data ?? {}) as any,
        kind: payload.kind ?? 'NOTIFICATION',
        status: 'SKIPPED',
        errorCode: 'NO_DEVICE',
        errorDetail: 'Nenhum aparelho ativo para este alvo.',
        reason: payload.reason ?? 'manual',
      },
    });
    return { sent: 0, failed: 0, skipped: 1, results: [] as Array<Record<string, unknown>> };
  }

  requirePush(cred);

  const results = await mapWithConcurrency(devices, env.PUSH_CONCURRENCY, async (device) => {
    const result = await sendPush(cred, {
      token: device.token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      kind: payload.kind ?? 'NOTIFICATION',
      androidChannelId: payload.androidChannelId,
    });

    await recordAttempt(groupId, device.id, device.customerId, payload, result);

    // Token morto: desativa em vez de apagar. O histórico de envios continua
    // apontando para um aparelho que existiu, e o app re-registra sozinho na
    // próxima abertura.
    if (result.tokenGone) {
      await prisma.deviceToken.update({
        where: { id: device.id },
        data: { active: false, disabledReason: result.errorCode },
      });
    }

    return {
      deviceId: device.id,
      platform: device.platform,
      credencial: origem,
      ok: result.ok,
      messageId: result.messageId,
      errorCode: result.errorCode,
      errorDetail: result.errorDetail,
    };
  });

  return {
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    skipped: 0,
    results,
  };
}

async function recordAttempt(
  groupId: string,
  deviceTokenId: string,
  customerId: string | null,
  payload: DeliverInput,
  result: PushResult,
) {
  await prisma.pushMessage.create({
    data: {
      groupId,
      deviceTokenId,
      customerId,
      title: payload.title,
      body: payload.body,
      data: (payload.data ?? {}) as any,
      kind: payload.kind ?? 'NOTIFICATION',
      status: result.ok ? 'SENT' : 'FAILED',
      fcmMessageId: result.messageId,
      errorCode: result.errorCode,
      errorDetail: result.errorDetail?.slice(0, 1000),
      reason: payload.reason ?? 'manual',
    },
  });
}

export async function listMessages(
  groupId: string,
  q: { status?: string; reason?: string; page: number; pageSize: number },
) {
  const where = tenantScope(groupId, {
    ...(q.status ? { status: q.status as any } : {}),
    ...(q.reason ? { reason: q.reason } : {}),
  });
  const [total, rows] = await Promise.all([
    prisma.pushMessage.count({ where }),
    prisma.pushMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { deviceToken: { select: { id: true, platform: true, deviceName: true } } },
    }),
  ]);
  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    data: rows.map((m) => ({
      id: m.id,
      title: m.title,
      body: m.body,
      data: m.data,
      kind: m.kind,
      status: m.status,
      reason: m.reason,
      fcmMessageId: m.fcmMessageId,
      errorCode: m.errorCode,
      errorDetail: m.errorDetail,
      device: m.deviceToken,
      customerId: m.customerId,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

// ------------------------------------------------- gatilho: queda de preço

/**
 * Avisa quem favoritou a variante que o preço caiu.
 *
 * Só queda: subiu preço não é notícia que alguém queira receber às 23h. O
 * `data` carrega o produtoId — é dele que o app monta o deep link e abre a
 * tela do produto, em vez da home.
 *
 * Nunca lança: quem chama é o PATCH do preço, e mudar o preço tem que
 * funcionar com o FCM fora do ar.
 */
export async function notifyPriceDrop(groupId: string, variantId: string, oldPrice: number, newPrice: number) {
  try {
    if (!(newPrice < oldPrice)) return;

    const variant = await prisma.productVariant.findFirst({
      where: tenantScope(groupId, { id: variantId }),
      include: { product: { select: { id: true, name: true, slug: true } } },
    });
    if (!variant) return;

    await emitEvent(prisma, groupId, 'product.price_changed', {
      variantId,
      productId: variant.product.id,
      oldPrice,
      newPrice,
    });

    const favorites = await prisma.favorite.findMany({
      where: tenantScope(groupId, { variantId }),
      select: { customerId: true },
    });
    if (favorites.length === 0) return;

    const percent = Math.round(((oldPrice - newPrice) / oldPrice) * 100);
    const payload: DeliverInput = {
      title: 'Baixou de preço 🎉',
      body: `${variant.product.name} está ${percent}% mais barato: R$ ${newPrice.toFixed(2).replace('.', ',')}`,
      data: {
        rota: 'produto',
        produtoId: variant.product.id,
        variantId,
        slug: variant.product.slug,
        precoAntigo: oldPrice,
        precoNovo: newPrice,
      },
      reason: 'price_drop',
    };

    // Um disparo por cliente favoritador (cada um pode ter vários aparelhos).
    const unique = [...new Set(favorites.map((f) => f.customerId))];
    await mapWithConcurrency(unique, env.PUSH_CONCURRENCY, async (customerId) => {
      await deliver(groupId, { customerId }, payload);
    });
  } catch (err) {
    console.error('[push] falha ao notificar queda de preço:', err);
  }
}

/** Preço atual de uma variante, para comparar antes/depois de um update. */
export async function currentPrice(groupId: string, variantId: string): Promise<number | null> {
  const v = await prisma.productVariant.findFirst({
    where: tenantScope(groupId, { id: variantId }),
    select: { price: true },
  });
  return v ? money(v.price) : null;
}

// ------------------------------------------------------------------ utils

function serializeDevice(d: {
  id: string; platform: DevicePlatform; deviceName: string | null; appVersion: string | null;
  customerId: string | null; active: boolean; disabledReason: string | null;
  token: string; lastSeenAt: Date; createdAt: Date;
}) {
  return {
    id: d.id,
    platform: d.platform,
    deviceName: d.deviceName,
    appVersion: d.appVersion,
    customerId: d.customerId,
    active: d.active,
    disabledReason: d.disabledReason,
    // O token inteiro não volta: é um endereço de entrega para aquele
    // aparelho. O suficiente para o aluno conferir qual registro é qual.
    tokenPreview: `${d.token.slice(0, 12)}…${d.token.slice(-6)}`,
    lastSeenAt: d.lastSeenAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
  };
}

/** Mesmo utilitário do relay de webhooks: paralelismo com teto. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  const queue = items.map((item, index) => ({ item, index }));
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) break;
      out[next.index] = await fn(next.item);
    }
  });
  await Promise.all(workers);
  return out;
}
