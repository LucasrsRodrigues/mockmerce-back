import { createHmac, randomBytes } from 'node:crypto';

/** Gera um signing secret (mostrado 1x). Formato whsec_<hex>. */
export function generateSigningSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

/**
 * Assinatura HMAC-SHA256 sobre `${timestamp}.${body}` (esquema tipo Stripe).
 * O consumidor recomputa com o mesmo secret e compara em tempo constante.
 * Retorna o valor do header X-Signature (ex.: "sha256=abc123...").
 */
export function signPayload(secret: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `sha256=${mac}`;
}

/** Catálogo de tipos de evento que o backend emite. */
export const WEBHOOK_EVENTS = [
  'order.created',
  'order.paid',
  'order.cancelled',
  'order.refunded',
  'product.low_stock',
  'product.price_changed',
  'payment.approved',
  'payment.declined',
  'shipment.updated',
  'cart.abandoned',
  'review.created',
  'webhook.ping',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];
