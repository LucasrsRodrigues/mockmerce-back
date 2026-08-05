#!/bin/sh
set -e

echo "▶ Aplicando migrations do banco (prisma migrate deploy)..."
npx prisma migrate deploy

# Seed opcional: defina RUN_SEED=true no ambiente para popular dados de exemplo.
# Roda o seed COMPILADO (dist/prisma/seed.js) — o src/ cru não vai na imagem.
# Não-fatal: se o seed falhar (ex.: dados já existem), a API sobe mesmo assim.
if [ "$RUN_SEED" = "true" ]; then
  echo "▶ Rodando seed (RUN_SEED=true)..."
  node dist/prisma/seed.js || echo "⚠ Seed falhou (seguindo mesmo assim; a API sobe normalmente)."
fi

echo "▶ Iniciando servidor..."
exec node dist/src/server.js
