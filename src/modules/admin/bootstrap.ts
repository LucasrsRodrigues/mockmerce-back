import { prisma } from '../../prisma.js';
import { env } from '../../env.js';
import { hashPassword, verifyPassword } from '../../lib/security.js';

/**
 * Provisiona a conta ADMIN do professor a partir do .env (PROFESSOR_EMAIL/PASSWORD).
 * Idempotente: cria se não existe; se existe, garante papel ADMIN + ativo e re-sincroniza
 * a senha caso ela tenha mudado no .env. Roda no boot do servidor (server.ts).
 */
export async function ensureProfessorOperator(log?: { info: (msg: string) => void; warn: (msg: string) => void }): Promise<void> {
  const email = env.PROFESSOR_EMAIL;
  const password = env.PROFESSOR_PASSWORD;
  if (!email || !password) return; // opcional — só provisiona se ambos definidos

  const existing = await prisma.operatorUser.findUnique({ where: { email } });

  if (!existing) {
    await prisma.operatorUser.create({ data: { email, passwordHash: await hashPassword(password), role: 'ADMIN' } });
    log?.info(`👤 Operador ADMIN do professor provisionado: ${email}`);
    return;
  }

  // Já existe: garante ADMIN + ativo, e re-sincroniza a senha se o .env mudou.
  const passwordMatches = await verifyPassword(password, existing.passwordHash);
  const needsUpdate = existing.role !== 'ADMIN' || !existing.active || !passwordMatches;
  if (needsUpdate) {
    await prisma.operatorUser.update({
      where: { email },
      data: {
        role: 'ADMIN',
        active: true,
        ...(passwordMatches ? {} : { passwordHash: await hashPassword(password) }),
      },
    });
    log?.info(`👤 Operador ADMIN do professor sincronizado: ${email}`);
  }
}
