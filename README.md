# E-commerce API — Backend da Turma

Backend central **multi-tenant** para os projetos de e-commerce dos alunos.
Cada **grupo** recebe uma **API key** e trabalha em um e-commerce isolado (produtos,
clientes e pedidos próprios) dentro do mesmo servidor. Você, professor, vê tudo e
audita **quem** (qual grupo e qual RM) fez cada chamada.

> Node + TypeScript · Fastify · Prisma · PostgreSQL · Swagger/OpenAPI

---

## Índice

- [Como funciona (as 3 camadas de identidade)](#como-funciona)
- [Subir localmente](#subir-localmente)
- [Fluxo do professor (criar grupos, chaves, ver quem trabalhou)](#fluxo-do-professor)
- [Documentação para os alunos](docs/INTEGRACAO.md)
- [Deploy na nuvem](docs/DEPLOY.md)
- [Referência rápida de endpoints](#endpoints)

---

## Como funciona

Três "chaves" diferentes, cada uma com um papel — **é isso que simula uma integração real de API**:

| Camada | Header | Quem usa | Para quê |
|---|---|---|---|
| **API Key do grupo** | `X-API-Key: sk_live_...` | O app do grupo | Diz qual grupo está chamando e **isola os dados** dele |
| **RM do aluno** | `X-Student-RM: RM550001` | O app do grupo | Diz **qual aluno** fez a chamada → rastreio individual |
| **Token do cliente** | `Authorization: Bearer <jwt>` | O comprador do app | Login do cliente final do e-commerce deles |
| **Token de admin** | `X-Admin-Token: ...` | **Só você** | Criar grupos, gerar chaves, ver logs |

Toda requisição é gravada na tabela `RequestLog` (grupo, RM, rota, status, latência, IP).
O endpoint `GET /admin/activity` resume **quantas chamadas cada grupo e cada aluno fez**.

---

## Subir localmente

Pré-requisitos: **Node 20+** e **Docker** (para o Postgres).

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
#    edite o .env e troque JWT_SECRET e ADMIN_TOKEN por valores secretos

# 3. Subir o Postgres
docker compose up -d

# 4. Criar as tabelas
npm run prisma:migrate

# 5. (opcional) Popular um grupo demo com produtos — imprime uma API key de teste
npm run seed

# 6. Rodar em modo dev (reinicia ao salvar)
npm run dev
```

Servidor em `http://localhost:3333`  ·  **Swagger UI em `http://localhost:3333/docs`**

---

## Fluxo do professor

Tudo abaixo usa o header `X-Admin-Token` com o valor do seu `ADMIN_TOKEN` no `.env`.

### 1. Criar um grupo (e já cadastrar os RMs)

```bash
curl -X POST http://localhost:3333/admin/groups \
  -H "X-Admin-Token: SEU_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Grupo 01 - Loja de Games",
    "students": [
      { "rm": "RM990001", "name": "Ana Silva" },
      { "rm": "RM990002", "name": "Bruno Costa" }
    ]
  }'
```

A resposta traz a **`apiKey` (mostrada UMA única vez)** — copie e entregue ao grupo.

### 2. Ver quem está trabalhando (o controle que você quer)

```bash
curl http://localhost:3333/admin/activity -H "X-Admin-Token: SEU_ADMIN_TOKEN"
```

Retorna requisições **por grupo** e **por aluno (RM)**, com a data da última atividade.
Assim você vê quem realmente integrou — e quem não fez nada.

### 3. Log detalhado (com filtros)

```bash
# tudo do RM990001 desde 1º de agosto
curl "http://localhost:3333/admin/logs?rm=RM990001&since=2026-08-01" \
  -H "X-Admin-Token: SEU_ADMIN_TOKEN"
```

### Outras ações de admin

| Ação | Endpoint |
|---|---|
| Listar grupos + contagens | `GET /admin/groups` |
| Rotacionar a chave de um grupo | `POST /admin/groups/:id/rotate-key` |
| Ativar/desativar um grupo | `PATCH /admin/groups/:id` `{ "active": false }` |
| Adicionar alunos a um grupo | `POST /admin/groups/:id/students` |

> Dica: o `prisma studio` (`npm run prisma:studio`) abre uma UI visual do banco.

---

## Endpoints

Para os alunos (todos exigem `X-API-Key`):

| Área | Rotas |
|---|---|
| Catálogo | `GET/POST /products` (SIMPLE/VARIABLE), `GET/PUT/DELETE /products/:id`, variantes/imagens, `GET/POST /categories,/brands,/collections`, `GET /tags` |
| Auth cliente | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Carrinho | `GET /cart`, `POST /cart/items` (por `variantId`), `PATCH/DELETE /cart/items/:variantId`, `DELETE /cart` |
| Pedidos | `POST /orders/checkout` (reserva estoque), `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel` |
| Pagamento | `POST /orders/:id/pay` (baixa a reserva) |
| Estoque | `GET /variants/:id/stock`, `POST .../stock/receive\|adjust`, `GET .../stock/movements`, `GET/POST /warehouses`, `POST /inventory/counts` |
| Webhooks | `GET/POST /webhooks`, `PATCH/DELETE /webhooks/:id`, `POST /webhooks/:id/ping\|rotate-secret`, `GET /webhooks/deliveries`, `GET /webhooks/events` |
| Sandbox (fake) | `POST /sandbox/payments` (+`/:id/settle`), `POST /sandbox/subscriptions`, `POST /sandbox/shipping/quote`, `POST /sandbox/shipments` (+`/:id/advance`) |
| Relatórios | `GET /reports/sales\|top-products\|customers\|inventory` (todos com `?format=csv`) |
| Cliente | `GET/POST/DELETE /customers/me/addresses\|favorites`; `POST /orders/:id/reorder`, `GET /orders/:id/timeline` |
| Loja (pedidos) | `GET /store/orders`, `POST /store/orders` (manual), `POST /store/orders/:id/transition\|refund\|comments` |
| Loja (clientes) | `GET /store/customers`, `GET/POST /customer-segments` (+members) |
| Comunicações | `GET /orders/:id/invoice` (NF-e fake), `GET /email-outbox`, `POST /sandbox/erp\|crm\|marketplace/sync` |
| Config + LGPD | `GET/PUT /store/settings`, `GET /store/customers/:id/export`, `DELETE /store/customers/:id` |
| Ensino (grupo) | `GET /teaching/dashboard\|ranking`, `POST /teaching/submit`, `PUT /teaching/settings` |
| Ensino (professor) | `POST /admin/teaching/evaluate`, `GET /admin/teaching/class\|ranking`, `GET/POST /admin/missions` |

> **Versionamento:** as rotas de negócio são canônicas sob **`/v1`** (ex.: `/v1/products`). Os caminhos
> sem prefixo continuam funcionando como alias. O control plane (`/admin/*`) não é versionado.
> **Rate limiting** por grupo, **`Idempotency-Key`** em POST e **RBAC** de operadores estão ativos —
> veja [docs/DEPLOY.md](docs/DEPLOY.md) e `.env.example`.

**Guia completo e passo a passo para os alunos:** [docs/INTEGRACAO.md](docs/INTEGRACAO.md)

---

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Sobe o servidor com hot-reload |
| `npm run build` / `npm start` | Compila e roda em produção |
| `npm run prisma:migrate` | Cria/atualiza tabelas (dev) |
| `npm run prisma:deploy` | Aplica migrations (produção) |
| `npm run seed` | Popula o grupo demo |
| `npm run prisma:studio` | UI visual do banco |
| `npm run db:reset` | Zera o banco e recria do zero |
# mockmerce-back
