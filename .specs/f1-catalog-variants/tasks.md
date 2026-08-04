# Tasks — Catálogo com Variantes (f1-catalog-variants)

- [ ] **T1 — Modelagem Prisma + migração** _(req: 1,2,10)_
  - Adicionar entidades (Product estendido, Brand, Tag, Collection, ProductOption/Value,
    ProductVariant, VariantOptionValue, ProductImage, ProductRelation) com índices
    `(groupId, …)` e uniques.
  - Verificação: `prisma migrate dev` aplica; `prisma studio` mostra as tabelas.
- [ ] **T2 — Migração de dados dos produtos atuais → variante default** _(req: 1)_ · dep: T1
  - Script idempotente: cada Product vira `type=SIMPLE` + 1 `ProductVariant` (SKU/preço/
    estoque copiados).
  - Verificação: rodar 2x não duplica; `GET /v1/products/:id` de produto legado tem 1 variante.
- [ ] **T3 — `tenantScope` + repositório** _(req: NFR isolamento)_ · dep: T1
  - Helper central que injeta `groupId`; repositório de catálogo o usa em 100% das queries.
  - Verificação: teste de integração — grupo A não lê produto de B (404).
- [ ] **T4 — Service: criar produto simples e variável** _(req: 1,2,3,4)_ · dep: T3
  - Validar combinação única, SKU único por grupo, montar variantes.
  - Verificação: unit tests dos casos 2,3,4; criar variável com 4 variantes.
- [ ] **T5 — Associações: tags, coleções, marca, relacionados/cross/upsell** _(req: 5)_ · dep: T4
  - Endpoints de brand/collection/tag; validar referências do mesmo grupo.
  - Verificação: referência de outro grupo → 400; associações retornam no detalhe.
- [ ] **T6 — Imagens (produto e variante)** _(req: 6)_ · dep: T4
  - CRUD de imagem com `position`/`isPrimary`; primeira vira principal.
  - Verificação: reordenar; trocar principal.
- [ ] **T7 — Estados + agendamento + visibilidade do cliente** _(req: 7,8)_ · dep: T4
  - `isVisibleToCustomer`; aplicar em queries com token de cliente.
  - Verificação: draft/hidden ocultos p/ cliente; agendar +1h (antes oculto, depois visível).
- [ ] **T8 — Listagem com filtros + paginação** _(req: 9)_ · dep: T4
  - Filtros (tag/coleção/marca/estado/preço/busca) com índices; evitar N+1.
  - Verificação: cada filtro isola o subconjunto correto; explain usa índice.
- [ ] **T9 — SEO + peso/dimensões** _(req: 10)_ · dep: T4
  - slug único por grupo, meta*, peso/dims por variante.
  - Verificação: slug duplicado → 409; campos no detalhe.
- [ ] **T10 — Swagger + SDK + `/v1` alias** _(req: NFR compat)_ · dep: T4–T9
  - Documentar rotas; atualizar `sdk/ecommerce-client.ts`; expor sob `/v1` mantendo alias
    das rotas atuais.
  - Verificação: `/docs` mostra tudo; `openapi-diff` sem breaking.
- [ ] **T11 — Revisão de segurança do épico** _(req: NFR segurança)_ · dep: T4–T10
  - Checklist secure-coding: input allowlist, anti-IDOR nas referências, sem vazamento cross-tenant.
  - Verificação: checklist preenchido; testes de isolamento verdes.

## Estratégia de testes
Unit (service: combinação/SKU/slug, visibilidade); integration com Testcontainers
(isolamento de tenant, filtros); e2e leve (criar variável → cliente lista só publicados).
Fitness function: teste que falha se alguma query de catálogo não passar por `tenantScope`.
