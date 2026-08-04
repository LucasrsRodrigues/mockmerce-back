# Requirements — Clientes, Pedidos e Comunicações (f2-customers-orders)

## Objetivo
Completar a operação de loja: **clientes** ricos (endereços, CPF/CNPJ, segmentação,
favoritos, histórico), **gestão de pedidos** (timeline, pedido manual, cancelar, estorno/
reembolso que reverte estoque, comentários internos), **carrinho** avançado (wishlist,
comprar novamente, abandonado) e **comunicações/integrações fake** (NF-e fake, outbox de
e-mail, mocks de ERP/CRM/marketplace).

## Contexto e suposições
- Depende da Fase 1 (estoque com reserva, pedidos, webhooks, sandbox).
- Pedido é subdomínio **core-ish**: modelar o ciclo de vida como **máquina de estados**
  explícita com transições válidas (DDD aggregate + domain events).
- CPF/CNPJ e CEP como value objects com validação (ADR-G8).

## Escopo
- **Dentro — Clientes:** múltiplos endereços (entrega/cobrança) por cliente; CPF/CNPJ;
  favoritos (wishlist) por cliente; histórico de compras; **segmentos/grupos de clientes**
  (usados por promoções — [f1-promotions]).
- **Dentro — Pedidos:** máquina de estados (PENDING→PAID→FULFILLED→SHIPPED→DELIVERED, +
  CANCELLED/REFUNDED) com transições válidas e **timeline** auditável; **pedido manual**
  (app do grupo cria em nome de um cliente); cancelar (libera reserva); **estorno/reembolso**
  (reverte estoque baixado + emite evento + estorna pagamento fake); **comentários internos**
  (visíveis só ao grupo, não ao cliente).
- **Dentro — Carrinho:** wishlist→carrinho; **comprar novamente** (recria itens de um pedido);
  detecção de **carrinho abandonado** (sem atividade por X tempo → evento + outbox e-mail).
- **Dentro — Comunicações fake:** **NF-e fake** (gera número + XML/JSON stub por pedido);
  **outbox de e-mail** (registra e-mails que "seriam" enviados: confirmação, recuperação de
  carrinho, newsletter); **mocks** de ERP/CRM/marketplace (endpoints que aceitam/retornam
  payloads plausíveis para o aluno "integrar").
- **Fora (non-goals):** envio real de e-mail; NF-e fiscalmente válida; sincronização real
  com ERP/marketplace; cálculo tributário real.

## Requisitos funcionais (EARS)

### Clientes
1. O cliente/loja DEVE poder cadastrar **múltiplos endereços** com tipo (entrega/cobrança) e
   um padrão. _(aceite: CRUD; um endereço default por tipo.)_
2. SE um CPF/CNPJ informado é inválido (dígitos verificadores), ENTÃO o sistema DEVE rejeitar.
   _(aceite: CPF inválido → 400.)_
3. A loja DEVE poder criar **segmentos** de clientes e associar clientes; promoções podem
   restringir por segmento. _(aceite: segmento usado em promoção — [f1-promotions].)_
4. O cliente DEVE poder gerenciar **favoritos** e mover favorito → carrinho. _(aceite: add/
   remover; mover cria item no carrinho.)_

### Pedidos
5. O sistema DEVE permitir apenas **transições válidas** de status e registrar cada mudança
   na **timeline** (quem/quando/de→para). _(aceite: transição inválida → 409; timeline
   completa.)_
6. A loja DEVE poder criar um **pedido manual** para um cliente (itens + endereço), reservando
   estoque como no checkout. _(aceite: pedido manual reserva e entra como PENDING/PAID.)_
7. QUANDO um pedido pago é **reembolsado**, o sistema DEVE reverter o estoque baixado (entrada
   compensatória), estornar o pagamento fake, marcar REFUNDED e emitir `order.refunded`.
   _(aceite: estoque volta; evento emitido; pagamento estornado.)_
8. QUANDO um pedido PENDING é **cancelado**, o sistema DEVE liberar a reserva ([f1-inventory])
   e marcar CANCELLED. _(aceite: reserva liberada.)_
9. A loja DEVE poder adicionar **comentários internos** ao pedido, **não** visíveis ao cliente.
   _(aceite: cliente não vê; grupo vê.)_

### Carrinho
10. O cliente DEVE poder **comprar novamente** a partir de um pedido (recria itens
    disponíveis). _(aceite: itens recriados; indisponíveis são sinalizados.)_
11. SE um carrinho fica sem atividade por `ABANDON_TTL`, ENTÃO o sistema DEVE marcá-lo
    ABANDONED, emitir evento e registrar um e-mail de recuperação no **outbox**. _(aceite:
    após TTL, status muda e e-mail aparece no outbox.)_

### Comunicações fake
12. QUANDO um pedido é pago, o sistema DEVE gerar uma **NF-e fake** (número sequencial +
    XML/JSON stub) associada ao pedido. _(aceite: `GET /v1/orders/:id/invoice` retorna o stub.)_
13. O sistema DEVE registrar e-mails no **outbox** (não envia) e permitir consultá-los.
    _(aceite: confirmação de pedido aparece no outbox.)_
14. O sistema DEVE expor **mocks** de ERP/CRM/marketplace que aceitam um payload e retornam
    resposta plausível + registram a "sincronização". _(aceite: POST retorna 200 com eco/id
    fake e fica auditável.)_

## Requisitos não-funcionais (NFRs)
- **Consistência (DDD/ADR-G4):** reembolso/cancelamento mantêm invariantes de estoque
  (compensação correta); operações idempotentes (`Idempotency-Key`).
- **Isolamento/segurança (ADR-G2/G7):** comentários internos nunca vazam ao cliente; CPF/CNPJ
  é PII (não logar; LGPD tratada em [f2-admin-rbac-security]).
- **Auditabilidade:** timeline e outbox são append-only.

## Critérios de aceite globais
- [ ] Endereços, CPF/CNPJ válidos, segmentos, favoritos.
- [ ] Máquina de estados com transições válidas + timeline; pedido manual; cancelar; reembolso
      reverte estoque e estorna; comentários internos isolados.
- [ ] Comprar novamente; carrinho abandonado → evento + outbox e-mail.
- [ ] NF-e fake, outbox de e-mail, mocks ERP/CRM/marketplace.
