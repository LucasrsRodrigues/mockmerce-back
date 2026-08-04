# Tasks — Estoque com Reserva (f1-inventory)

- [ ] **T1 — Modelagem Prisma (Warehouse, StockBalance, StockMovement, Reservation)** _(req: 1,2)_
  - Uniques/índices; `version` em StockBalance; movements append-only.
  - Verificação: migração aplica; seed cria 2 depósitos por grupo.
- [ ] **T2 — Migrar estoque atual → StockBalance no depósito Principal** _(req: 1)_ · dep: T1
  - Copiar `variant.stock` para `onHand` do depósito default; idempotente.
  - Verificação: soma dos balances = estoque anterior.
- [ ] **T3 — Comandos de saldo com compare-and-set** _(req: 2,7)_ · dep: T1
  - `receive/adjust` transacionais; `UPDATE ... WHERE version=?`; grava movimento.
  - Verificação: unit test de invariantes; teste de concorrência (2 reservas do último item → 1 sucede).
- [ ] **T4 — `reserve()` no checkout** _(req: 3)_ · dep: T3
  - Reserva por item; cria `Reservation` com `expiresAt=now+TTL`; 422 se indisponível.
  - Verificação: checkout reserva; sem disponível → 422 identificando a variante.
- [ ] **T5 — `commit()` na aprovação do pagamento** _(req: 4)_ · dep: T4
  - Baixa onHand+reserved; `Idempotency-Key`; movimento SALE; Reservation→COMMITTED.
  - Verificação: pagar baixa 1x; retry não baixa de novo.
- [ ] **T6 — `release()` + job de expiração** _(req: 5)_ · dep: T4
  - Job periódico libera `expiresAt<now` ACTIVE; cancelamento também libera.
  - Verificação: TTL curto em teste → reserva liberada; job roda 2x sem efeito duplo.
- [ ] **T7 — Detector de estoque mínimo → evento** _(req: 6)_ · dep: T3, ADR-G5
  - Publicar `product.low_stock` no Outbox no cruzamento; dedup.
  - Verificação: baixar até o mínimo dispara 1 evento; vendas abaixo não redisparam.
- [ ] **T8 — Inventário (contagem em lote → ajustes)** _(req: 8)_ · dep: T3
  - `POST /v1/inventory/counts`; diferença gera ADJUST.
  - Verificação: contagem divergente concilia o saldo.
- [ ] **T9 — Histórico + consulta de saldo** _(req: 9,1)_ · dep: T3
  - Endpoints de saldo e movimentos com filtros/paginação.
  - Verificação: histórico reflete todas as operações.
- [ ] **T10 — Integrar com fluxo de pedido existente + Swagger/SDK** _(req: 3,4,5)_ · dep: T4–T6
  - Trocar a baixa direta atual pela reserva→commit; documentar.
  - Verificação: e2e compra ponta-a-ponta com reserva; `/docs` atualizado.
- [ ] **T11 — Revisão de segurança** _(req: NFR)_ · dep: T3–T10
  - Idempotência, isolamento, sem `onHand<0`/`reserved>onHand`.
  - Verificação: checklist secure-coding + testes de invariante verdes.

## Estratégia de testes
Unit (invariantes e comandos), **concorrência** (corrida no último item — fitness function),
integration (fluxo reserva/commit/release com Postgres real), e2e (checkout→pagamento→baixa
e checkout→expiração→liberação). Métrica: contagem de reservas ACTIVE vencidas = alerta.
