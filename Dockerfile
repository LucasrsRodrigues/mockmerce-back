# syntax=docker/dockerfile:1

# ============================================================================
# Backend e-commerce (Fastify + Prisma). Imagem multi-stage.
#   Stage 1 (build):   instala deps, gera o Prisma Client e compila o TypeScript.
#   Stage 2 (runtime): imagem enxuta só com o necessário para rodar em produção.
# No boot, o entrypoint roda `prisma migrate deploy` e sobe o servidor.
# ============================================================================

# ---------- Stage 1: build ----------
FROM node:20-slim AS build
WORKDIR /app

# OpenSSL é exigido pelo engine do Prisma.
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Instala dependências a partir do lockfile (cache eficiente).
COPY package.json package-lock.json ./
RUN npm ci

# Código-fonte + schema. Gera o client e compila (tsc -> dist/).
COPY . .
RUN npx prisma generate && npm run build

# ---------- Stage 2: runtime ----------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Reaproveita node_modules do build (já inclui o Prisma Client gerado e o CLI
# do Prisma, usado pelo migrate deploy no entrypoint).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Porta HTTP da API (PORT no .env; ajuste no EasyPanel se mudar).
EXPOSE 3333

CMD ["./docker-entrypoint.sh"]
