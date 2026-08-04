# Tasks — Clientes, Pedidos e Comunicações (f2-customers-orders)

### Clientes
- [ ] **T1 — Endereços + CPF/CNPJ (value objects)** _(req: 1,2)_
  - CRUD de endereço; validação de documento; default por tipo.
  - Verificação: CPF inválido → 400; default único.
- [ ] **T2 — Segmentos de cliente + integração com promoções** _(req: 3)_ · dep: T1
  - Verificação: promoção restrita a segmento só aplica ao membro.
- [ ] **T3 — Favoritos + mover para carrinho** _(req: 4)_
  - Verificação: favorito → item no carrinho.

### Pedidos
- [ ] **T4 — Máquina de estados + timeline** _(req: 5)_
  - Tabela de transições (pura); `OrderEvent` append.
  - Verificação: transição inválida → 409; timeline completa.
- [ ] **T5 — Pedido manual** _(req: 6)_ · dep: T4, [f1-inventory]
  - Reserva estoque como no checkout.
  - Verificação: pedido manual reserva e entra no fluxo.
- [ ] **T6 — Cancelar (libera reserva)** _(req: 8)_ · dep: T4
  - Verificação: reserva liberada; status CANCELLED.
- [ ] **T7 — Reembolso como compensação (Saga)** _(req: 7)_ · dep: T4,[f1-sandbox-integrations]
  - Entrada compensatória de estoque + estorno pagamento fake + evento `order.refunded`;
    idempotente.
  - Verificação: estoque volta; pagamento estornado; refund 2x não duplica.
- [ ] **T8 — Comentários internos** _(req: 9)_ · dep: T4
  - Verificação: resposta ao cliente nunca inclui comentário.

### Carrinho
- [ ] **T9 — Comprar novamente** _(req: 10)_ · dep: T4
  - Verificação: recria itens disponíveis; sinaliza indisponíveis.
- [ ] **T10 — Carrinho abandonado (job) + evento + outbox** _(req: 11)_ · dep: T13
  - Verificação: após TTL, ABANDONED + e-mail no outbox.

### Comunicações fake
- [ ] **T11 — NF-e fake (numeração sequencial + stub)** _(req: 12)_ · dep: T4
  - Verificação: `GET /v1/orders/:id/invoice` retorna número + XML/JSON stub.
- [ ] **T12 — Outbox de e-mail** _(req: 13)_
  - Registrar confirmação/recuperação/newsletter; consulta.
  - Verificação: pagar pedido registra e-mail de confirmação.
- [ ] **T13 — Mocks ERP/CRM/marketplace** _(req: 14)_
  - Eco + `IntegrationSyncLog`.
  - Verificação: POST retorna id fake e fica auditável.

### Fechamento
- [ ] **T14 — Swagger + SDK + guia + revisão de segurança** _(req: NFR)_ · dep: T1–T13
  - PII não logada; comentário interno não vaza; idempotência.
  - Verificação: `/docs`, SDK, checklist secure-coding.

## Estratégia de testes
Unit (máquina de estados; validação CPF/CNPJ; compensação de reembolso). Integration (refund
reverte estoque; abandoned-cart; isolamento de comentário). e2e: pedido manual → pagar →
NF-e + e-mail no outbox → reembolso reverte tudo.
