# Design — Estoque com Reserva (f1-inventory)

## Skills aplicadas
| Skill | Por que | Princípio aplicado aqui |
|---|---|---|
| domain-driven-design | Estoque é **core-ish** (invariantes de dinheiro/quantidade) | Aggregate `StockBalance` com transactional boundary + optimistic concurrency; domain events |
| architecture-hard-parts (implícito) | Consistência distribuída de reserva | Preferir **strong consistency** dentro do aggregate; expiração como processo eventual |
| multi-tenant-saas | Isolamento + observabilidade | Movimentos carregam tenant context |
| secure-coding | Retry/dupla baixa | `Idempotency-Key`; update condicional (compare-and-set) |
| api-architecture | Eventos de estoque | `product.low_stock` via Outbox (ADR-G5) |

## Visão geral — a máquina de estoque
O saldo de cada `(variante, depósito)` é um pequeno **aggregate** com invariantes
`onHand >= 0` e `0 <= reserved <= onHand`. Toda transição é um **command** que:
(1) lê o saldo com `version`; (2) valida a invariante; (3) faz `UPDATE ... WHERE id=? AND
version=?` (compare-and-set); (4) grava a `StockMovement` na **mesma transação**.

```
Ciclo de vida da quantidade:
 entrada ──▶ onHand+           checkout ──▶ reserved+ (RESERVE)
 pagamento aprovado ──▶ onHand- , reserved-  (SALE)
 TTL expira / cancela ──▶ reserved-           (RELEASE)
 inventário ──▶ ajuste onHand±                (ADJUST)
```

## Componentes e responsabilidades
- **inventory.service** — comandos `reserve(orderDraft)`, `commit(order)` (baixa),
  `release(order)`, `adjust(...)`, `receive(...)`. Cada um transacional e idempotente.
- **StockBalance repo** — compare-and-set por `version`; nunca update cego.
- **reservation expirer (job)** — varre reservas com `expiresAt < now` e chama `release`.
  Idempotente (só age em reservas `ACTIVE`).
- **low-stock detector** — após cada mudança, compara disponível com `min`; se cruzou,
  publica evento no Outbox (dedup por “estava acima, ficou ≤”).
- **Integração com Pedido** ([f2] e orders atual): checkout chama `reserve`; pagamento
  chama `commit`; cancelamento/expiração chama `release` — via **domain events** do pedido.

## Dados (Prisma)
- `Warehouse(groupId, name, isDefault)` — 2 seed por grupo.
- `StockBalance(groupId, variantId, warehouseId, onHand, reserved, version)` —
  `@@unique([variantId, warehouseId])`; índice `(groupId, variantId)`.
- `StockMovement(groupId, variantId, warehouseId, type: RECEIVE|SALE|ADJUST|RESERVE|RELEASE,
  quantity, reason?, orderId?, rm?, createdAt)` — **append-only** (sem update/delete).
- `Reservation(groupId, orderId, variantId, warehouseId, quantity, status:
  ACTIVE|COMMITTED|RELEASED, expiresAt)` — liga pedido↔reserva; base da expiração.
- `ProductVariant.min` (estoque mínimo) — de [f1-catalog-variants] ou aqui.

> **`stock` simples da variante** vira **derivado/legado**: a fonte da verdade passa a ser
> `StockBalance`. Uma view/campo calculado expõe o total para o catálogo.

## Interfaces / APIs (`/v1`)
- `GET /v1/variants/:id/stock` — saldos por depósito + disponível total.
- `POST /v1/variants/:id/stock/receive` — entrada `{warehouseId, quantity, reason}`.
- `POST /v1/variants/:id/stock/adjust` — ajuste manual.
- `GET /v1/variants/:id/stock/movements` — histórico filtrável.
- `POST /v1/inventory/counts` — submeter contagem em lote → gera ajustes.
- `GET /v1/warehouses`, `POST /v1/warehouses`.
- (Interno) reserva/baixa/liberação disparadas pelo fluxo de pedido, não por rota pública.

## Decisões (ADRs resumidos)
- **ADR-1 — Reserva no checkout com expiração (estilo Shopify).** Alternativas: (a) baixar
  no pagamento (atual, simples, mas oversell entre checkout e pagamento); (b) reservar
  (escolhida). Trade-off: precisa de job de expiração e de campo `reserved`; ganho: sem
  oversell e experiência realista. _(decisão do usuário; DDD strong consistency no aggregate.)_
- **ADR-2 — Optimistic concurrency (compare-and-set), não lock pessimista.** Evita
  contenção/deadlock; em conflito, retry curto. Trade-off: precisa tratar o retry.
  _(DDD: optimistic concurrency; escala melhor em pool — multi-tenant.)_
- **ADR-3 — Expiração como processo eventual, não estritamente no minuto.** Um job periódico
  (ex.: a cada 1 min) libera reservas vencidas — “eventually consistent” aceitável.
  _(architecture-hard-parts: strong onde precisa, eventual onde dá.)_
- **ADR-4 — Idempotência da baixa via `Idempotency-Key` + status da Reservation.** Retry do
  pagamento não baixa duas vezes. _(secure-coding: replay/dupla execução.)_

## Riscos e mitigações
- **Job de expiração cai** → reservas presas. Mitigação: job idempotente + métrica de
  “reservas ACTIVE vencidas” + alerta; recuperação ao religar.
- **Corrida no último item** → invariante quebrada. Mitigação: compare-and-set + teste de
  concorrência (fitness function).
- **Divergência entre `StockBalance` e catálogo** → sempre derivar do balance; nunca gravar
  saldo em dois lugares.
