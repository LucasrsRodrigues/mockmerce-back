import type { MediaKind } from '@prisma/client';

/**
 * Detecção do tipo REAL do arquivo pelos magic bytes (secure-coding).
 *
 * Nunca confie no `Content-Type` nem na extensão que o cliente mandou: os dois
 * são texto livre e um `.jpg` pode carregar HTML/SVG com script — que, servido
 * de um bucket público, vira XSS no domínio do storage. Aqui o arquivo só passa
 * se o conteúdo bater com um formato da allowlist; o MIME gravado no banco é o
 * que FOI DETECTADO, não o declarado.
 */
export interface SniffedType {
  mime: string;
  ext: string;
  kind: MediaKind;
}

/** Formatos aceitos. Fora desta lista, o upload é rejeitado com 415. */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'] as const;
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;

export const ACCEPTED_MIME_TYPES: readonly string[] = [...IMAGE_TYPES, ...VIDEO_TYPES];

/** Lê 4 bytes como ASCII (usado nos containers ISO-BMFF: mp4/mov/avif). */
function ascii(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, end).toString('latin1');
}

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

/**
 * Devolve o tipo detectado ou null se o formato não estiver na allowlist.
 * Só o começo do arquivo é inspecionado (os magic bytes ficam no cabeçalho).
 */
export function sniffMedia(buf: Buffer): SniffedType | null {
  if (buf.length < 12) return null;

  // --- Imagens ---
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg', kind: 'IMAGE' };
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: 'png', kind: 'IMAGE' };
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return { mime: 'image/gif', ext: 'gif', kind: 'IMAGE' };
  // WEBP = container RIFF com o marcador "WEBP" no offset 8.
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp', kind: 'IMAGE' };

  // --- Containers ISO-BMFF: "ftyp" no offset 4, marca (brand) no 8..12 ---
  if (ascii(buf, 4, 8) === 'ftyp') {
    const brand = ascii(buf, 8, 12);
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: 'avif', kind: 'IMAGE' };
    if (brand.startsWith('qt')) return { mime: 'video/quicktime', ext: 'mov', kind: 'VIDEO' };
    // isom/mp42/mp41/avc1/iso2/iso5/M4V… todos são MP4 para o que interessa aqui.
    return { mime: 'video/mp4', ext: 'mp4', kind: 'VIDEO' };
  }

  // --- WEBM/Matroska (EBML) ---
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: 'video/webm', ext: 'webm', kind: 'VIDEO' };

  return null;
}
