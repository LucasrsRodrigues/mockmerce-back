import { prisma } from '../src/prisma.js';
import { generateApiKey } from '../src/lib/apiKey.js';
import { createProduct } from '../src/modules/catalog/service.js';

async function main() {
  const existing = await prisma.group.findFirst({ where: { name: 'Grupo Demo' } });
  if (existing) {
    console.log('ℹ️  Grupo Demo já existe. Rode `npm run db:reset` para recriar do zero.');
    return;
  }

  const { key, hash, prefix } = generateApiKey();

  const group = await prisma.group.create({
    data: {
      name: 'Grupo Demo',
      apiKeyHash: hash,
      apiKeyPrefix: prefix,
      students: {
        create: [
          { rm: 'RM550001', name: 'Aluno Demo 1' },
          { rm: 'RM550002', name: 'Aluno Demo 2' },
          { rm: 'RM550003', name: 'Aluno Demo 3' },
        ],
      },
      categories: { create: [{ name: 'Eletrônicos', slug: 'eletronicos' }, { name: 'Acessórios', slug: 'acessorios' }] },
      brands: { create: [{ name: 'GamerTech', slug: 'gamertech' }] },
      collections: { create: [{ name: 'Destaques', slug: 'destaques' }] },
    },
    include: { categories: true, brands: true, collections: true },
  });

  const eletronicos = group.categories.find((c) => c.slug === 'eletronicos')!;
  const acessorios = group.categories.find((c) => c.slug === 'acessorios')!;
  const marca = group.brands[0];
  const destaques = group.collections[0];

  // --- Produtos SIMPLES (1 variante default cada) ---
  await createProduct(group.id, {
    type: 'SIMPLE', name: 'Fone Bluetooth', sku: 'FONE-001', price: 199.9, stock: 50, minStock: 5,
    description: 'Fone sem fio com cancelamento de ruído', categoryId: eletronicos.id, brandId: marca.id,
    state: 'PUBLISHED', tags: ['audio', 'wireless'], collectionIds: [destaques.id], weightGr: 200,
  });
  await createProduct(group.id, {
    type: 'SIMPLE', name: 'Smartwatch', sku: 'WATCH-001', price: 499.0, stock: 30,
    description: 'Relógio inteligente com monitor cardíaco', categoryId: eletronicos.id, brandId: marca.id,
    state: 'PUBLISHED', tags: ['wearable'],
  });
  await createProduct(group.id, {
    type: 'SIMPLE', name: 'Carregador Turbo', sku: 'CARR-001', price: 79.9, stock: 60,
    description: 'Carregador rápido 30W', categoryId: acessorios.id, state: 'PUBLISHED',
  });

  // --- Produto VARIÁVEL (Cor x Tamanho = 4 variantes) ---
  await createProduct(group.id, {
    type: 'VARIABLE', name: 'Camiseta Gamer', description: 'Camiseta 100% algodão',
    categoryId: acessorios.id, brandId: marca.id, state: 'PUBLISHED', tags: ['vestuario'],
    options: [
      { name: 'Cor', values: ['Preto', 'Branco'] },
      { name: 'Tamanho', values: ['P', 'M'] },
    ],
    variants: [
      { sku: 'CAM-PR-P', price: 79.9, stock: 10, options: { Cor: 'Preto', Tamanho: 'P' } },
      { sku: 'CAM-PR-M', price: 79.9, stock: 8, options: { Cor: 'Preto', Tamanho: 'M' } },
      { sku: 'CAM-BR-P', price: 84.9, stock: 5, options: { Cor: 'Branco', Tamanho: 'P' } },
      { sku: 'CAM-BR-M', price: 84.9, stock: 0, options: { Cor: 'Branco', Tamanho: 'M' } },
    ],
  });

  // Um produto em rascunho (não deve aparecer para o cliente final)
  await createProduct(group.id, {
    type: 'SIMPLE', name: 'Produto Secreto (rascunho)', sku: 'DRAFT-001', price: 9.9, stock: 3,
    state: 'DRAFT', categoryId: eletronicos.id,
  });

  console.log('\n✅ Seed concluído!\n');
  console.log('   Grupo Demo: 3 alunos, 4 categorias/marca/coleção, 4 produtos publicados (1 variável) + 1 rascunho.');
  console.log('   ┌───────────────────────────────────────────────────────────');
  console.log(`   │ groupId : ${group.id}`);
  console.log(`   │ API KEY : ${key}`);
  console.log('   └───────────────────────────────────────────────────────────');
  console.log('\n   Header:  X-API-Key: ' + key + '   |   X-Student-RM: RM550001\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
