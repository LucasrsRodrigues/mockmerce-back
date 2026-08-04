# Roadmap de Specs — Mini-Shopify de Ensino

Evolução do backend central multi-tenant (Node+TS · Fastify · Prisma · PostgreSQL) para
um "mini-Shopify" que os grupos de alunos **consomem** e que o professor usa para
**avaliar quem fez o quê**. Estas specs cobrem **só o que é responsabilidade do backend**:
API real, integrações **fake** (sandbox) e a **camada de ensino**.

> **Fora de escopo (non-goals de TODO o roadmap):** frontend, tema/aparência, editor
> visual, checkout UI, marketing on-page (blog, landing, popup, pixels, SEO on-page) e app
> mobile. Isso é **entrega do aluno** — o backend só expõe os endpoints.

---

## Como ler estas specs

Cada épico é uma pasta `.specs/f<fase>-<slug>/` com três arquivos:
`requirements.md` (o quê + critérios de aceite em EARS), `design.md` (como + decisões
rastreáveis às skills), `tasks.md` (passos atômicos + verificação). Este README é a
**espinha**: fases, dependências, e as **decisões transversais (ADRs globais)** que
**todos** os épicos herdam — não repita-as em cada épico, referencie-as (`ADR-G#`).

---

## Classificação de subdomínios (DDD) — onde investir rigor

| Subdomínio | Tipo (DDD) | Consequência |
|---|---|---|
| **Camada de ensino** (missões, correção automática, XP) | **Core** — o diferencial | Máximo rigor, in-house, melhor modelagem. É o "produto" real. |
| Promoções, ciclo de vida do Pedido, Reserva de estoque | **Core-ish** do e-commerce | Domain model rico (aggregates, invariantes). |
| Catálogo, Carrinho, Clientes, Relatórios | **Supporting** | Pragmático (active record / transaction script + service layer). |
| Auth/JWT, hashing, pagamento/frete/NF **fake** | **Generic** | Simplificado de propósito — são simulações didáticas, não o negócio. |

Fonte: `domain-driven-design` (subdomains cap.1; padrão de business logic por complexidade).

---

## Skills aplicadas (herdadas por todos os épicos)

| Skill | Papel no roadmap |
|---|---|
| `clean-code` + `clean-architecture` | Módulos coesos, SRP, service layer, Dependency Rule |
| `secure-coding` | NFR de segurança transversal (ADR-G7); revisão de segurança por épico |
| `multi-tenant-saas` | Isolamento por grupo, control plane × application plane, noisy neighbor, tiering |
| `api-architecture` | REST nível 2, OpenAPI como contrato, semver, webhooks, threat model |
| `domain-driven-design` | Subdomains, aggregates, value objects, domain events, Outbox/Saga |
| `ux-design` (só ensino) | Gamificação **ética** (missões/badges/XP), sem dark patterns |

---

## Decisões transversais (ADRs globais)

- **ADR-G1 — Monólito modular, não microservices.** Um único serviço Fastify com módulos
  por bounded context. O bounded context é a fronteira **larga** segura; decompor depois se
  necessário. _(DDD cap.3/14; api-architecture: comece simples, evolua por strangler.)_
- **ADR-G2 — Isolamento de tenant é camada EXPLÍCITA, não confiança no código.** Todo acesso
  a dado de negócio passa por um helper central `tenantScope(groupId)` que injeta o filtro
  `groupId` — nunca query "solta". Deployment (banco único, pooled) **≠** isolation.
  _(multi-tenant-saas: "deployment ≠ isolation", "não confie no código trusted";
  secure-coding A01/IDOR — autorização por objeto.)_
- **ADR-G3 — Control plane separado do application plane.** Rotas/módulos de **loja**
  (`/v1/...` consumidas pelos grupos) ficam separadas das de **operação** (`/admin/...`,
  camada de ensino), com credenciais distintas (`X-API-Key` × `X-Admin-Token`).
  _(multi-tenant-saas: as duas metades de todo SaaS.)_
- **ADR-G4 — Reserva de estoque via aggregate + optimistic concurrency + expiração.**
  Checkout reserva; pagamento confirma; job expira reservas não pagas. Campo `version` no
  aggregate de estoque evita corrida. _(DDD aggregate/optimistic concurrency; decisão do
  usuário: modelo "estilo Shopify".)_ Detalhe em [f1-inventory](f1-inventory/design.md).
- **ADR-G5 — Eventos e webhooks via padrão Outbox.** Toda mudança relevante grava um
  `DomainEvent` na **mesma transação** do estado; um relay entrega aos webhooks dos grupos
  (**at-least-once**, retry com backoff, assinatura **HMAC-SHA256** no header
  `X-Signature`). _(DDD Outbox; api-architecture; secure-coding A10/SSRF na URL de destino.)_
  Detalhe em [f1-webhooks](f1-webhooks/design.md).
- **ADR-G6 — Versionamento de API por prefixo `/v1` + Semantic Versioning + `openapi-diff`
  no CI.** Breaking changes barradas automaticamente. As rotas atuais migram para `/v1`
  mantendo alias temporário. _(api-architecture: OAS como contrato, semver, breaking no CI.)_
- **ADR-G7 — Segurança transversal (secure by default).** Rate limiting **por tenant**
  (defende noisy neighbor), `Idempotency-Key` em POST de escrita financeira/pedido, authz
  **deny-by-default por objeto**, segredos fora do código, erros sem vazar stack/segredo,
  log de eventos de segurança com tenant context. _(secure-coding §1/4/8/9; multi-tenant-saas
  noisy neighbor + logs com tenant context.)_
- **ADR-G8 — Value objects contra primitive obsession.** `Money` (armazenado em `Decimal`,
  operado em centavos), `CEP`, `CPF/CNPJ`, `Email`, e `status` como enums — encapsulam
  validação e comportamento. _(DDD value objects.)_
- **ADR-G9 — Gamificação ética na camada de ensino.** Missões/badges/XP/ranking servem ao
  **aprendizado**; ranking tem opt-out de exposição pública, sem shame social, sem urgência
  falsa. _(ux-design: nota ética.)_

---

## As 4 identidades (já existentes, mantidas)

| Header | Papel | Plano |
|---|---|---|
| `X-API-Key` | Tenant (grupo) — isola dados | application plane |
| `X-Student-RM` | Aluno que fez a chamada — rastreio/avaliação | atravessa ambos |
| `Authorization: Bearer` | Cliente final (JWT) da loja do grupo | application plane |
| `X-Admin-Token` | Professor | control plane |

---

## Fases, épicos e dependências

### Fase 1 — Fundação SaaS (o que mais transforma o sistema)
| Épico | Entrega | Depende de |
|---|---|---|
| [f1-catalog-variants](f1-catalog-variants/) | Produtos variáveis, variantes c/ estoque próprio, imagens, tags, coleções, marca, estados, relacionados/SEO | catálogo atual |
| [f1-inventory](f1-inventory/) | Movimentação+histórico, mínimo+alertas, **reserva no checkout**, depósitos, inventário | catalog-variants |
| [f1-promotions](f1-promotions/) | Motor de regras: cupom, frete grátis, X-leve-Y, progressivo, por categoria/cliente | carrinho atual |
| [f1-webhooks](f1-webhooks/) | Registro por grupo, eventos, retry, assinatura (Outbox) | ADR-G5 |
| [f1-sandbox-integrations](f1-sandbox-integrations/) | Pagamento fake (PIX/cartão/boleto/recorrente+webhook), frete fake (cotação+rastreamento) | webhooks |
| [f1-reports](f1-reports/) | Vendas, top produtos, ticket médio, receita, recorrentes, estoque + export CSV | pedidos |

### Fase 2 — Operação completa de loja
| Épico | Entrega | Depende de |
|---|---|---|
| [f2-customers-orders](f2-customers-orders/) | Endereços/CPF-CNPJ/segmentação/favoritos/histórico; pedidos (timeline, manual, cancelar, estorno/reembolso); carrinho (wishlist, comprar de novo, abandonado); + NF/outbox-email/mocks ERP-CRM | Fase 1 |
| [f2-admin-rbac-security](f2-admin-rbac-security/) | RBAC (usuários/perfis/permissões), auditoria, config; rate limit, idempotency, LGPD, `/v1` | ADR-G6/G7 |

### Fase 3 — Camada de ensino (o diferencial — subdomínio core)
| Épico | Entrega | Depende de |
|---|---|---|
| [f3-teaching-layer](f3-teaching-layer/) | Missões/correção automática (via RequestLog+dados), badges/XP, dashboard do aluno, ranking, "enviar para correção", nota automática | todas as fases (observa o uso delas) |

---

## Estratégia de testes (global)
Test Pyramid (`api-architecture`): muitos **unit** (motor de promoções, máquina de estados
de pedido, avaliador de missões), **integration** com Testcontainers (Postgres real) para
repositórios e isolamento de tenant, poucos **e2e** (fluxo compra ponta-a-ponta). Além
disso, **fitness functions** (`evolutionary-architecture`, aplicada pontualmente): um teste
que garante que **nenhuma** query de negócio roda sem filtro de `groupId` (guardião do
ADR-G2), e `openapi-diff` barrando breaking changes (ADR-G6).
