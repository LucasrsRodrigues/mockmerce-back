# Design — Catálogo com Variantes (f1-catalog-variants)

## Skills aplicadas
| Skill | Por que | Princípio aplicado aqui |
|---|---|---|
| domain-driven-design | Catálogo é **supporting** | Active record + service layer (não domain model pesado); `Money`/dimensões como value objects |
| clean-architecture | Módulo coeso | Rotas → service → repositório Prisma; SRP por arquivo |
| multi-tenant-saas | Isolamento | `tenantScope(groupId)` em toda query (ADR-G2) |
| secure-coding | Superfície de escrita | Allowlist de input; referências validadas por grupo (anti-IDOR) |
| api-architecture | Contrato | Campos novos non-breaking em `/v1`; REST nível 2 |

## Visão geral
Produto passa a ser um **agregado leve**: `Product` (raiz) → `ProductVariant` (1..N) +
`ProductImage` + associações (tags, coleções, marca, relacionados). Produto **simples** é
modelado como produto com **uma** variante default — assim o resto do sistema (carrinho,
pedido, estoque) sempre opera sobre **variante**, unificando o código. Essa é a decisão
central: **a unidade vendável é sempre a variante**.

```
Product (type: SIMPLE|VARIABLE, state, publishAt, seo, brandId)
 ├─ ProductOption (ex.: "Cor") ─ ProductOptionValue (ex.: "Preto")
 ├─ ProductVariant (sku, barcode, price, weight, dims, stock*) ─ VariantOptionValue[]
 ├─ ProductImage (url, position, isPrimary, variantId?)
 ├─ tags (M:N), collections (M:N)
 └─ relations (related/cross-sell/upsell) → Product (mesmo grupo)
```
`stock*` aqui é o saldo simples; a mecânica rica vem em [f1-inventory].

## Componentes e responsabilidades
- **catalog.routes** — validação de schema (Fastify JSON Schema) + Swagger; sem lógica.
- **catalog.service** — regras: criar simples vs variável, unicidade de combinação/SKU/slug,
  validar referências do mesmo grupo, resolver estado/agendamento na leitura.
- **catalog.repository** — acesso Prisma **sempre** via `tenantScope` (ADR-G2).
- **visibility** — função pura `isVisibleToCustomer(product, now)` (estado + publishAt),
  usada nas queries com token de cliente.

## Dados (Prisma — novas entidades)
- `Product`: `+type`, `+state (DRAFT|PUBLISHED|HIDDEN)`, `+publishAt?`, `+brandId?`,
  `+slug`, `+metaTitle?`, `+metaDescription?`. `@@unique([groupId, slug])`.
- `Brand(groupId, name, slug)`; `Tag(groupId, name)`; `Collection(groupId, name, slug)`.
- `ProductOption(productId, name, position)`, `ProductOptionValue(optionId, value)`.
- `ProductVariant(productId, sku, barcode?, price, weightGr?, heightMm?, widthMm?, depthMm?,
  stock, active)`; `@@unique([groupId, sku])`.
- `VariantOptionValue(variantId, optionValueId)` — combinação; `@@unique([variantId,
  optionId])` garante 1 valor por opção; combinação única validada no service.
- `ProductImage(productId, variantId?, url, position, isPrimary)`.
- M:N: `_ProductTags`, `_ProductCollections`; `ProductRelation(productId, relatedId, kind:
  RELATED|CROSS_SELL|UPSELL)`.
- **Migração:** produtos atuais viram `type=SIMPLE` + 1 variante default (SKU/preço/estoque
  migrados). Script idempotente.

## Interfaces / APIs (`/v1`)
- `POST /v1/products` — cria simples ou variável (com `options` + `variants`).
- `GET /v1/products` — filtros: `search, tag, collectionId, brandId, state, minPrice,
  maxPrice, page, pageSize`. Cliente final só recebe visíveis.
- `GET /v1/products/:id` — detalhe com variantes, imagens, associações.
- `PUT /v1/products/:id`, `DELETE /v1/products/:id`.
- `POST /v1/products/:id/variants`, `PATCH /v1/variants/:id`, `DELETE /v1/variants/:id`.
- `POST /v1/products/:id/images`, `PATCH /v1/images/:id`, `DELETE`.
- `GET/POST /v1/collections`, `GET/POST /v1/brands`, `GET /v1/tags`.

## Decisões (ADRs resumidos)
- **ADR-1 — Unidade vendável = variante (sempre).** Produto simples = 1 variante default.
  Alternativas: (a) carrinho lida com produto OU variante (duplica lógica); (b) tudo é
  variante. Escolha (b): elimina ramificação no carrinho/pedido/estoque. Trade-off: leve
  overhead para produtos simples. _(DDD: modelo com um propósito, reduz graus de liberdade.)_
- **ADR-2 — Agendamento resolvido na query, não por job.** `publishAt` filtrado em tempo de
  leitura (`WHERE state=PUBLISHED AND (publishAt IS NULL OR publishAt<=now)`). Evita job e
  estado derivado inconsistente. Trade-off: cada leitura avalia a condição (barato, indexado).
- **ADR-3 — Imagem por URL, sem upload.** Mantém o backend sem storage/CDN (fora de escopo);
  o app do aluno hospeda a imagem. _(minimiza attack surface — secure-coding.)_

## Riscos e mitigações
- **Explosão combinatória de variantes** → limitar nº de opções (≤3) e valores (≤50/opção)
  por validação; documentar.
- **Vazamento cross-tenant em relacionados** → service valida que todo `relatedId`/`brandId`
  /`collectionId` pertence ao grupo (fitness function do ADR-G2 cobre).
- **Quebra do contrato antigo** → variante default + `openapi-diff` no CI (ADR-G6).
