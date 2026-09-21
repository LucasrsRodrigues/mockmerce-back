import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../env.js';

/**
 * Cifra simétrica para segredo DE TERCEIRO que precisa voltar em texto.
 *
 * A API key do grupo é guardada como HASH — ninguém precisa lê-la de volta,
 * só comparar. Já a chave privada da conta de serviço do Firebase precisa ser
 * USADA para assinar um JWT, então hash não serve. Guardar em texto puro num
 * banco multi-tenant, onde um grupo é vizinho do outro, também não.
 *
 * AES-256-GCM: cifra e autentica. Se alguém adulterar o registro no banco, o
 * decipher falha em vez de devolver lixo silenciosamente.
 *
 * A chave vem do JWT_SECRET (já obrigatório, já secreto). Consequência a
 * conhecer: trocar o JWT_SECRET torna as credenciais salvas ilegíveis — os
 * grupos recolam a chave. É o mesmo custo de rotacionar qualquer segredo, e
 * preferível a manter uma variável nova que ninguém lembra de configurar.
 */

const KEY = scryptSync(env.JWT_SECRET, 'mockmerce/secretBox/v1', 32);

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  // iv.tag.payload — tudo em base64url, numa string só, fácil de guardar.
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function open(sealed: string): string {
  const [ivB64, tagB64, dataB64] = sealed.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('segredo com formato inválido');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}
