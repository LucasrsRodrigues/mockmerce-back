import type { MediaAsset } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { env } from '../../env.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { badRequest, conflict, notFound, payloadTooLarge, unprocessable, unsupportedMedia } from '../../lib/errors.js';
import { ACCEPTED_MIME_TYPES, sniffMedia } from '../../lib/fileType.js';
import { buildObjectKey, deleteObject, putObject, requireStorage } from '../../lib/storage.js';

const MB = 1024 * 1024;

/** Arquivo já lido do multipart (ver readMultipart em media/routes.ts). */
export interface UploadedFile {
  buffer: Buffer;
  filename?: string;
  /** true quando o arquivo estourou o limite e veio cortado. */
  truncated: boolean;
}

/** Formato de saída da mídia (o que o app/painel do aluno consome). */
export function serializeMedia(m: MediaAsset) {
  return {
    id: m.id,
    kind: m.kind,
    url: m.url,
    mimeType: m.mimeType,
    sizeBytes: m.sizeBytes,
    originalName: m.originalName,
    folder: m.folder,
    uploadedByRm: m.uploadedByRm,
    createdAt: m.createdAt.toISOString(),
  };
}

/** Nome original só para exibição: sem caminho e sem caracteres de controle. */
function displayName(filename: string | undefined): string | null {
  if (!filename) return null;
  const base = filename.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean ? clean.slice(0, 120) : null;
}

/** Quanto o grupo já ocupa no bucket e qual é o teto. */
export async function storageUsage(groupId: string) {
  const [agg, count] = await Promise.all([
    prisma.mediaAsset.aggregate({ where: tenantScope(groupId), _sum: { sizeBytes: true } }),
    prisma.mediaAsset.count({ where: tenantScope(groupId) }),
  ]);
  const usedBytes = agg._sum.sizeBytes ?? 0;
  const quotaBytes = env.UPLOAD_QUOTA_MB_PER_GROUP * MB;
  return {
    files: count,
    usedBytes,
    quotaBytes,
    availableBytes: Math.max(0, quotaBytes - usedBytes),
    usedPercent: Math.round((usedBytes / quotaBytes) * 10000) / 100,
    maxFileBytes: env.UPLOAD_MAX_MB * MB,
    acceptedMimeTypes: ACCEPTED_MIME_TYPES,
  };
}

/**
 * Recebe UM arquivo do multipart, valida e sobe para o S3.
 *
 * Ordem das checagens (secure-coding): existe arquivo → cabe no limite → o
 * conteúdo é mesmo de um formato aceito → o grupo tem cota. Só depois o objeto
 * vai para o bucket; e o registro no banco só nasce se o PUT deu certo, para
 * não deixar linha apontando para arquivo inexistente.
 */
export async function uploadMedia(params: {
  groupId: string;
  rm: string | null | undefined;
  file: UploadedFile | undefined;
  folder?: string | null;
}): Promise<MediaAsset> {
  requireStorage();
  const { groupId, file } = params;
  if (!file) throw badRequest('Envie o arquivo no campo "file" (multipart/form-data).');

  const { buffer } = file;
  // O @fastify/multipart marca truncated quando o arquivo estourou o fileSize
  // (registramos o plugin com throwFileSizeLimit:false justamente para cair
  // aqui e devolver uma mensagem clara, com o limite, em vez do erro cru).
  if (file.truncated) {
    throw payloadTooLarge(`Arquivo maior que o limite de ${env.UPLOAD_MAX_MB} MB por arquivo.`);
  }
  if (buffer.length === 0) throw badRequest('Arquivo vazio.');

  // O MIME declarado pelo cliente é ignorado: vale o que os bytes dizem.
  const sniffed = sniffMedia(buffer);
  if (!sniffed) {
    throw unsupportedMedia(`Formato não suportado. Aceitos: ${ACCEPTED_MIME_TYPES.join(', ')}.`);
  }

  const usage = await storageUsage(groupId);
  if (buffer.length > usage.availableBytes) {
    throw unprocessable(
      `Cota de armazenamento da loja esgotada (${env.UPLOAD_QUOTA_MB_PER_GROUP} MB). Apague arquivos em /v1/media para liberar espaço.`,
    );
  }

  const key = buildObjectKey(groupId, sniffed.ext, params.folder);
  const url = await putObject(key, buffer, sniffed.mime);

  return prisma.mediaAsset.create({
    data: {
      groupId,
      kind: sniffed.kind,
      key,
      url,
      mimeType: sniffed.mime,
      sizeBytes: buffer.length,
      originalName: displayName(file.filename),
      folder: params.folder ?? null,
      uploadedByRm: params.rm ?? null,
    },
  });
}

/** Busca uma mídia DO GRUPO (ADR-G2: nunca sem o filtro de tenant). */
export async function getMedia(groupId: string, id: string): Promise<MediaAsset> {
  const media = await prisma.mediaAsset.findFirst({ where: tenantScope(groupId, { id }) });
  if (!media) throw notFound('Mídia não encontrada.');
  return media;
}

/**
 * Apaga a mídia do bucket e do banco. Se ela estiver em uso por algum produto,
 * exige `force` — assim o aluno não some com a foto do produto sem perceber.
 * Com force, o cascade do banco remove os vínculos junto.
 */
export async function deleteMedia(groupId: string, id: string, force: boolean) {
  const media = await getMedia(groupId, id);
  const inUse = await prisma.productImage.count({ where: { mediaId: id } });
  if (inUse > 0 && !force) {
    throw conflict(`Esta mídia está em uso por ${inUse} produto(s)/variante(s). Use ?force=true para apagar mesmo assim.`);
  }
  // Primeiro o bucket: se o banco caísse antes, sobraria lixo pago no S3.
  await deleteObject(media.key);
  await prisma.mediaAsset.delete({ where: { id: media.id } });
  return { deleted: true, unlinkedFrom: inUse };
}
