import { prisma } from '../../prisma.js';
import { tenantScope } from '../../lib/tenantScope.js';
import { slugify } from '../../lib/slug.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { productDetailInclude, variantLabel } from './serialize.js';

// ---------------------------------------------------------------- Visibilidade
/** Where para o cliente final: só produtos publicados e já no ar. */
export function visibleWhere(now: Date) {
  return {
    state: 'PUBLISHED' as const,
    OR: [{ publishAt: null }, { publishAt: { lte: now } }],
  };
}

// -------------------------------------------------------------------- Helpers
async function uniqueSlug(groupId: string, base: string, ignoreId?: string): Promise<string> {
  const root = slugify(base) || 'produto';
  let candidate = root;
  let n = 1;
  // Tenta root, root-2, root-3... até achar um livre no grupo.
  while (true) {
    const found = await prisma.product.findFirst({
      where: tenantScope(groupId, { slug: candidate, ...(ignoreId ? { id: { not: ignoreId } } : {}) }),
      select: { id: true },
    });
    if (!found) return candidate;
    n += 1;
    candidate = `${root}-${n}`;
  }
}

async function assertRefsBelongToGroup(groupId: string, input: {
  categoryId?: string; brandId?: string; collectionIds?: string[]; relatedIds?: string[];
}) {
  if (input.categoryId) {
    const c = await prisma.category.findFirst({ where: tenantScope(groupId, { id: input.categoryId }), select: { id: true } });
    if (!c) throw badRequest('categoryId não pertence a este grupo.');
  }
  if (input.brandId) {
    const b = await prisma.brand.findFirst({ where: tenantScope(groupId, { id: input.brandId }), select: { id: true } });
    if (!b) throw badRequest('brandId não pertence a este grupo.');
  }
  if (input.collectionIds?.length) {
    const n = await prisma.collection.count({ where: tenantScope(groupId, { id: { in: input.collectionIds } }) });
    if (n !== input.collectionIds.length) throw badRequest('Alguma coleção não pertence a este grupo.');
  }
  if (input.relatedIds?.length) {
    const n = await prisma.product.count({ where: tenantScope(groupId, { id: { in: input.relatedIds } }) });
    if (n !== input.relatedIds.length) throw badRequest('Algum produto relacionado não pertence a este grupo.');
  }
}

/** Upsert de tags por nome (dentro do grupo); retorna os ids para conectar. */
async function resolveTagIds(groupId: string, names?: string[]): Promise<string[]> {
  if (!names?.length) return [];
  const ids: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const tag = await prisma.tag.upsert({
      where: { groupId_name: { groupId, name } },
      create: { groupId, name },
      update: {},
      select: { id: true },
    });
    ids.push(tag.id);
  }
  return ids;
}

async function assertSkusFree(groupId: string, skus: string[]) {
  const dup = await prisma.productVariant.findFirst({
    where: tenantScope(groupId, { sku: { in: skus } }),
    select: { sku: true },
  });
  if (dup) throw conflict(`Já existe uma variante com o SKU "${dup.sku}" neste grupo.`);
}

// ------------------------------------------------------------------- Tipos in
interface VariantInput {
  sku: string; price: number; stock?: number; minStock?: number; barcode?: string;
  weightGr?: number; heightMm?: number; widthMm?: number; depthMm?: number;
  options?: Record<string, string>; // { "Cor": "Preto", "Tamanho": "P" }
}
interface OptionInput { name: string; values: string[] }
export interface CreateProductInput {
  type?: 'SIMPLE' | 'VARIABLE';
  name: string; description?: string; slug?: string;
  categoryId?: string; brandId?: string; tags?: string[]; collectionIds?: string[];
  state?: 'DRAFT' | 'PUBLISHED' | 'HIDDEN'; publishAt?: string;
  metaTitle?: string; metaDescription?: string;
  // simples:
  sku?: string; price?: number; stock?: number; minStock?: number; barcode?: string;
  weightGr?: number; heightMm?: number; widthMm?: number; depthMm?: number;
  // variável:
  options?: OptionInput[]; variants?: VariantInput[];
}

// ------------------------------------------------------------- Criar produto
export async function createProduct(groupId: string, input: CreateProductInput) {
  const type = input.type ?? 'SIMPLE';
  await assertRefsBelongToGroup(groupId, input);

  const slug = input.slug
    ? await ensureProvidedSlugFree(groupId, input.slug)
    : await uniqueSlug(groupId, input.name);

  const base = {
    groupId,
    name: input.name,
    description: input.description ?? '',
    slug,
    type,
    state: input.state ?? 'DRAFT',
    publishAt: input.publishAt ? new Date(input.publishAt) : null,
    categoryId: input.categoryId,
    brandId: input.brandId,
    metaTitle: input.metaTitle,
    metaDescription: input.metaDescription,
  };

  if (type === 'SIMPLE') {
    if (!input.sku || input.price == null) throw badRequest('Produto SIMPLE exige sku e price.');
    await assertSkusFree(groupId, [input.sku]);
    const tagIds = await resolveTagIds(groupId, input.tags);
    const product = await prisma.product.create({
      data: {
        ...base,
        tags: { connect: tagIds.map((id) => ({ id })) },
        collections: input.collectionIds?.length ? { connect: input.collectionIds.map((id) => ({ id })) } : undefined,
        variants: {
          create: [{
            groupId, sku: input.sku, barcode: input.barcode, price: input.price,
            stock: input.stock ?? 0, minStock: input.minStock ?? 0,
            weightGr: input.weightGr, heightMm: input.heightMm, widthMm: input.widthMm, depthMm: input.depthMm,
            isDefault: true,
          }],
        },
      },
      include: productDetailInclude,
    });
    return product;
  }

  // VARIABLE
  if (!input.options?.length || !input.variants?.length) {
    throw badRequest('Produto VARIABLE exige options e variants.');
  }
  validateVariableInput(input.options, input.variants);
  await assertSkusFree(groupId, input.variants.map((v) => v.sku));
  const tagIds = await resolveTagIds(groupId, input.tags);

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        ...base,
        tags: { connect: tagIds.map((id) => ({ id })) },
        collections: input.collectionIds?.length ? { connect: input.collectionIds.map((id) => ({ id })) } : undefined,
        options: {
          create: input.options!.map((o, i) => ({
            name: o.name,
            position: i,
            values: { create: o.values.map((value) => ({ value })) },
          })),
        },
      },
      include: { options: { include: { values: true } } },
    });

    // Mapas nome-da-opção -> optionId e (optionId,valor) -> optionValueId
    const optionByName = new Map(product.options.map((o) => [o.name, o]));

    for (const v of input.variants!) {
      const variant = await tx.productVariant.create({
        data: {
          groupId, productId: product.id, sku: v.sku, barcode: v.barcode, price: v.price,
          stock: v.stock ?? 0, minStock: v.minStock ?? 0,
          weightGr: v.weightGr, heightMm: v.heightMm, widthMm: v.widthMm, depthMm: v.depthMm,
          isDefault: false,
        },
      });
      for (const [optName, valName] of Object.entries(v.options ?? {})) {
        const opt = optionByName.get(optName);
        const optVal = opt?.values.find((val) => val.value === valName);
        if (!opt || !optVal) throw badRequest(`Variante com opção inválida: ${optName}=${valName}.`);
        await tx.variantOptionValue.create({
          data: { variantId: variant.id, optionId: opt.id, optionValueId: optVal.id },
        });
      }
    }

    return tx.product.findUniqueOrThrow({ where: { id: product.id }, include: productDetailInclude });
  });
}

async function ensureProvidedSlugFree(groupId: string, slug: string): Promise<string> {
  const s = slugify(slug);
  const found = await prisma.product.findFirst({ where: tenantScope(groupId, { slug: s }), select: { id: true } });
  if (found) throw conflict(`Já existe um produto com o slug "${s}" neste grupo.`);
  return s;
}

/** Rejeita combinações duplicadas de opção entre as variantes de um produto variável. */
function validateVariableInput(options: OptionInput[], variants: VariantInput[]) {
  if (options.length > 3) throw badRequest('Máximo de 3 opções por produto.');
  for (const o of options) {
    if (o.values.length > 50) throw badRequest(`Opção "${o.name}" excede 50 valores.`);
  }
  const seen = new Set<string>();
  for (const v of variants) {
    const key = options.map((o) => `${o.name}=${v.options?.[o.name] ?? ''}`).join('|');
    if (seen.has(key)) throw conflict(`Combinação de variante duplicada: ${key}.`);
    seen.add(key);
  }
}

// --------------------------------------------------------------- Consultas
export async function getProductForCaller(groupId: string, id: string, customerView: boolean) {
  const where = customerView
    ? tenantScope(groupId, { id, ...visibleWhere(new Date()) })
    : tenantScope(groupId, { id });
  const product = await prisma.product.findFirst({ where, include: productDetailInclude });
  if (!product) throw notFound('Produto não encontrado.');
  return product;
}

// --------------------------------------------------------------- Delete
export async function deleteProduct(groupId: string, id: string) {
  const product = await prisma.product.findFirst({ where: tenantScope(groupId, { id }), select: { id: true } });
  if (!product) throw notFound('Produto não encontrado.');
  await prisma.product.delete({ where: { id } });
}

export { variantLabel };
