import { prisma } from '../../prisma.js';
import { seal, open } from '../../lib/secretBox.js';
import { envCredentials, parseServiceAccount, verifyCredentials, type FcmCredentials } from '../../lib/push.js';
import { notFound } from '../../lib/errors.js';

/**
 * De quem é a credencial usada num envio.
 *
 * Um token do FCM pertence ao PROJETO Firebase que o emitiu (o mesmo que
 * gerou o google-services.json do app). Enviar com a credencial de outro
 * projeto devolve SENDER_ID_MISMATCH — o aparelho está certo, a configuração
 * é que não bate. Por isso a credencial é resolvida por grupo, e não global.
 */
export type CredentialSource = 'group' | 'server';

export interface ResolvedCredentials {
  cred: FcmCredentials;
  source: CredentialSource;
}

/** A do grupo, se existir; senão a do servidor; senão null. */
export async function resolveCredentials(groupId: string): Promise<ResolvedCredentials | null> {
  const row = await prisma.groupPushConfig.findUnique({ where: { groupId } });
  if (row) {
    try {
      return {
        source: 'group',
        cred: { projectId: row.projectId, clientEmail: row.clientEmail, privateKey: open(row.privateKeyEnc) },
      };
    } catch (err) {
      // Só acontece se o JWT_SECRET mudou depois de salvar. Cair no servidor
      // silenciosamente seria pior: o aluno mandaria para o projeto errado e
      // levaria SENDER_ID_MISMATCH sem entender por quê.
      console.error(`[push] credencial do grupo ${groupId} ilegível:`, (err as Error).message);
      return null;
    }
  }
  const fallback = envCredentials();
  return fallback ? { source: 'server', cred: fallback } : null;
}

/** Salva (ou substitui) a credencial do grupo, já testando contra o Google. */
export async function saveGroupCredentials(groupId: string, serviceAccount: string) {
  const cred = parseServiceAccount(serviceAccount);
  const check = await verifyCredentials(cred);

  const row = await prisma.groupPushConfig.upsert({
    where: { groupId },
    create: {
      groupId,
      projectId: cred.projectId,
      clientEmail: cred.clientEmail,
      privateKeyEnc: seal(cred.privateKey),
      lastCheckAt: new Date(),
      lastCheckOk: check.ok,
      lastCheckMsg: check.message,
    },
    update: {
      projectId: cred.projectId,
      clientEmail: cred.clientEmail,
      privateKeyEnc: seal(cred.privateKey),
      lastCheckAt: new Date(),
      lastCheckOk: check.ok,
      lastCheckMsg: check.message,
    },
  });

  // Chave que não autentica é salva do mesmo jeito: o aluno precisa ver o que
  // colou e o motivo da recusa lado a lado para consertar. O que não pode é
  // ele achar que deu certo — por isso o `check` volta na resposta.
  return { config: serializeConfig(row), check };
}

export async function getGroupConfig(groupId: string) {
  const row = await prisma.groupPushConfig.findUnique({ where: { groupId } });
  return row ? serializeConfig(row) : null;
}

export async function deleteGroupConfig(groupId: string) {
  const { count } = await prisma.groupPushConfig.deleteMany({ where: { groupId } });
  if (count === 0) throw notFound('Esta loja não tem credencial de push registrada.');
}

/** Refaz o handshake e guarda o resultado. */
export async function recheckGroupConfig(groupId: string) {
  const row = await prisma.groupPushConfig.findUnique({ where: { groupId } });
  if (!row) throw notFound('Esta loja não tem credencial de push registrada.');

  let check: { ok: boolean; message: string };
  try {
    check = await verifyCredentials({
      projectId: row.projectId,
      clientEmail: row.clientEmail,
      privateKey: open(row.privateKeyEnc),
    });
  } catch (err) {
    check = { ok: false, message: `credencial ilegível: ${(err as Error).message}` };
  }

  const updated = await prisma.groupPushConfig.update({
    where: { groupId },
    data: { lastCheckAt: new Date(), lastCheckOk: check.ok, lastCheckMsg: check.message },
  });
  return { config: serializeConfig(updated), check };
}

/** A chave privada nunca sai daqui — nem cifrada, nem truncada. */
function serializeConfig(row: {
  projectId: string; clientEmail: string;
  lastCheckAt: Date | null; lastCheckOk: boolean | null; lastCheckMsg: string | null;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    projectId: row.projectId,
    clientEmail: row.clientEmail,
    lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
    lastCheckOk: row.lastCheckOk,
    lastCheckMsg: row.lastCheckMsg,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
