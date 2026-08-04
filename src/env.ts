import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3333),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET precisa de pelo menos 16 caracteres'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN precisa de pelo menos 16 caracteres'),
  CORS_ORIGIN: z.string().default('*'),
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
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Variáveis de ambiente inválidas:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
