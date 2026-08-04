import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { assertSafeWebhookUrl } from './urlGuard.js';
import { generateSigningSecret, WEBHOOK_EVENTS } from './signer.js';

function validateEvents(events?: string[]): string[] {
  if (!events || events.length === 0) return ['*'];
  for (const e of events) {
    if (e !== '*' && !WEBHOOK_EVENTS.includes(e as any)) {
      throw badRequest(`Evento desconhecido: "${e}". Veja GET /webhooks/events.`);
    }
  }
  return events;
}

/** Endpoint sem o secret (uso geral). */
function serializeEndpoint(e: any) {
  return {
    id: e.id, url: e.url, description: e.description, events: e.events,
    active: e.active, createdAt: e.createdAt.toISOString(),
  };
}

export async function createEndpoint(groupId: string, input: { url: string; description?: string; events?: string[] }) {
  await assertSafeWebhookUrl(input.url);
  const events = validateEvents(input.events);
  const signingSecret = generateSigningSecret();
  const endpoint = await prisma.webhookEndpoint.create({
    data: { groupId, url: input.url, description: input.description, events, signingSecret },
  });
  // Secret mostrado UMA vez, aqui.
  return { ...serializeEndpoint(endpoint), signingSecret };
}

export async function listEndpoints(groupId: string) {
  const endpoints = await prisma.webhookEndpoint.findMany({ where: tenantScope(groupId), orderBy: { createdAt: 'desc' } });
  return endpoints.map(serializeEndpoint);
}

export async function getEndpointOrThrow(groupId: string, id: string) {
  const e = await prisma.webhookEndpoint.findFirst({ where: tenantScope(groupId, { id }) });
  if (!e) throw notFound('Webhook não encontrado.');
  return e;
}

export async function updateEndpoint(groupId: string, id: string, input: { url?: string; description?: string; events?: string[]; active?: boolean }) {
  await getEndpointOrThrow(groupId, id);
  if (input.url) await assertSafeWebhookUrl(input.url);
  const events = input.events !== undefined ? validateEvents(input.events) : undefined;
  const updated = await prisma.webhookEndpoint.update({
    where: { id },
    data: { url: input.url, description: input.description, events, active: input.active },
  });
  return serializeEndpoint(updated);
}

export async function deleteEndpoint(groupId: string, id: string) {
  await getEndpointOrThrow(groupId, id);
  await prisma.webhookEndpoint.delete({ where: { id } });
}

export async function rotateSecret(groupId: string, id: string) {
  await getEndpointOrThrow(groupId, id);
  const signingSecret = generateSigningSecret();
  await prisma.webhookEndpoint.update({ where: { id }, data: { signingSecret } });
  return { id, signingSecret };
}

export async function listDeliveries(groupId: string, q: { endpointId?: string; status?: string; page: number; pageSize: number }) {
  const where = tenantScope(groupId, {
    ...(q.endpointId ? { endpointId: q.endpointId } : {}),
    ...(q.status ? { status: q.status as any } : {}),
  });
  const [total, deliveries] = await Promise.all([
    prisma.webhookDelivery.count({ where }),
    prisma.webhookDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
  ]);
  return {
    total, page: q.page, pageSize: q.pageSize,
    data: deliveries.map((d) => ({
      id: d.id, endpointId: d.endpointId, eventType: d.eventType, status: d.status,
      attempts: d.attempts, nextAttemptAt: d.nextAttemptAt.toISOString(),
      lastStatusCode: d.lastStatusCode, lastResponseSnippet: d.lastResponseSnippet, lastError: d.lastError,
      createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
    })),
  };
}
