/** Gera um slug URL-safe a partir de um texto (remove acentos, espaços → hífen). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove marcas diacríticas (acentos)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
