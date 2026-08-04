import dns from 'node:dns/promises';
import net from 'node:net';
import { env } from '../../env.js';
import { badRequest } from '../../lib/errors.js';

/**
 * Guard anti-SSRF (secure-coding A10) para a URL de webhook fornecida pelo grupo.
 * Bloqueia destinos internos/privados/metadata e (em produção) exige HTTPS.
 *
 * Metadata da cloud (169.254.169.254) e link-local são SEMPRE bloqueados, mesmo
 * com WEBHOOK_ALLOW_INSECURE_TARGETS=true (que só libera http/loopback em dev).
 */
export async function assertSafeWebhookUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest('URL de webhook inválida.');
  }

  const insecureOk = env.WEBHOOK_ALLOW_INSECURE_TARGETS;

  if (url.protocol !== 'https:' && !(insecureOk && url.protocol === 'http:')) {
    throw badRequest('A URL de webhook deve usar HTTPS.');
  }
  if (url.username || url.password) throw badRequest('URL de webhook não pode conter credenciais.');

  const host = url.hostname;

  // Resolve o(s) IP(s) de destino e valida cada um (evita hostname → IP interno).
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      if (!insecureOk) throw badRequest('Host interno não é permitido.');
      addresses = ['127.0.0.1'];
    } else {
      try {
        const resolved = await dns.lookup(host, { all: true });
        addresses = resolved.map((r) => r.address);
      } catch {
        throw badRequest('Não foi possível resolver o host da URL de webhook.');
      }
    }
  }

  for (const ip of addresses) {
    const cls = classifyIp(ip);
    if (cls === 'metadata' || cls === 'linklocal') {
      throw badRequest('Destino bloqueado (metadata/link-local).');
    }
    if ((cls === 'loopback' || cls === 'private') && !insecureOk) {
      throw badRequest('Destino interno/privado não é permitido.');
    }
  }
}

type IpClass = 'public' | 'loopback' | 'private' | 'linklocal' | 'metadata';

function classifyIp(ip: string): IpClass {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (ip === '169.254.169.254') return 'metadata';
    if (a === 127) return 'loopback';
    if (a === 169 && b === 254) return 'linklocal';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 0 || a === 100) return 'private'; // 0.0.0.0/8, 100.64/10 CGNAT
    return 'public';
  }
  // IPv6 (checagem básica)
  const low = ip.toLowerCase();
  if (low === '::1') return 'loopback';
  if (low.startsWith('fe80')) return 'linklocal';
  if (low.startsWith('fc') || low.startsWith('fd')) return 'private'; // ULA
  if (low.startsWith('::ffff:')) return classifyIp(low.replace('::ffff:', '')); // IPv4-mapeado
  return 'public';
}
