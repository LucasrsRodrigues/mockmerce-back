# Deploy na nuvem — para o professor

Para os grupos consumirem a API pela internet (e você auditar tudo em um só lugar),
suba **uma** instância na nuvem. Abaixo, o caminho mais simples com **Render**
(tem plano gratuito e Postgres gerenciado). Railway e Fly.io funcionam de forma parecida.

---

## Opção A — Render (recomendada, tem free tier)

### 1. Suba o código para um repositório Git (GitHub/GitLab)

```bash
git init && git add . && git commit -m "Backend e-commerce da turma"
git remote add origin <seu-repo> && git push -u origin main
```

> O `.gitignore` já ignora `.env` e `node_modules`. **Nunca** suba o `.env`.

### 2. Crie o banco Postgres

No painel do Render → **New → PostgreSQL**. Copie a **Internal Database URL**.

### 3. Crie o Web Service

**New → Web Service**, aponte para o repositório e configure:

| Campo | Valor |
|---|---|
| Runtime | Node |
| Build Command | `npm install && npm run build && npm run prisma:deploy` |
| Start Command | `npm start` |

### 4. Variáveis de ambiente (aba *Environment*)

| Variável | Valor |
|---|---|
| `DATABASE_URL` | a Internal Database URL do passo 2 |
| `JWT_SECRET` | uma string longa e aleatória |
| `ADMIN_TOKEN` | **seu** token secreto de admin |
| `NODE_ENV` | `production` |
| `CORS_ORIGIN` | `*` (ou as URLs dos apps dos grupos) |

> `PORT` e `HOST` o Render define sozinho — o servidor já respeita a env `PORT`.

### 5. Deploy e teste

Depois do deploy, a URL fica tipo `https://ecommerce-turma.onrender.com`.

```bash
curl https://ecommerce-turma.onrender.com/health          # { "status": "ok" }
# abra a doc: https://ecommerce-turma.onrender.com/docs
```

### 6. (uma vez) Popular dados ou criar grupos

O `prisma:deploy` do build já cria as tabelas. Para criar os grupos, use os
endpoints de admin (veja o [README](../README.md#fluxo-do-professor)) apontando
para a URL de produção.

---

## Opção B — Docker (VPS própria, ou qualquer lugar com Docker)

Já existe um `docker-compose.yml` para o Postgres. Para servir a **API** também via
container, adicione um `Dockerfile` (exemplo abaixo) e um serviço no compose.

```dockerfile
# Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build
EXPOSE 3333
CMD ["sh", "-c", "npm run prisma:deploy && npm start"]
```

---

## Boas práticas para a avaliação

- **Um `ADMIN_TOKEN` só seu.** É o que separa você dos alunos. Não compartilhe.
- **Uma API key por grupo.** Gere no ato da entrega e anote qual grupo recebeu qual.
- **Peça que usem o `X-Student-RM` correto.** É o seu rastro de participação individual.
- **Antes de avaliar**, rode `GET /admin/activity` para ver a distribuição de trabalho
  por grupo e por RM.
- Se um grupo vazar a chave, use `POST /admin/groups/:id/rotate-key` para trocá-la.
- Faça um **backup** do banco antes da correção final (no Render, snapshot do Postgres).

---

## Solução de problemas

| Sintoma | Causa provável / correção |
|---|---|
| `Variáveis de ambiente inválidas` no start | Falta `DATABASE_URL`, `JWT_SECRET` ou `ADMIN_TOKEN` |
| `Can't reach database server` | `DATABASE_URL` errada ou banco não provisionado |
| Tabelas não existem | O build precisa rodar `npm run prisma:deploy` |
| Alunos tomam `401` | Faltou o header `X-API-Key` ou a chave está errada/desativada |
| Alunos tomam `403` desativado | O grupo foi desativado em `PATCH /admin/groups/:id` |
