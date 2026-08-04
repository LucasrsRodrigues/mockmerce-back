/**
 * Backfill idempotente (f1-inventory T2): garante os 2 depósitos por grupo e um
 * StockBalance no depósito Principal para cada variante existente, semeado a
 * partir do `variant.stock` inicial. Seguro para rodar várias vezes.
 */
import { prisma } from '../src/prisma.js';
import { ensureWarehouses, ensureBalance } from '../src/modules/inventory/service.js';

async function main() {
  const groups = await prisma.group.findMany({ select: { id: true, name: true } });
  let balances = 0;
  for (const g of groups) {
    await ensureWarehouses(g.id);
    const variants = await prisma.productVariant.findMany({ where: { groupId: g.id }, select: { id: true } });
    for (const v of variants) {
      await ensureBalance(g.id, v.id);
      balances += 1;
    }
  }
  console.log(`✅ Backfill: ${groups.length} grupo(s), ${balances} saldo(s) garantido(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
