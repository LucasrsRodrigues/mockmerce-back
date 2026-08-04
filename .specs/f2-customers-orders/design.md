# Design — Clientes, Pedidos e Comunicações (f2-customers-orders)

## Skills aplicadas
| Skill | Por que | Princípio aplicado aqui |
|---|---|---|
| domain-driven-design | Pedido é **core-ish** | Aggregate `Order` com **máquina de estados** + domain events; **Saga**/compensação no reembolso |
| architecture-hard-parts | Reembolso cruza estoque+pagamento | Ação **compensatória** (não desfaz, compensa) |
| secure-coding | PII (CPF/CNPJ), comentários internos | Validação; separação de visibilidade; não logar PII |
| clean-code | Transições | Tabela de transições explícita, função pura de validação |

## Visão geral — Pedido como máquina de estados
O `Order` vira o aggregate central com transições **explícitas**. Cada transição gera
`OrderEvent` (timeline) e, quando relevante, um domain event no Outbox (webhooks).

```
PENDING ──pay──▶ PAID ──fulfill──▶ FULFILLED ──ship──▶ SHIPPED ──deliver──▶ DELIVERED
   │                │
 cancel           refund
   ▼                ▼
CANCELLED        REFUNDED   (reembolso = ação compensatória de estoque + pagamento)
```
Transições inválidas → 409. A tabela de transições é uma constante testável.

## Componentes e responsabilidades
- **order.stateMachine (puro)** — `canTransition(from,to)` + efeitos por transição.
- **order.service** — orquestra: pagar→commit estoque; cancelar→release; **refund→saga**
  (entrada compensatória de estoque + estorno do pagamento fake + evento); pedido manual.
- **customer.service** — endereços, CPF/CNPJ (value objects), segmentos, favoritos.
- **communications** — nfe.fake (numeração sequencial por grupo), email.outbox (registro),
  integration.mocks (ERP/CRM/marketplace: eco + auditoria).
- **abandoned-cart job** — marca carrinhos ociosos, emite evento + grava e-mail no outbox.

## Dados (Prisma)
- `Address(groupId, customerId, type, isDefault, cep, street, ...)`.
- `Customer.document` (CPF/CNPJ) + `CustomerSegment(groupId, name)` + join
  `CustomerSegmentMember`.
- `Favorite(groupId, customerId, variantId)`.
- `OrderEvent(orderId, fromStatus, toStatus, actor: CUSTOMER|STORE|SYSTEM, rm?, note?,
  createdAt)` — timeline append-only.
- `OrderInternalComment(orderId, rm, body, createdAt)` — nunca exposto ao cliente.
- `FakeInvoice(groupId, orderId, number, xmlStub, createdAt)` — número sequencial por grupo.
- `EmailOutbox(groupId, to, template, payload Json, status: RECORDED, createdAt)`.
- `IntegrationSyncLog(groupId, system: ERP|CRM|MARKETPLACE, direction, payload Json,
  response Json, createdAt)`.
- `Cart.status` já suporta ABANDONED; `Cart.lastActivityAt`.

## Interfaces / APIs (`/v1`)
- Clientes: `/v1/customers/me/addresses`, `/v1/customers/me/favorites`,
  `/v1/customer-segments` (loja).
- Pedidos: `POST /v1/orders` (manual), `POST /v1/orders/:id/transition`,
  `POST /v1/orders/:id/refund`, `POST /v1/orders/:id/cancel`,
  `GET /v1/orders/:id/timeline`, `/v1/orders/:id/comments`.
- Comunicações: `GET /v1/orders/:id/invoice`, `GET /v1/email-outbox`,
  `POST /v1/sandbox/erp|crm|marketplace/sync`.
- Carrinho: `POST /v1/orders/:id/reorder`, wishlist→cart.

## Decisões (ADRs resumidos)
- **ADR-1 — Máquina de estados explícita (tabela de transições).** Evita status "mágico"
  espalhado por ifs. Testável e clara para o aluno. _(clean-code; DDD aggregate com commands.)_
- **ADR-2 — Reembolso como compensação (Saga simples), não delete.** Cria **movimento
  compensatório** de estoque (RECEIVE) e estorno de pagamento; nada é apagado — histórico
  íntegro. _(architecture-hard-parts: compensating action; DDD Saga.)_
- **ADR-3 — Comunicações são fake e auditáveis, nunca side-effect real.** E-mail vai para
  outbox; NF-e é stub; ERP/CRM apenas registram. _(escopo de ensino; secure-coding: sem
  egress não controlado.)_
- **ADR-4 — CPF/CNPJ como value object com validação + tratado como PII.** Não logar; base
  para LGPD ([f2-admin-rbac-security]). _(secure-coding; ADR-G8.)_

## Riscos e mitigações
- **Reembolso parcial vs total** → começar só total; parcial documentado como evolução.
- **Dupla compensação** → idempotência por `Idempotency-Key` + status REFUNDED.
- **Vazamento de comentário interno** → schema de resposta ao cliente nunca inclui a entidade;
  teste garante.
