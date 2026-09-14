import { randomBytes } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../env.js';
import { serviceUnavailable } from './errors.js';
import { slugify } from './slug.js';

/**
 * Camada de storage (S3). O resto do código NÃO conhece o SDK da AWS: fala só
 * com `putObject` / `deleteObject` / `publicUrlFor`. Isso mantém a regra de
 * negócio independente da infra (clean-architecture) e permite trocar o
 * provedor (MinIO, R2, CloudFront na frente) só mexendo no .env.
 *
 * O upload é OPCIONAL: sem S3_BUCKET a API inteira continua funcionando e só as
 * rotas de mídia respondem 503 UPLOAD_DISABLED.
 */

let client: S3Client | null = null;

/** True quando há bucket configurado (upload habilitado). */
export function storageEnabled(): boolean {
  return Boolean(env.S3_BUCKET);
}

/** Garante que o upload está configurado; senão, 503 com mensagem acionável. */
export function requireStorage(): void {
  if (!storageEnabled()) {
    throw serviceUnavailable(
      'UPLOAD_DISABLED',
      'Upload de arquivos não está configurado neste ambiente (falta S3_BUCKET). Fale com o professor.',
    );
  }
}

/** Cliente S3 preguiçoso (só é criado no primeiro upload). */
function s3(): S3Client {
  if (client) return client;
  client = new S3Client({
    region: env.AWS_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    // Sem chaves no .env, o SDK usa a cadeia padrão (role da task/EC2, ~/.aws).
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } }
      : {}),
  });
  return client;
}

/** Nome de pasta seguro: reaproveita o slugify do catálogo e limita o tamanho. */
function safeSegment(value: string, max = 40): string {
  return slugify(value).slice(0, max);
}

/**
 * Monta a chave do objeto: `groups/<groupId>/<pasta>/<ano>/<mês>/<aleatório>.<ext>`.
 *
 * O nome do arquivo é SEMPRE gerado aqui (nunca o que o cliente mandou): evita
 * path traversal ("../"), colisão entre grupos e nome adivinhável. O prefixo por
 * grupo é o que permite dar permissão/limpar/medir storage por tenant.
 */
export function buildObjectKey(groupId: string, ext: string, folder?: string | null): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dir = folder ? safeSegment(folder) : '';
  const rand = randomBytes(12).toString('hex');
  return ['groups', groupId, dir, String(yyyy), mm, `${rand}.${ext}`].filter(Boolean).join('/');
}

/** URL pública final do objeto (CDN quando S3_PUBLIC_BASE_URL estiver setado). */
export function publicUrlFor(key: string): string {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  if (env.S3_PUBLIC_BASE_URL) return `${env.S3_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${encoded}`;
  if (env.S3_ENDPOINT) return `${env.S3_ENDPOINT.replace(/\/+$/, '')}/${env.S3_BUCKET}/${encoded}`;
  return `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${encoded}`;
}

/** Envia o objeto e devolve a URL pública. */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<string> {
  requireStorage();
  await s3().send(new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    // O nome do objeto é único e imutável → cache agressivo é seguro e barato.
    CacheControl: 'public, max-age=31536000, immutable',
    // Buckets modernos têm ACL desabilitada (acesso público via bucket policy).
    // Só mandamos ACL se o .env pedir explicitamente (bucket legado).
    ...(env.S3_OBJECT_ACL ? { ACL: env.S3_OBJECT_ACL as any } : {}),
  }));
  return publicUrlFor(key);
}

/** Remove o objeto do bucket. Best-effort: S3 não reclama se já não existir. */
export async function deleteObject(key: string): Promise<void> {
  requireStorage();
  await s3().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}
