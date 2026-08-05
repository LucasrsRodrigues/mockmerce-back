#!/bin/sh
set -e

echo "▶ Aplicando migrations do banco (prisma migrate deploy)..."
npx prisma migrate deploy

# Seed opcional: defina RUN_SEED=true no ambiente para popular dados de exemplo.
if [ "$RUN_SEED" = "true" ]; then
  echo "▶ Rodando seed (RUN_SEED=true)..."
  npx tsx prisma/seed.ts
fi

echo "▶ Iniciando servidor..."
exec node dist/src/server.js
