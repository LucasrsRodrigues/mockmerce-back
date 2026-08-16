import { prisma } from '../../prisma.js';

/**
 * Catálogo de badges INDIVIDUAIS (por aluno/RM). Policy as data, como as missões.
 * Cada badge tem um CRITÉRIO verificável por evidência POR RM (RequestLog.rm,
 * XpLedger.rm, MissionProgress.byRm). Famílias em tiers dão progresso mensurável.
 * As badges de GRUPO continuam em missions.ts (BADGES) — estas convivem com aquelas.
 */
export type BadgeTier = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM';

export type IndividualCriteria =
  /// Nº de requisições bem-sucedidas do RM (opcionalmente filtradas por método/rota).
  | { type: 'req_count'; gte: number; method?: string; path?: string }
  /// Nº de rotas DISTINTAS que o RM acessou com sucesso.
  | { type: 'distinct_paths'; gte: number }
  /// XP individual acumulado pelo RM.
  | { type: 'xp'; gte: number }
  /// Nº de missões cuja conclusão foi creditada a este RM (byRm).
  | { type: 'mission_credits'; gte: number };

export interface IndividualBadgeDef {
  key: string;
  name: string;
  icon: string; // emoji/glifo no centro do medalhão
  description: string;
  tier: BadgeTier;
  criteria: IndividualCriteria;
}

export const INDIVIDUAL_BADGES: IndividualBadgeDef[] = [
  // Marco de entrada
  { key: 'ind-primeiros-passos', name: 'Primeiros Passos', icon: '🌱', tier: 'BRONZE', description: 'Fez sua primeira chamada bem-sucedida à API.', criteria: { type: 'req_count', gte: 1 } },

  // Família Trabalhador — volume de requisições do RM
  { key: 'ind-trabalhador-1', name: 'Trabalhador', icon: '🛠️', tier: 'BRONZE', description: 'Fez 25 requisições bem-sucedidas.', criteria: { type: 'req_count', gte: 25 } },
  { key: 'ind-trabalhador-2', name: 'Trabalhador de Prata', icon: '🛠️', tier: 'SILVER', description: 'Fez 100 requisições bem-sucedidas.', criteria: { type: 'req_count', gte: 100 } },
  { key: 'ind-trabalhador-3', name: 'Trabalhador de Ouro', icon: '🛠️', tier: 'GOLD', description: 'Fez 500 requisições bem-sucedidas.', criteria: { type: 'req_count', gte: 500 } },

  // Família Explorador — rotas distintas usadas
  { key: 'ind-explorador-1', name: 'Explorador', icon: '🧭', tier: 'BRONZE', description: 'Usou 5 endpoints diferentes.', criteria: { type: 'distinct_paths', gte: 5 } },
  { key: 'ind-explorador-2', name: 'Explorador de Prata', icon: '🧭', tier: 'SILVER', description: 'Usou 15 endpoints diferentes.', criteria: { type: 'distinct_paths', gte: 15 } },
  { key: 'ind-explorador-3', name: 'Explorador de Ouro', icon: '🧭', tier: 'GOLD', description: 'Usou 30 endpoints diferentes.', criteria: { type: 'distinct_paths', gte: 30 } },

  // Família Pontuador — XP individual
  { key: 'ind-pontuador-1', name: 'Pontuador', icon: '⭐', tier: 'BRONZE', description: 'Acumulou 50 XP.', criteria: { type: 'xp', gte: 50 } },
  { key: 'ind-pontuador-2', name: 'Pontuador de Prata', icon: '⭐', tier: 'SILVER', description: 'Acumulou 150 XP.', criteria: { type: 'xp', gte: 150 } },
  { key: 'ind-pontuador-3', name: 'Pontuador de Ouro', icon: '⭐', tier: 'PLATINUM', description: 'Acumulou 400 XP.', criteria: { type: 'xp', gte: 400 } },

  // Marcos de comportamento
  { key: 'ind-vendedor', name: 'Vendedor', icon: '💰', tier: 'SILVER', description: 'Fechou uma venda (checkout com sucesso).', criteria: { type: 'req_count', gte: 1, method: 'POST', path: '/orders/checkout' } },
  { key: 'ind-integrador', name: 'Integrador', icon: '🔌', tier: 'GOLD', description: 'Registrou um webhook.', criteria: { type: 'req_count', gte: 1, method: 'POST', path: '/webhooks' } },

  // Família Missionário — missões creditadas ao RM
  { key: 'ind-missionario-1', name: 'Missionário', icon: '🎯', tier: 'SILVER', description: 'Concluiu 3 missões.', criteria: { type: 'mission_credits', gte: 3 } },
  { key: 'ind-missionario-2', name: 'Missionário de Ouro', icon: '🎯', tier: 'GOLD', description: 'Concluiu 6 missões.', criteria: { type: 'mission_credits', gte: 6 } },
];

const succeeded = { statusCode: { gte: 200, lt: 300 } };

/** Progresso do RM em um critério: {current, target}. Escopo = grupo atual do aluno. */
export async function evalIndividualProgress(
  groupId: string,
  rm: string,
  c: IndividualCriteria,
): Promise<{ current: number; target: number }> {
  if (c.type === 'req_count') {
    const where: Record<string, unknown> = { groupId, rm, ...succeeded };
    if (c.method) where.method = c.method;
    if (c.path) where.path = { contains: c.path };
    return { current: await prisma.requestLog.count({ where }), target: c.gte };
  }
  if (c.type === 'distinct_paths') {
    const rows = await prisma.requestLog.findMany({ where: { groupId, rm, ...succeeded }, distinct: ['path'], select: { path: true } });
    return { current: rows.length, target: c.gte };
  }
  if (c.type === 'xp') {
    const agg = await prisma.xpLedger.aggregate({ where: { groupId, rm }, _sum: { points: true } });
    return { current: agg._sum.points ?? 0, target: c.gte };
  }
  // mission_credits
  return { current: await prisma.missionProgress.count({ where: { groupId, met: true, byRm: rm } }), target: c.gte };
}
