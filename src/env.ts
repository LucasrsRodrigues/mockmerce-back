import 'dotenv/config';
import { z } from 'zod';

/**
 * Variável OPCIONAL vinda do .env: o dotenv entrega string VAZIA (não undefined)
 * quando a linha existe mas está sem valor (FOO=""). Sem isto, `z.string().url()
 * .optional()` quebra o boot em `FOO=""` — que é justamente como deixamos as
 * variáveis não usadas no .env.example.
 */
const blankAsUndefined = (inner: z.ZodTypeAny) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3333),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET precisa de pelo menos 16 caracteres'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN precisa de pelo menos 16 caracteres'),
  /// Conta ADMIN do professor, provisionada automaticamente no boot (ver admin/bootstrap.ts).
  /// Se ambas estiverem presentes, o operador é criado/atualizado ao subir o servidor.
  PROFESSOR_EMAIL: z.string().email().optional(),
  PROFESSOR_PASSWORD: z.string().min(8).optional(),
  CORS_ORIGIN: z.string().default('*'),
  /// Origens liberadas SÓ para o control plane (/admin/*), o painel do professor.
  /// Diferente do CORS_ORIGIN geral (que fica aberto para as lojas dos alunos):
  /// aqui você restringe quem pode falar com /admin via browser cross-origin.
  /// Lista separada por vírgula. Se vazio, cai no CORS_ORIGIN geral (útil em dev).
  ADMIN_CORS_ORIGIN: z.string().optional(),
  /// Tempo (min) que uma reserva de estoque no checkout dura antes de expirar.
  RESERVATION_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  /// Tempo (min) sem atividade para um carrinho ser considerado abandonado.
  ABANDON_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  /// Máximo de tentativas de entrega de um webhook antes do dead-letter.
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /// Limite de requisições por minuto POR TENANT (X-API-Key).
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  /// DEV apenas: permite endpoints http/loopback (para testar webhook local).
  /// Em produção mantenha false — o guard anti-SSRF bloqueia interno/metadata.
  WEBHOOK_ALLOW_INSECURE_TARGETS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  // ---- Upload de mídia (S3) ----
  /// Bucket onde as imagens/vídeos das lojas são guardados. SEM ele, as rotas de
  /// upload respondem 503 UPLOAD_DISABLED (o resto da API funciona normalmente).
  S3_BUCKET: blankAsUndefined(z.string().optional()) as z.ZodType<string | undefined>,
  AWS_REGION: blankAsUndefined(z.string().default('us-east-1')) as z.ZodType<string>,
  /// Credenciais. Se omitidas, o SDK usa a cadeia padrão da AWS (role da task/EC2,
  /// ~/.aws/credentials, variáveis de ambiente) — preferível em produção.
  AWS_ACCESS_KEY_ID: blankAsUndefined(z.string().optional()) as z.ZodType<string | undefined>,
  AWS_SECRET_ACCESS_KEY: blankAsUndefined(z.string().optional()) as z.ZodType<string | undefined>,
  /// Endpoint S3 alternativo (MinIO, LocalStack, R2). Vazio = AWS.
  S3_ENDPOINT: blankAsUndefined(z.string().url().optional()) as z.ZodType<string | undefined>,
  /// Base pública das URLs devolvidas (CloudFront ou domínio próprio), SEM barra
  /// no fim. Vazio = URL direta do bucket (https://<bucket>.s3.<region>.amazonaws.com).
  S3_PUBLIC_BASE_URL: blankAsUndefined(z.string().url().optional()) as z.ZodType<string | undefined>,
  /// ACL do objeto. Buckets modernos têm ACL desabilitada e ficam públicos por
  /// bucket policy — nesse caso deixe vazio. Use "public-read" só em bucket legado.
  S3_OBJECT_ACL: blankAsUndefined(z.string().optional()) as z.ZodType<string | undefined>,
  /// Tamanho máximo de UM arquivo, em MB.
  UPLOAD_MAX_MB: z.coerce.number().int().positive().default(50),
  /// Cota total de storage POR GRUPO, em MB (anti noisy neighbor no bucket comum).
  UPLOAD_QUOTA_MB_PER_GROUP: z.coerce.number().int().positive().default(500),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Variáveis de ambiente inválidas:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
