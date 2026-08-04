import { createHash, randomBytes } from 'node:crypto';

/**
 * Gera uma API key no formato: sk_live_<32 chars hex>
 * Retorna a chave em texto puro (mostrada UMA vez) + o hash SHA-256 que vai no banco.
 * O prefixo é guardado à parte só para você identificar a chave no painel.
 */
export function generateApiKey() {
  const raw = randomBytes(24).toString('hex'); // 48 chars
  const key = `sk_live_${raw}`;
  return {
    key,
    hash: hashApiKey(key),
    prefix: key.slice(0, 12), // ex.: "sk_live_ab12"
  };
}

/** Hash determinístico da chave — permite buscar no banco por igualdade. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
