import { money } from '../../lib/serialize.js';

/** include necessário para serializar uma variante com suas opções. */
export const variantInclude = {
  optionValues: { include: { option: true, optionValue: true } },
  images: { orderBy: { position: 'asc' } },
} as const;

/** include completo para o detalhe de um produto. */
export const productDetailInclude = {
  category: true,
  brand: true,
  tags: true,
  collections: true,
  options: { include: { values: true }, orderBy: { position: 'asc' } },
  variants: { include: variantInclude, orderBy: { isDefault: 'desc' } },
  images: { where: { variantId: null }, orderBy: { position: 'asc' } },
  relationsFrom: { include: { related: { select: { id: true, name: true, slug: true } } } },
} as const;

/** Rótulo humano da variante a partir dos valores de opção (ex.: "Preto / P"). */
export function variantLabel(variant: any): string | null {
  const parts = (variant.optionValues ?? [])
    .slice()
    .sort((a: any, b: any) => (a.option?.position ?? 0) - (b.option?.position ?? 0))
    .map((ov: any) => ov.optionValue?.value)
    .filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}

export function serializeVariant(v: any) {
  return {
    id: v.id,
    sku: v.sku,
    barcode: v.barcode,
    price: money(v.price),
    stock: v.stock,
    minStock: v.minStock,
    weightGr: v.weightGr,
    dimensionsMm: v.heightMm || v.widthMm || v.depthMm
      ? { height: v.heightMm, width: v.widthMm, depth: v.depthMm }
      : null,
    isDefault: v.isDefault,
    active: v.active,
    label: variantLabel(v),
    options: (v.optionValues ?? []).map((ov: any) => ({
      option: ov.option?.name,
      value: ov.optionValue?.value,
    })),
    images: (v.images ?? []).map(serializeImage),
  };
}

export function serializeImage(img: any) {
  return { id: img.id, url: img.url, position: img.position, isPrimary: img.isPrimary };
}

/** Faixa de preço e estoque total agregados das variantes (para a listagem). */
function aggregateVariants(variants: any[]) {
  const prices = variants.map((v) => money(v.price));
  const stock = variants.reduce((s, v) => s + v.stock, 0);
  return {
    priceFrom: prices.length ? Math.min(...prices) : 0,
    priceTo: prices.length ? Math.max(...prices) : 0,
    stock,
  };
}

/** Resumo para listagem. */
export function serializeProductSummary(p: any) {
  const agg = aggregateVariants(p.variants ?? []);
  const primary = (p.images ?? []).find((i: any) => i.isPrimary) ?? (p.images ?? [])[0];
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    type: p.type,
    state: p.state,
    brand: p.brand?.name ?? null,
    categoryId: p.categoryId,
    priceFrom: agg.priceFrom,
    priceTo: agg.priceTo,
    stock: agg.stock,
    image: primary?.url ?? null,
    variantsCount: (p.variants ?? []).length,
  };
}

/** Detalhe completo. */
export function serializeProduct(p: any) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    type: p.type,
    state: p.state,
    publishAt: p.publishAt ? p.publishAt.toISOString() : null,
    description: p.description,
    category: p.category ? { id: p.category.id, name: p.category.name } : null,
    brand: p.brand ? { id: p.brand.id, name: p.brand.name } : null,
    seo: { metaTitle: p.metaTitle, metaDescription: p.metaDescription },
    tags: (p.tags ?? []).map((t: any) => t.name),
    collections: (p.collections ?? []).map((c: any) => ({ id: c.id, name: c.name })),
    options: (p.options ?? []).map((o: any) => ({
      id: o.id,
      name: o.name,
      values: (o.values ?? []).map((v: any) => ({ id: v.id, value: v.value })),
    })),
    variants: (p.variants ?? []).map(serializeVariant),
    images: (p.images ?? []).map(serializeImage),
    related: (p.relationsFrom ?? []).map((r: any) => ({
      kind: r.kind,
      product: r.related,
    })),
    createdAt: p.createdAt?.toISOString?.() ?? p.createdAt,
  };
}
