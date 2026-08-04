import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { MISSIONS, STATE_CHECKS, syncRegistry } from './missions.js';

interface EvalResult { met: boolean; byRm: string | null; evidence: Record<string, unknown> }

const succeeded = { statusCode: { gte: 200, lt: 300 } };

// ------------------------------------------------------------- Avaliador (puro de leitura)
async function evalRequest(groupId: string, c: any): Promise<EvalResult> {
  const log = await prisma.requestLog.findFirst({
    where: { groupId, method: c.method, path: { contains: c.path }, ...succeeded },
    orderBy: { createdAt: 'asc' },
    select: { id: true, rm: true, path: true, createdAt: true },
  });
  return log ? { met: true, byRm: log.rm ?? null, evidence: { logId: log.id, path: log.path, at: log.createdAt.toISOString() } } : { met: false, byRm: null, evidence: {} };
}

async function evalFlow(groupId: string, c: any): Promise<EvalResult> {
  let lastRm: string | null = null;
  const found: string[] = [];
  for (const step of c.steps) {
    const log = await prisma.requestLog.findFirst({
      where: { groupId, method: step.method, path: { contains: step.path }, ...succeeded },
      orderBy: { createdAt: 'asc' }, select: { id: true, rm: true, path: true },
    });
    if (!log) return { met: false, byRm: null, evidence: { missing: `${step.method} ${step.path}` } };
    found.push(log.path);
    lastRm = log.rm ?? lastRm;
  }
  return { met: true, byRm: lastRm, evidence: { steps: found } };
}

async function evalState(groupId: string, c: any): Promise<EvalResult> {
  const check = STATE_CHECKS[c.check];
  const met = check ? await check(groupId) : false;
  return { met, byRm: null, evidence: { check: c.check } };
}

async function evaluate(groupId: string, criteria: any): Promise<EvalResult> {
  if (criteria.type === 'request') return evalRequest(groupId, criteria);
  if (criteria.type === 'flow') return evalFlow(groupId, criteria);
  if (criteria.type === 'state') return evalState(groupId, criteria);
  return { met: false, byRm: null, evidence: {} };
}

// ------------------------------------------------------------- Avaliação do grupo (idempotente)
let registrySynced = false;

export async function evaluateGroup(groupId: string): Promise<void> {
  if (!registrySynced) { await syncRegistry(); registrySynced = true; }
  const missions = await prisma.mission.findMany({ where: { active: true } });

  for (const mission of missions) {
    const existing = await prisma.missionProgress.findUnique({ where: { groupId_missionId: { groupId, missionId: mission.id } } });
    if (existing?.met) continue; // já creditado — idempotente

    const res = await evaluate(groupId, mission.criteria);

    if (!res.met) {
      await prisma.missionProgress.upsert({
        where: { groupId_missionId: { groupId, missionId: mission.id } },
        create: { groupId, missionId: mission.id, met: false, evidence: {} },
        update: {},
      });
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.missionProgress.upsert({
        where: { groupId_missionId: { groupId, missionId: mission.id } },
        create: { groupId, missionId: mission.id, met: true, byRm: res.byRm, evidence: res.evidence as any, metAt: new Date() },
        update: { met: true, byRm: res.byRm, evidence: res.evidence as any, metAt: new Date() },
      });
      await tx.xpLedger.upsert({
        where: { groupId_missionId: { groupId, missionId: mission.id } },
        create: { groupId, missionId: mission.id, rm: res.byRm, points: mission.points },
        update: {},
      });
      if (mission.badgeKey) {
        const badge = await tx.badge.findUnique({ where: { key: mission.badgeKey }, select: { id: true } });
        if (badge) await tx.groupBadge.upsert({ where: { groupId_badgeId: { groupId, badgeId: badge.id } }, create: { groupId, badgeId: badge.id }, update: {} });
      }
    });
  }
}

// ------------------------------------------------------------- Nota + XP
async function computeGrade(groupId: string): Promise<number> {
  const missions = await prisma.mission.findMany({ where: { active: true }, select: { id: true, points: true } });
  const totalPoints = missions.reduce((s, m) => s + m.points, 0) || 1;
  const met = await prisma.missionProgress.findMany({ where: tenantScope(groupId, { met: true }), select: { missionId: true } });
  const metIds = new Set(met.map((m) => m.missionId));
  const metPoints = missions.filter((m) => metIds.has(m.id)).reduce((s, m) => s + m.points, 0);
  return Number(((metPoints / totalPoints) * 10).toFixed(1));
}

async function groupXp(groupId: string): Promise<number> {
  const agg = await prisma.xpLedger.aggregate({ where: { groupId }, _sum: { points: true } });
  return agg._sum.points ?? 0;
}

// ------------------------------------------------------------- Dashboard do grupo
export async function dashboard(groupId: string) {
  await evaluateGroup(groupId); // auto-avalia (fica sempre fresco)

  const missions = await prisma.mission.findMany({ where: { active: true }, orderBy: [{ phase: 'asc' }, { points: 'asc' }] });
  const progress = await prisma.missionProgress.findMany({ where: tenantScope(groupId) });
  const pmap = new Map(progress.map((p) => [p.missionId, p]));

  const missionList = missions.map((m) => {
    const p = pmap.get(m.id);
    return { key: m.key, title: m.title, description: m.description, phase: m.phase, points: m.points, cumprida: p?.met ?? false, porRm: p?.byRm ?? null };
  });

  const badges = await prisma.groupBadge.findMany({ where: { groupId }, include: { badge: true } });
  const xpByRm = await prisma.xpLedger.groupBy({ by: ['rm'], where: { groupId, rm: { not: null } }, _sum: { points: true } });
  const students = await prisma.student.findMany({ where: { groupId }, select: { rm: true, name: true } });
  const nameByRm = new Map(students.map((s) => [s.rm, s.name]));

  return {
    xp: await groupXp(groupId),
    nota: await computeGrade(groupId),
    badges: badges.map((b) => ({ key: b.badge.key, name: b.badge.name, icon: b.badge.icon })),
    xpPorAluno: xpByRm.map((r) => ({ rm: r.rm, nome: nameByRm.get(r.rm!) ?? '(RM não cadastrado)', xp: r._sum.points ?? 0 })).sort((a, b) => b.xp - a.xp),
    missoes: { cumpridas: missionList.filter((m) => m.cumprida).length, total: missionList.length, lista: missionList },
    proximosPassos: missionList.filter((m) => !m.cumprida).map((m) => `${m.title} — ${m.description} (${m.points} XP)`),
  };
}

// ------------------------------------------------------------- Ranking
export async function ranking(includeOptedOut: boolean) {
  const groups = await prisma.group.findMany({ select: { id: true, name: true, teachingSettings: { select: { rankingOptOut: true } } } });
  const rows = [];
  for (const g of groups) {
    const optedOut = g.teachingSettings?.rankingOptOut ?? false;
    if (optedOut && !includeOptedOut) continue;
    rows.push({ grupo: g.name, groupId: g.id, xp: await groupXp(g.id), optOut: optedOut });
  }
  return rows.sort((a, b) => b.xp - a.xp).map((r, i) => ({ posicao: i + 1, ...r }));
}

// ------------------------------------------------------------- Enviar para correção
export async function submit(groupId: string, rm: string | null) {
  await evaluateGroup(groupId);
  const grade = await computeGrade(groupId);
  const progress = await prisma.missionProgress.findMany({ where: tenantScope(groupId, { met: true }), include: { mission: { select: { key: true, title: true, points: true } } } });
  const snapshot = {
    grade, xp: await groupXp(groupId),
    missoesCumpridas: progress.map((p) => ({ key: p.mission.key, title: p.mission.title, points: p.mission.points, porRm: p.byRm, evidencia: p.evidence })),
  };
  const s = await prisma.submission.create({ data: { groupId, snapshot: snapshot as any, grade, submittedByRm: rm } });
  return { submissionId: s.id, grade, enviadoEm: s.createdAt.toISOString(), missoesCumpridas: progress.length };
}

// ------------------------------------------------------------- Visão da turma (professor)
export async function classView() {
  if (!registrySynced) { await syncRegistry(); registrySynced = true; }
  const groups = await prisma.group.findMany({ select: { id: true, name: true } });
  const porGrupo = [];
  for (const g of groups) {
    const met = await prisma.missionProgress.count({ where: { groupId: g.id, met: true } });
    porGrupo.push({ grupo: g.name, groupId: g.id, xp: await groupXp(g.id), nota: await computeGrade(g.id), missoesCumpridas: met });
  }
  const byRm = await prisma.xpLedger.groupBy({ by: ['rm'], where: { rm: { not: null } }, _sum: { points: true } });
  const students = await prisma.student.findMany({ select: { rm: true, name: true, group: { select: { name: true } } } });
  const smap = new Map(students.map((s) => [s.rm, s]));

  return {
    porGrupo: porGrupo.sort((a, b) => b.xp - a.xp),
    porAluno: byRm.map((r) => ({ rm: r.rm, nome: smap.get(r.rm!)?.name ?? '(RM não cadastrado)', grupo: smap.get(r.rm!)?.group.name ?? null, xp: r._sum.points ?? 0 })).sort((a, b) => b.xp - a.xp),
  };
}

export async function evaluateAllGroups(): Promise<number> {
  const groups = await prisma.group.findMany({ select: { id: true } });
  for (const g of groups) await evaluateGroup(g.id);
  return groups.length;
}
