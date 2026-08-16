import { prisma } from '../../prisma.js';
import { INDIVIDUAL_BADGES } from './badges.js';

/**
 * Catálogo declarativo de missões e badges (policy as data — DDD domain service).
 * Cada missão tem um CRITÉRIO verificável por EVIDÊNCIA (RequestLog + estado).
 * Adicionar uma missão = adicionar uma definição aqui, sem reescrever lógica.
 */
export const BADGES = [
  { key: 'primeiros-passos', name: 'Primeiros Passos', icon: '🌱', description: 'Cadastrou o primeiro produto' },
  { key: 'primeira-venda', name: 'Primeira Venda', icon: '💰', description: 'Completou uma compra ponta a ponta' },
  { key: 'integrador', name: 'Integrador', icon: '🔌', description: 'Recebeu um webhook com sucesso' },
  { key: 'lojista-completo', name: 'Lojista Completo', icon: '🏆', description: 'Cumpriu todas as missões da Fase 1' },
];

export interface MissionDef {
  key: string; title: string; description: string; phase: string; points: number; weight?: number; badgeKey?: string;
  criteria:
    | { type: 'request'; method: string; path: string }
    | { type: 'flow'; steps: { method: string; path: string }[] }
    | { type: 'state'; check: string };
}

export const MISSIONS: MissionDef[] = [
  { key: 'cadastrou-produto', title: 'Cadastrar um produto', description: 'Fazer POST em /products com sucesso.', phase: 'F1', points: 10, badgeKey: 'primeiros-passos', criteria: { type: 'request', method: 'POST', path: '/products' } },
  { key: 'criou-produto-variavel', title: 'Criar um produto variável', description: 'Cadastrar um produto com variações (ex.: cor/tamanho).', phase: 'F1', points: 15, criteria: { type: 'state', check: 'has_variable_product' } },
  { key: 'cadastrou-cliente', title: 'Cadastrar um cliente final', description: 'POST /auth/register com sucesso.', phase: 'F1', points: 10, criteria: { type: 'request', method: 'POST', path: '/auth/register' } },
  { key: 'usou-carrinho', title: 'Usar o carrinho', description: 'Adicionar um item ao carrinho.', phase: 'F1', points: 5, criteria: { type: 'request', method: 'POST', path: '/cart/items' } },
  { key: 'compra-completa', title: 'Compra ponta a ponta', description: 'Checkout seguido de pagamento aprovado.', phase: 'F1', points: 20, badgeKey: 'primeira-venda', criteria: { type: 'flow', steps: [{ method: 'POST', path: '/orders/checkout' }, { method: 'POST', path: '/pay' }] } },
  { key: 'gerenciou-estoque', title: 'Gerenciar estoque', description: 'Registrar uma entrada de estoque.', phase: 'F1', points: 10, criteria: { type: 'state', check: 'stock_received' } },
  { key: 'cotou-frete', title: 'Cotar frete', description: 'Usar a cotação de frete (sandbox).', phase: 'F1', points: 10, criteria: { type: 'request', method: 'POST', path: '/sandbox/shipping/quote' } },
  { key: 'configurou-webhook', title: 'Configurar um webhook', description: 'Registrar um endpoint de webhook.', phase: 'F1', points: 10, criteria: { type: 'request', method: 'POST', path: '/webhooks' } },
  { key: 'recebeu-webhook', title: 'Receber um webhook', description: 'Ter uma entrega de webhook com sucesso.', phase: 'F1', points: 25, badgeKey: 'integrador', criteria: { type: 'state', check: 'webhook_delivered' } },
  { key: 'tratou-recusa', title: 'Tratar pagamento recusado', description: 'Exercitar o caminho de pagamento recusado.', phase: 'F1', points: 15, criteria: { type: 'state', check: 'payment_declined' } },
  { key: 'emitiu-nfe', title: 'Emitir NF-e', description: 'Gerar a nota fiscal de um pedido.', phase: 'F2', points: 10, criteria: { type: 'request', method: 'GET', path: '/invoice' } },
  { key: 'reembolsou-pedido', title: 'Reembolsar um pedido', description: 'Reembolsar um pedido pago (reverte estoque).', phase: 'F2', points: 15, criteria: { type: 'state', check: 'order_refunded' } },
];

/** Checagens de estado (evidência no banco). Puras em relação ao grupo. */
export const STATE_CHECKS: Record<string, (groupId: string) => Promise<boolean>> = {
  has_variable_product: async (g) => (await prisma.product.count({ where: { groupId: g, type: 'VARIABLE' } })) > 0,
  stock_received: async (g) => (await prisma.stockMovement.count({ where: { groupId: g, type: 'RECEIVE' } })) > 0,
  webhook_delivered: async (g) => (await prisma.webhookDelivery.count({ where: { groupId: g, status: 'SUCCESS' } })) > 0,
  payment_declined: async (g) => (await prisma.outboxEvent.count({ where: { groupId: g, type: 'payment.declined' } })) > 0,
  order_refunded: async (g) => (await prisma.order.count({ where: { groupId: g, status: 'REFUNDED' } })) > 0,
};

/** Sincroniza o registro (badges + missões) no banco. Idempotente. */
export async function syncRegistry(): Promise<void> {
  // Badges de GRUPO (concedidas por missão com badgeKey).
  for (const b of BADGES) {
    await prisma.badge.upsert({
      where: { key: b.key },
      create: { ...b, scope: 'GROUP' },
      update: { name: b.name, icon: b.icon, description: b.description, scope: 'GROUP' },
    });
  }
  // Badges INDIVIDUAIS (por RM), com tier + critério.
  for (const b of INDIVIDUAL_BADGES) {
    await prisma.badge.upsert({
      where: { key: b.key },
      create: { key: b.key, name: b.name, icon: b.icon, description: b.description, tier: b.tier, scope: 'INDIVIDUAL', criteria: b.criteria as any },
      update: { name: b.name, icon: b.icon, description: b.description, tier: b.tier, scope: 'INDIVIDUAL', criteria: b.criteria as any },
    });
  }
  for (const m of MISSIONS) {
    await prisma.mission.upsert({
      where: { key: m.key },
      create: { key: m.key, title: m.title, description: m.description, phase: m.phase, points: m.points, weight: m.weight ?? 1, badgeKey: m.badgeKey, criteria: m.criteria as any },
      update: { title: m.title, description: m.description, phase: m.phase, points: m.points, badgeKey: m.badgeKey, criteria: m.criteria as any, active: true },
    });
  }
}
