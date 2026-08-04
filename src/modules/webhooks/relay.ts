import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { notFound } from '../../lib/errors.js';
import { env } from '../../env.js';
import { signPayload } from './signer.js';
import { getEndpointOrThrow } from './service.js';

const DELIVERY_TIMEOUT_MS = 5_000;
const CONCURRENCY = 8;

// --------------------------------------------------------- Fan-out (Outbox → deliveries)
/** Cria as entregas para cada endpoint inscrito e marca o evento como DISPATCHED. */
async function fanOut(groupId?: string): Promise<void> {
  const events = await prisma.outboxEvent.findMany({
    where: { status: 'PENDING', ...(groupId ? { groupId } : {}) },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });

  for (const ev of events) {
    const endpoints = await prisma.webhookEndpoint.findMany({ where: { groupId: ev.groupId, active: true } });
    const matching = endpoints.filter((e) => e.events.includes('*') || e.events.includes(ev.type));
    for (const ep of matching) {
      await prisma.webhookDelivery.upsert({
        where: { endpointId_outboxEventId: { endpointId: ep.id, outboxEventId: ev.id } },
        create: { groupId: ev.groupId, endpointId: ep.id, outboxEventId: ev.id, eventType: ev.type, status: 'PENDING', nextAttemptAt: new Date() },
        update: {},
      });
    }
    await prisma.outboxEvent.update({ where: { id: ev.id }, data: { status: 'DISPATCHED' } });
  }
}

// --------------------------------------------------------- Entrega (HTTP assinado)
type DeliveryWithRefs = Awaited<ReturnType<typeof loadDelivery>>;

function loadDelivery(id: string) {
  return prisma.webhookDelivery.findUnique({ where: { id }, include: { endpoint: true, outboxEvent: true } });
}

/** Backoff exponencial: 10s, 20s, 40s... capado em 5 min. */
function backoffMs(attempts: number): number {
  return Math.min(300_000, 10_000 * 2 ** (attempts - 1));
}

async function attemptDelivery(d: NonNullable<DeliveryWithRefs>): Promise<void> {
  const { endpoint, outboxEvent: ev } = d;
  const body = JSON.stringify({ id: ev.id, type: ev.type, createdAt: ev.createdAt.toISOString(), data: ev.payload });
  const timestamp = String(Date.now());
  const signature = signPayload(endpoint.signingSecret, timestamp, body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
        'X-Timestamp': timestamp,
        'X-Webhook-Event': ev.type,
        'X-Webhook-Delivery': d.id,
        'User-Agent': 'EcommerceTurma-Webhooks/1',
      },
      body,
      signal: controller.signal,
      redirect: 'manual', // não seguir redirects (anti-SSRF)
    });
    const snippet = (await res.text().catch(() => '')).slice(0, 500);
    if (res.status >= 200 && res.status < 300) {
      await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'SUCCESS', attempts: d.attempts + 1, lastStatusCode: res.status, lastResponseSnippet: snippet, lastError: null } });
    } else {
      await markFailure(d, res.status, snippet, `HTTP ${res.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? 'timeout' : err instanceof Error ? err.message : String(err);
    await markFailure(d, null, null, msg);
  } finally {
    clearTimeout(timer);
  }
}

async function markFailure(d: { id: string; attempts: number }, statusCode: number | null, snippet: string | null, error: string): Promise<void> {
  const attempts = d.attempts + 1;
  const dead = attempts >= env.WEBHOOK_MAX_ATTEMPTS;
  await prisma.webhookDelivery.update({
    where: { id: d.id },
    data: {
      status: dead ? 'DEAD_LETTER' : 'PENDING',
      attempts,
      nextAttemptAt: dead ? new Date() : new Date(Date.now() + backoffMs(attempts)),
      lastStatusCode: statusCode ?? undefined,
      lastResponseSnippet: snippet ?? undefined,
      lastError: error,
    },
  });
}

// --------------------------------------------------------- Processa entregas devidas
async function deliverDue(groupId?: string, force = false): Promise<number> {
  const deliveries = await prisma.webhookDelivery.findMany({
    where: { status: 'PENDING', ...(force ? {} : { nextAttemptAt: { lte: new Date() } }), ...(groupId ? { groupId } : {}) },
    orderBy: { nextAttemptAt: 'asc' },
    take: 100,
    include: { endpoint: true, outboxEvent: true },
  });
  await mapWithConcurrency(deliveries, CONCURRENCY, attemptDelivery);
  return deliveries.length;
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) break;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// --------------------------------------------------------- API pública do relay
/** Uma passada completa: fan-out + entrega das devidas. `force` ignora o backoff. */
export async function runRelayPass(groupId?: string, force = false): Promise<{ delivered: number }> {
  await fanOut(groupId);
  const delivered = await deliverDue(groupId, force);
  return { delivered };
}

/** Ping: entrega um evento de teste a UM endpoint (ignora a inscrição). */
export async function pingEndpoint(groupId: string, endpointId: string) {
  await getEndpointOrThrow(groupId, endpointId);
  const ev = await prisma.outboxEvent.create({ data: { groupId, type: 'webhook.ping', payload: { message: 'ping', endpointId }, status: 'DISPATCHED' } });
  const delivery = await prisma.webhookDelivery.create({ data: { groupId, endpointId, outboxEventId: ev.id, eventType: 'webhook.ping', status: 'PENDING', nextAttemptAt: new Date() } });
  const full = await loadDelivery(delivery.id);
  if (full) await attemptDelivery(full);
  return loadDelivery(delivery.id);
}

/** Reenvio manual de uma entrega. */
export async function resendDelivery(groupId: string, deliveryId: string) {
  const d = await prisma.webhookDelivery.findFirst({ where: tenantScope(groupId, { id: deliveryId }) });
  if (!d) throw notFound('Entrega não encontrada.');
  await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'PENDING', nextAttemptAt: new Date() } });
  const full = await loadDelivery(d.id);
  if (full) await attemptDelivery(full);
  return loadDelivery(d.id);
}

/** Inicia o worker periódico do relay. Retorna stop(). */
export function startWebhookRelay(intervalMs = 10_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // evita sobreposição
    running = true;
    runRelayPass().catch((err) => console.error('[relay] erro:', err)).finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
