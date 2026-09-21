# mockmerce-back · E-commerce API (Backend)

Backend central **multi-tenant** do projeto **MockMerce** (turma 2TDSPG). Um único servidor
hospeda **várias lojas isoladas** — uma por **grupo** da turma. Cada grupo recebe uma
**API key** e trabalha só nos seus produtos, clientes e pedidos. O professor vê tudo e
audita **quem** (qual grupo e qual RM) fez cada chamada.

> Node · TypeScript · Fastify · Prisma · PostgreSQL · Swagger/OpenAPI

### 🧩 Projeto MockMerce — 3 repositórios

| Repo | O que é |
|---|---|
| **mockmerce-back** (este) | A API que todos os grupos consomem |
| **mockmerce-alun** | Painel web (estilo Shopify) para os alunos gerenciarem a loja |
| **mockmerce-doc** | Hub de documentação/tutoriais (Docusaurus) |

---

## Índice

- [Como funciona (as 3 camadas de identidade)](#como-funciona)
- [Subir localmente](#subir-localmente)
- [Fluxo do professor](#fluxo-do-professor)
- [Documentação para os alunos](docs/INTEGRACAO.md)
- [Deploy na nuvem](docs/DEPLOY.md)
- [Referência de endpoints](#endpoints)
- [Estrutura do código](#estrutura)

---

## Como funciona

Três "chaves" diferentes, cada uma com um papel — **é isso que simula uma integração real de API**:

| Camada | Header | Quem usa | Para quê |
|---|---|---|---|
| **API Key do grupo** | `X-API-Key: sk_live_...` | O app do grupo | Diz qual grupo está chamando e **isola os dados** dele |
| **RM do aluno** | `X-Student-RM: RM550001` | O app do grupo | Diz **qual aluno** fez a chamada → rastreio individual |
| **Token do cliente** | `Authorization: Bearer <jwt>` | O comprador do app | Login do cliente final do e-commerce deles |
| **Token de admin** | `X-Admin-Token: ...` | **Só o professor** | Criar grupos, gerar chaves, ver logs |

Toda requisição é gravada na tabela `RequestLog` (grupo, RM, rota, status, latência, IP).
O endpoint `GET /admin/activity` resume **quantas chamadas cada grupo e cada aluno fez**.

O isolamento entre grupos é **explícito** (todo `where` de negócio filtra por `groupId` via
`src/lib/tenantScope.ts`) — não depende da topologia do banco.

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

> ⚠️ **Repositório público:** nunca commite o `.env`. Os segredos (`JWT_SECRET`, `ADMIN_TOKEN`,
> `DATABASE_URL`) ficam só em variáveis de ambiente — o `.gitignore` já ignora o `.env`.

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

A resposta traz a **`apiKey` (mostrada UMA única vez)**. Os alunos também podem gerar as
próprias chaves nomeadas pelo painel (`mockmerce-alun` → Configurações → Chaves de API).

### 2. Ver quem está trabalhando

```bash
curl http://localhost:3333/admin/activity -H "X-Admin-Token: SEU_ADMIN_TOKEN"
```

Retorna requisições **por grupo** e **por aluno (RM)**, com a data da última atividade.

### 3. Log detalhado (com filtros)

```bash
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

> Dica: `npm run prisma:studio` abre uma UI visual do banco.

---

## Endpoints

Para os alunos (todos exigem `X-API-Key`, ou o token de aluno do painel):

| Área | Rotas |
|---|---|
| Catálogo | `GET/POST /products` (SIMPLE/VARIABLE), `GET/PUT/DELETE /products/:id`, variantes/imagens, `GET/POST /categories,/brands,/collections`, `GET /tags` |
| Mídia (S3) | `POST /uploads` (multipart), `POST /products/:id/media` (sobe e vincula), `GET /media`, `GET /media/usage`, `DELETE /media/:id` |
| Auth cliente | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Carrinho | `GET /cart`, `POST /cart/items` (por `variantId`), `PATCH/DELETE /cart/items/:id`, `DELETE /cart` |
| Pedidos | `POST /orders/checkout` (reserva estoque), `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel` |
| Pagamento | `POST /orders/:id/pay` (baixa a reserva) |
| Estoque | `GET /variants/:id/stock`, `POST .../stock/receive\|adjust`, `GET .../stock/movements` |
| Webhooks | `GET/POST /webhooks`, `DELETE /webhooks/:id`, `POST /webhooks/:id/ping`, `GET /webhooks/deliveries\|events` |
| Push (FCM) | `POST/GET/DELETE /customers/me/devices` (app), `POST /push/send\|test`, `GET /push/devices\|messages\|status`, `PUT/GET/DELETE /store/push-config` |
| Sandbox (fake) | `POST /sandbox/payments` (+`/:id/settle`), `POST /sandbox/shipping/quote`, `POST /sandbox/shipments` (+`/:id/advance`) |
| Relatórios | `GET /reports/sales\|top-products\|customers\|inventory` (todos com `?format=csv`) |
| Loja — pedidos | `GET /store/orders`, `POST /store/orders/:id/transition\|refund\|comments` |
| Loja — config | `GET/PUT /store/settings` (identidade, contato, tema, regional) |
| Loja — chaves de API | `GET/POST /store/api-keys`, `DELETE /store/api-keys/:id` |
| Loja — membros do grupo | `GET/POST /store/members`, `DELETE /store/members/:rm` |
| Login do aluno (painel) | `POST /store/auth/login`, `GET /store/auth/me`, `POST /store/auth/change-password` |
| Ensino (grupo) | `GET /teaching/dashboard\|ranking`, `POST /teaching/submit` |

> **Versionamento:** as rotas de negócio são canônicas sob **`/v1`** (ex.: `/v1/products`).
> Os caminhos sem prefixo continuam funcionando como alias. O control plane (`/admin/*`) não é versionado.
> **Rate limiting** por grupo, **`Idempotency-Key`** em POST e **RBAC** de operadores estão ativos.

**Guia completo e passo a passo para os alunos:** [docs/INTEGRACAO.md](docs/INTEGRACAO.md) ·
**Hub de tutoriais:** repositório `mockmerce-doc`.

---

## Upload de imagens e vídeos (S3)

O arquivo sobe em `multipart/form-data` para a API, que valida e repassa ao
**Amazon S3**. A resposta traz a **URL pública final** — o binário nunca volta
pela API, o app carrega direto do bucket/CDN.

**Configuração** (`.env`): `S3_BUCKET`, `AWS_REGION` e credenciais. Sem
`S3_BUCKET`, as rotas de mídia respondem `503 UPLOAD_DISABLED` e o restante da
API segue funcionando. Passo a passo do bucket em [DEPLOY.md](../DEPLOY.md).

**Dois caminhos para o aluno:**

```bash
# A) sobe e já vincula ao produto (1 chamada)
curl -X POST https://api.mockmerce.com.br/v1/products/PROD_ID/media \
  -H "X-API-Key: sk_live_..." -F "file=@foto.jpg" -F "isPrimary=true"

# B) sobe para a biblioteca e vincula depois (reaproveita o mesmo arquivo)
curl -X POST https://api.mockmerce.com.br/v1/uploads \
  -H "X-API-Key: sk_live_..." -F "file=@foto.jpg" -F "folder=produtos"
# → { "id": "med_...", "url": "https://.../foto.jpg", "kind": "IMAGE" }

curl -X POST https://api.mockmerce.com.br/v1/products/PROD_ID/images \
  -H "X-API-Key: sk_live_..." -H "Content-Type: application/json" \
  -d '{"mediaId":"med_..."}'
```

No **React Native** (SDK em `sdk/ecommerce-client.ts`):

```ts
const foto = { uri: result.assets[0].uri, name: 'foto.jpg', type: 'image/jpeg' };
const media = await api.media.upload(foto, { folder: 'produtos' });
await api.products.addImage(produtoId, { mediaId: media.id, isPrimary: true });
```

**Regras aplicadas pela API:**

| Regra | Comportamento |
|---|---|
| Formatos aceitos | JPEG, PNG, WebP, GIF, AVIF, MP4, WebM, MOV |
| Detecção de tipo | Pelos **bytes** do arquivo, não pela extensão nem pelo `Content-Type` (um `.jpg` com HTML dentro é recusado com `415`) |
| Tamanho por arquivo | `UPLOAD_MAX_MB` (padrão 50 MB) → `413 FILE_TOO_LARGE` |
| Cota por grupo | `UPLOAD_QUOTA_MB_PER_GROUP` (padrão 500 MB) → `422`; consulte em `GET /media/usage` |
| Isolamento | Cada grupo só enxerga a própria biblioteca; no bucket, os arquivos ficam sob `groups/<groupId>/…` |
| Nome do arquivo | Sempre gerado pela API (aleatório), nunca o nome enviado — evita colisão e path traversal |
| Apagar em uso | `DELETE /media/:id` devolve `409` se o arquivo estiver em algum produto; use `?force=true` |

**Vídeos:** ficam na mesma lista de mídias do produto, separados na resposta —
`images` traz só imagens (compatível com quem já consumia) e `videos` traz os
vídeos. A capa (`isPrimary`) é sempre uma imagem.

---

## Push (Firebase Cloud Messaging)

Push **real**, pelo FCM HTTP v1 — não é um mock. Fica desligado por padrão: sem
credencial, só as rotas de push respondem `503 PUSH_DISABLED` e o resto da API
funciona normal. Confira com `GET /v1/push/status`.

**Cada loja usa o próprio projeto Firebase.** Um token do FCM pertence ao
projeto que o emitiu (o mesmo que gerou o `google-services.json` do app), e
só a credencial DESSE projeto alcança aquele aparelho — enviar com a de outro
devolve `SENDER_ID_MISMATCH`. Por isso a credencial é por grupo:

| rota | o que faz |
|---|---|
| `PUT /v1/store/push-config` | cola o JSON da conta de serviço (cru ou base64); é testado contra o Google na hora |
| `GET /v1/store/push-config` | projeto, conta e resultado do último teste — a chave privada nunca volta |
| `POST /v1/store/push-config/check` | refaz o handshake OAuth, sem enviar nada |
| `DELETE /v1/store/push-config` | remove e volta a usar a do servidor |

A chave privada é guardada **cifrada** (AES-256-GCM, ver `lib/secretBox.ts`) —
trocar o `JWT_SECRET` invalida as credenciais salvas e os grupos recolam.

**Fallback:** sem credencial da loja, o envio usa a do servidor
(`FCM_SERVICE_ACCOUNT_JSON` no `.env`) — é a que o professor usa na
demonstração. `GET /v1/push/status` diz qual das duas está valendo.

**O caminho completo:**

1. o app pede permissão e pega o token do aparelho
   (`getDevicePushTokenAsync()` — o token CRU do FCM, não o `ExponentPushToken[...]`);
2. registra em `POST /v1/customers/me/devices` (com o JWT do cliente) a cada
   abertura — o token é por instalação e rotaciona sozinho;
3. a loja dispara com `POST /v1/push/send`;
4. tudo que saiu fica em `GET /v1/push/messages`, com o payload e a resposta do FCM.

**`kind` decide o comportamento nos três estados do app:**

| | app aberto | app em segundo plano | app fechado |
|---|---|---|---|
| `NOTIFICATION` | o SO desenha; seu handler recebe | o SO desenha | o SO desenha, seu código só roda no toque |
| `DATA` | seu handler recebe, você decide | seu handler recebe | entrega não garantida no Android |

**Deep link:** o campo `data` viaja até o app. Mandar
`{ "rota": "produto", "produtoId": "..." }` é o que permite abrir a tela do
produto no toque, em vez da home.

**Gatilho automático:** quando o `PATCH /v1/variants/:id` **baixa** o preço,
quem favoritou aquela variante recebe push (`reason: price_drop`) com o
`produtoId` no `data`, e um evento `product.price_changed` vai para o Outbox —
quem preferir webhook recebe pelo caminho de sempre. Preço que sobe não
notifica ninguém.

> Um push nunca derruba o fluxo que o originou: se o FCM estiver fora, o preço
> muda do mesmo jeito e a falha fica registrada no inspector.

---

## Estrutura

```
src/
  app.ts            # monta o Fastify, plugins e rotas
  plugins/          # auth (3 camadas), erro, rate limit, idempotência, swagger
  lib/              # tenantScope (isolamento), apiKey, errors, serialize…
  modules/          # domínios: catalog, media, cart, orders, inventory,
                    #           payments, webhooks, customers, reports,
                    #           settings, store-auth, teaching, admin
prisma/
  schema.prisma     # modelo de dados (tenant = Group)
  migrations/       # histórico de migrações
  seed.ts           # grupo demo com produtos
```

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
