import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { notFound } from '../../lib/errors.js';

const adminSec = [{ adminToken: [] }];

/**
 * PERFIL DE AUTORIA — control plane, read-only.
 *
 * Cruza o RequestLog (quem chamou, quando, com que status) com a lista de alunos
 * do grupo para montar a leitura de PROCESSO que a entrega final não mostra:
 * quem rodou o app, ao longo de quantos dias, e em que ordem cada fluxo do CP1
 * começou a funcionar.
 *
 * Para que serve: preparar a arguição. Os `sinais` são PERGUNTAS a fazer, não
 * veredito — o log mostra quem RODOU, não quem ESCREVEU (nada impede um aluno
 * rodar com o RM do colega), e só enxerga o que toca a API. Vale como cruzamento
 * com o histórico do Git, não sozinho.
 */

/** Marcos do CP1: os fluxos que o app precisa acertar, na ordem em que se constrói. */
const MILESTONE_LABELS: Record<string, string> = {
  catalogo: 'Listagem de produtos',
  detalhe: 'Detalhe de produto',
  cadastro: 'Cadastro de conta',
  login: 'Login do comprador',
  sessao: 'Validação de sessão (/auth/me)',
  favoritos: 'Favoritar',
  carrinho: 'Adicionar ao carrinho',
  checkout: 'Fechar pedido',
  pagamento: 'Pagar pedido',
};
const MILESTONE_ORDER = Object.keys(MILESTONE_LABELS);

/**
 * Classifica um RequestLog num marco. O path é gravado SEM query string e COM o
 * prefixo /v1 (rewriteUrl), por isso o casamento é por regex de sufixo.
 */
const MARCO = Prisma.sql`
  CASE
    WHEN method = 'GET'  AND path ~ '/products$'                THEN 'catalogo'
    WHEN method = 'GET'  AND path ~ '/products/[^/]+$'          THEN 'detalhe'
    WHEN method = 'POST' AND path ~ '/auth/register$'           THEN 'cadastro'
    WHEN method = 'POST' AND path ~ '/auth/login$'              THEN 'login'
    WHEN method = 'GET'  AND path ~ '/auth/me$'                 THEN 'sessao'
    WHEN method = 'POST' AND path ~ '/customers/me/favorites$'  THEN 'favoritos'
    WHEN method = 'POST' AND path ~ '/cart/items$'              THEN 'carrinho'
    WHEN method = 'POST' AND path ~ '/orders/checkout$'         THEN 'checkout'
    WHEN method = 'POST' AND path ~ '/orders/[^/]+/pay$'        THEN 'pagamento'
  END`;

interface Sinal {
  codigo: string;
  severidade: 'alta' | 'media' | 'baixa';
  texto: string;
}

/** Métricas cruas de um grupo, já agregadas pelo banco. */
interface Perfil {
  total: number;
  semRm: number;
  erros4xx: number;
  diasAtivos: number;
  primeira: Date | null;
  ultima: Date | null;
  ultimas24h: number;
}

const pct = (parte: number, todo: number) => (todo > 0 ? Number((parte / todo).toFixed(4)) : 0);
const emPorcento = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Traduz as métricas em sinais legíveis. Cada regra existe porque distingue
 * construção incremental de entrega que aparece pronta.
 */
function calcularSinais(
  perfil: Perfil,
  porRm: { rm: string; requisicoes: number }[],
  alunosSemAtividade: { rm: string }[],
  marcosSemErro: string[],
): Sinal[] {
  const sinais: Sinal[] = [];
  const { total } = perfil;

  // Concentração: um RM sozinho respondendo por quase tudo.
  const topo = porRm[0];
  if (topo && porRm.length > 1) {
    const share = pct(topo.requisicoes, total);
    if (share >= 0.8) {
      sinais.push({
        codigo: 'concentracao',
        severidade: 'alta',
        texto: `O RM ${topo.rm} concentra ${emPorcento(share)} das chamadas do grupo.`,
      });
    }
  }

  if (alunosSemAtividade.length > 0) {
    sinais.push({
      codigo: 'integrante_sem_atividade',
      severidade: 'alta',
      texto: `${alunosSemAtividade.length} integrante(s) sem nenhuma chamada: ${alunosSemAtividade.map((a) => a.rm).join(', ')}.`,
    });
  }

  // Janela curta: projeto de três semanas que só existe em dois dias.
  if (total > 0 && perfil.diasAtivos <= 2) {
    sinais.push({
      codigo: 'janela_curta',
      severidade: 'alta',
      texto: `Atividade concentrada em apenas ${perfil.diasAtivos} dia(s).`,
    });
  }

  const share24h = pct(perfil.ultimas24h, total);
  if (total > 20 && share24h >= 0.7) {
    sinais.push({
      codigo: 'ultima_hora',
      severidade: 'media',
      texto: `${emPorcento(share24h)} das chamadas caíram nas últimas 24h da janela.`,
    });
  }

  // Trajetória sem tentativa e erro. Quem constrói erra: 401 antes do token,
  // variantId trocado por productId, 422 no estoque.
  const taxa4xx = pct(perfil.erros4xx, total);
  if (total > 50 && taxa4xx <= 0.02) {
    sinais.push({
      codigo: 'sem_erros',
      severidade: 'media',
      texto: `Só ${emPorcento(taxa4xx)} de erros 4xx em ${total} chamadas — quase nenhuma tentativa e erro.`,
    });
  }

  if (marcosSemErro.length >= 3) {
    sinais.push({
      codigo: 'marcos_de_primeira',
      severidade: 'media',
      texto: `Acertaram de primeira, sem erro anterior: ${MILESTONE_ORDER.filter((m) => marcosSemErro.includes(m)).map((m) => MILESTONE_LABELS[m]).join(', ')}.`,
    });
  }

  if (perfil.semRm > 0) {
    sinais.push({
      codigo: 'sem_rm',
      severidade: 'baixa',
      texto: `${perfil.semRm} chamada(s) sem o header X-Student-RM — não dá para atribuir a ninguém.`,
    });
  }

  if (total === 0) {
    sinais.push({
      codigo: 'sem_atividade',
      severidade: 'alta',
      texto: 'Nenhuma chamada registrada no período.',
    });
  }

  return sinais;
}

export async function adminAuthorshipRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAdmin);

  // =====================================================================
  // VISÃO DA TURMA — uma linha por grupo, para varrer antes das arguições
  // =====================================================================
  app.get('/admin/authorship', {
    preHandler: app.requirePermission('activity:read'),
    schema: {
      tags: ['Admin'],
      summary: 'Perfil de autoria da turma (uma linha por grupo)',
      description:
        'Cruza RequestLog x alunos para mostrar COMO cada grupo trabalhou: quantos ' +
        'integrantes rodaram, em quantos dias, com que taxa de erro. Os `sinais` são ' +
        'perguntas para a arguição, não veredito.',
      security: adminSec,
      querystring: {
        type: 'object',
        properties: { days: { type: 'integer', minimum: 1, maximum: 180, default: 30 } },
      },
    },
  }, async (req) => {
    const days = (req.query as { days?: number }).days ?? 30;
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (days - 1));

    const [grupos, perfis, porRmRaw, marcosRaw] = await Promise.all([
      prisma.group.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, active: true, students: { select: { rm: true, name: true } } },
      }),
      prisma.$queryRaw<(Perfil & { groupId: string })[]>(Prisma.sql`
        SELECT "groupId",
               count(*)::int                                                   AS total,
               count(*) FILTER (WHERE rm IS NULL)::int                          AS "semRm",
               count(*) FILTER (WHERE "statusCode" BETWEEN 400 AND 499)::int    AS "erros4xx",
               count(DISTINCT date_trunc('day', "createdAt"))::int              AS "diasAtivos",
               min("createdAt")                                                 AS primeira,
               max("createdAt")                                                 AS ultima,
               count(*) FILTER (
                 WHERE "createdAt" > (SELECT max(i."createdAt") FROM "RequestLog" i
                                      WHERE i."groupId" = o."groupId") - interval '24 hours'
               )::int                                                           AS "ultimas24h"
        FROM "RequestLog" o
        WHERE "groupId" IS NOT NULL AND "createdAt" >= ${since}
        GROUP BY "groupId"`),
      prisma.$queryRaw<{ groupId: string; rm: string; requisicoes: number }[]>(Prisma.sql`
        SELECT "groupId", rm, count(*)::int AS requisicoes
        FROM "RequestLog"
        WHERE "groupId" IS NOT NULL AND rm IS NOT NULL AND "createdAt" >= ${since}
        GROUP BY "groupId", rm
        ORDER BY requisicoes DESC`),
      // Todo marco que chegou a funcionar, marcando os que vieram sem nenhum 4xx antes.
      prisma.$queryRaw<{ groupId: string; marco: string; semErroAntes: boolean }[]>(Prisma.sql`
        WITH marcado AS (
          SELECT "groupId", ${MARCO} AS marco, "statusCode", "createdAt"
          FROM "RequestLog"
          WHERE "groupId" IS NOT NULL AND "createdAt" >= ${since}
        ), ok AS (
          SELECT "groupId", marco, min("createdAt") AS em
          FROM marcado WHERE marco IS NOT NULL AND "statusCode" < 300
          GROUP BY "groupId", marco
        )
        SELECT ok."groupId", ok.marco,
               NOT EXISTS (
                 SELECT 1 FROM marcado m
                 WHERE m."groupId" = ok."groupId" AND m.marco = ok.marco
                   AND m."statusCode" >= 400 AND m."createdAt" < ok.em
               ) AS "semErroAntes"
        FROM ok`),
    ]);

    const perfilPorGrupo = new Map(perfis.map((p) => [p.groupId, p]));
    const rmPorGrupo = new Map<string, { rm: string; requisicoes: number }[]>();
    for (const r of porRmRaw) {
      const lista = rmPorGrupo.get(r.groupId) ?? [];
      lista.push({ rm: r.rm, requisicoes: r.requisicoes });
      rmPorGrupo.set(r.groupId, lista);
    }
    // Dois recortes: quais marcos funcionaram, e quais funcionaram de primeira.
    const marcosPorGrupo = new Map<string, string[]>();
    const semErroPorGrupo = new Map<string, string[]>();
    for (const m of marcosRaw) {
      marcosPorGrupo.set(m.groupId, [...(marcosPorGrupo.get(m.groupId) ?? []), m.marco]);
      if (m.semErroAntes) semErroPorGrupo.set(m.groupId, [...(semErroPorGrupo.get(m.groupId) ?? []), m.marco]);
    }

    const vazio: Perfil = { total: 0, semRm: 0, erros4xx: 0, diasAtivos: 0, primeira: null, ultima: null, ultimas24h: 0 };

    const linhas = grupos.map((g) => {
      const perfil = perfilPorGrupo.get(g.id) ?? vazio;
      const porRm = rmPorGrupo.get(g.id) ?? [];
      const ativos = new Set(porRm.map((r) => r.rm));
      const semAtividade = g.students.filter((s) => !ativos.has(s.rm));
      const cumpridos = marcosPorGrupo.get(g.id) ?? [];
      const semErro = semErroPorGrupo.get(g.id) ?? [];

      return {
        groupId: g.id,
        grupo: g.name,
        ativo: g.active,
        integrantes: g.students.length,
        integrantesQueRodaram: ativos.size,
        requisicoes: perfil.total,
        diasAtivos: perfil.diasAtivos,
        primeiraAtividade: perfil.primeira?.toISOString() ?? null,
        ultimaAtividade: perfil.ultima?.toISOString() ?? null,
        taxaErro4xx: pct(perfil.erros4xx, perfil.total),
        concentracaoTopRm: pct(porRm[0]?.requisicoes ?? 0, perfil.total),
        marcosCumpridos: cumpridos.length,
        marcosTotal: MILESTONE_ORDER.length,
        marcosDePrimeira: semErro.length,
        sinais: calcularSinais(perfil, porRm, semAtividade, semErro),
      };
    });

    return {
      janela: { desde: since.toISOString(), dias: days },
      grupos: linhas.sort((a, b) => b.sinais.length - a.sinais.length || a.grupo.localeCompare(b.grupo)),
      legenda: 'Os sinais apontam o que perguntar na arguição. O log mostra quem RODOU, não quem ESCREVEU — cruze com o histórico do Git.',
    };
  });

  // =====================================================================
  // PERFIL DE UM GRUPO — a folha que se lê antes de arguir
  // =====================================================================
  app.get('/admin/groups/:id/authorship', {
    preHandler: app.requirePermission('activity:read'),
    schema: {
      tags: ['Admin'],
      summary: 'Perfil de autoria de um grupo (por RM, por dia e por marco do CP1)',
      description:
        'A folha de arguição: participação por integrante, linha do tempo diária e, para ' +
        'cada fluxo do CP1, quando começou a funcionar e quantos erros vieram antes.',
      security: adminSec,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: { days: { type: 'integer', minimum: 1, maximum: 180, default: 30 } },
      },
    },
  }, async (req) => {
    const { id: groupId } = req.params as { id: string };
    const days = (req.query as { days?: number }).days ?? 30;
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (days - 1));

    const grupo = await prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true, name: true, active: true, students: { select: { rm: true, name: true }, orderBy: { rm: 'asc' } } },
    });
    if (!grupo) throw notFound('Grupo não encontrado.');

    const [perfilRaw, porRmRaw, porDiaRaw, statusRaw, marcosRaw] = await Promise.all([
      prisma.$queryRaw<Perfil[]>(Prisma.sql`
        SELECT count(*)::int                                                AS total,
               count(*) FILTER (WHERE rm IS NULL)::int                       AS "semRm",
               count(*) FILTER (WHERE "statusCode" BETWEEN 400 AND 499)::int AS "erros4xx",
               count(DISTINCT date_trunc('day', "createdAt"))::int           AS "diasAtivos",
               min("createdAt")                                              AS primeira,
               max("createdAt")                                              AS ultima,
               count(*) FILTER (
                 WHERE "createdAt" > (SELECT max(i."createdAt") FROM "RequestLog" i
                                      WHERE i."groupId" = ${groupId}) - interval '24 hours'
               )::int                                                        AS "ultimas24h"
        FROM "RequestLog"
        WHERE "groupId" = ${groupId} AND "createdAt" >= ${since}`),
      prisma.$queryRaw<{ rm: string; requisicoes: number; erros4xx: number; diasAtivos: number; primeira: Date; ultima: Date }[]>(Prisma.sql`
        SELECT rm,
               count(*)::int                                                 AS requisicoes,
               count(*) FILTER (WHERE "statusCode" BETWEEN 400 AND 499)::int AS "erros4xx",
               count(DISTINCT date_trunc('day', "createdAt"))::int           AS "diasAtivos",
               min("createdAt")                                              AS primeira,
               max("createdAt")                                              AS ultima
        FROM "RequestLog"
        WHERE "groupId" = ${groupId} AND rm IS NOT NULL AND "createdAt" >= ${since}
        GROUP BY rm ORDER BY requisicoes DESC`),
      prisma.$queryRaw<{ dia: Date; rm: string; total: number }[]>(Prisma.sql`
        SELECT date_trunc('day', "createdAt")::date AS dia,
               COALESCE(rm, '(sem RM)')             AS rm,
               count(*)::int                        AS total
        FROM "RequestLog"
        WHERE "groupId" = ${groupId} AND "createdAt" >= ${since}
        GROUP BY dia, rm ORDER BY dia ASC`),
      prisma.$queryRaw<{ statusCode: number; total: number }[]>(Prisma.sql`
        SELECT "statusCode", count(*)::int AS total
        FROM "RequestLog"
        WHERE "groupId" = ${groupId} AND "statusCode" >= 400 AND "createdAt" >= ${since}
        GROUP BY "statusCode" ORDER BY total DESC`),
      // Por marco: primeiro erro, primeiro sucesso, quem acertou e quantos erros antes.
      prisma.$queryRaw<{
        marco: string; primeiroErro: Date | null; primeiroSucesso: Date | null;
        rmQueAcertou: string | null; errosAntes: number; tentativas: number;
      }[]>(Prisma.sql`
        WITH marcado AS (
          SELECT ${MARCO} AS marco, "statusCode", "createdAt", rm
          FROM "RequestLog"
          WHERE "groupId" = ${groupId} AND "createdAt" >= ${since}
        ), ok AS (
          SELECT marco, min("createdAt") AS em
          FROM marcado WHERE marco IS NOT NULL AND "statusCode" < 300
          GROUP BY marco
        )
        SELECT m.marco,
               min(m."createdAt") FILTER (WHERE m."statusCode" >= 400)            AS "primeiroErro",
               ok.em                                                              AS "primeiroSucesso",
               (SELECT x.rm FROM marcado x
                 WHERE x.marco = m.marco AND x."statusCode" < 300
                 ORDER BY x."createdAt" LIMIT 1)                                  AS "rmQueAcertou",
               count(*) FILTER (
                 WHERE m."statusCode" >= 400 AND (ok.em IS NULL OR m."createdAt" < ok.em)
               )::int                                                             AS "errosAntes",
               count(*)::int                                                      AS tentativas
        FROM marcado m LEFT JOIN ok ON ok.marco = m.marco
        WHERE m.marco IS NOT NULL
        GROUP BY m.marco, ok.em`),
    ]);

    const perfil = perfilRaw[0] ?? { total: 0, semRm: 0, erros4xx: 0, diasAtivos: 0, primeira: null, ultima: null, ultimas24h: 0 };
    const nomePorRm = new Map(grupo.students.map((s) => [s.rm, s.name]));
    const ativos = new Set(porRmRaw.map((r) => r.rm));
    const semAtividade = grupo.students.filter((s) => !ativos.has(s.rm));

    // Linha do tempo: um item por dia, com a quebra por RM.
    const porDiaMap = new Map<string, { date: string; total: number; porRm: { rm: string; total: number }[] }>();
    for (const linha of porDiaRaw) {
      const date = linha.dia.toISOString().slice(0, 10);
      const dia = porDiaMap.get(date) ?? { date, total: 0, porRm: [] };
      dia.total += linha.total;
      dia.porRm.push({ rm: linha.rm, total: linha.total });
      porDiaMap.set(date, dia);
    }

    const marcoPorChave = new Map(marcosRaw.map((m) => [m.marco, m]));
    const marcos = MILESTONE_ORDER.map((chave) => {
      const m = marcoPorChave.get(chave);
      return {
        marco: chave,
        label: MILESTONE_LABELS[chave],
        tentativas: m?.tentativas ?? 0,
        errosAntes: m?.errosAntes ?? 0,
        primeiroErro: m?.primeiroErro?.toISOString() ?? null,
        primeiroSucesso: m?.primeiroSucesso?.toISOString() ?? null,
        rmQueAcertou: m?.rmQueAcertou ?? null,
        nomeQueAcertou: m?.rmQueAcertou ? nomePorRm.get(m.rmQueAcertou) ?? null : null,
        status: !m ? 'nunca_tentado' : m.primeiroSucesso ? 'funcionou' : 'só_erro',
      };
    });

    const marcosSemErro = marcos.filter((m) => m.primeiroSucesso && m.errosAntes === 0).map((m) => m.marco);

    return {
      grupo: { id: grupo.id, nome: grupo.name, ativo: grupo.active },
      janela: {
        desde: since.toISOString(),
        dias: days,
        primeiraAtividade: perfil.primeira?.toISOString() ?? null,
        ultimaAtividade: perfil.ultima?.toISOString() ?? null,
        diasAtivos: perfil.diasAtivos,
      },
      resumo: {
        requisicoes: perfil.total,
        semRm: perfil.semRm,
        erros4xx: perfil.erros4xx,
        taxaErro4xx: pct(perfil.erros4xx, perfil.total),
        pctUltimas24h: pct(perfil.ultimas24h, perfil.total),
      },
      porIntegrante: [
        ...porRmRaw.map((r) => ({
          rm: r.rm,
          nome: nomePorRm.get(r.rm) ?? '(RM não cadastrado neste grupo)',
          requisicoes: r.requisicoes,
          participacao: pct(r.requisicoes, perfil.total),
          erros4xx: r.erros4xx,
          diasAtivos: r.diasAtivos,
          primeiraAtividade: r.primeira.toISOString(),
          ultimaAtividade: r.ultima.toISOString(),
        })),
        ...semAtividade.map((s) => ({
          rm: s.rm, nome: s.name, requisicoes: 0, participacao: 0,
          erros4xx: 0, diasAtivos: 0, primeiraAtividade: null, ultimaAtividade: null,
        })),
      ],
      porDia: [...porDiaMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      errosPorStatus: statusRaw.map((s) => ({ status: s.statusCode, total: s.total })),
      marcos,
      sinais: calcularSinais(perfil, porRmRaw.map((r) => ({ rm: r.rm, requisicoes: r.requisicoes })), semAtividade, marcosSemErro),
      legenda: 'Perfil de PROCESSO, para preparar a arguição. Mostra quem rodou o app, não quem escreveu o código — cruze com o histórico do Git antes de concluir qualquer coisa.',
    };
  });
}
