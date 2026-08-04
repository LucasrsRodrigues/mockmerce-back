import { Prisma } from '@prisma/client';

/** Converte Decimal do Prisma em number para a resposta JSON. */
export function money(value: Prisma.Decimal | number): number {
  return typeof value === 'number' ? value : value.toNumber();
}
