# Requirements — Estoque com Reserva (f1-inventory)

## Objetivo
Transformar o estoque simples (um inteiro que baixa no pagamento) em um **controle de
estoque real**: movimentação com histórico, estoque mínimo com alertas, **reserva no
checkout** (estilo Shopify), estoque por **depósito** e inventário. É o subdomínio
core-ish que sustenta a confiabilidade do pedido.

## Contexto e suposições
- Depende de [f1-catalog-variants]: a unidade de estoque é a **variante** (ADR-1 do épico
  anterior).
- Decisão do usuário (ADR-G4): **reservar no checkout**; pagamento confirma; reserva não
  paga **expira** e volta ao saldo.
- Suposição: **2 depósitos** por grupo por padrão ("Principal" e "Secundário"); o saldo de
  uma variante é a soma dos depósitos. Reserva sai do depósito com saldo (FIFO simples).
- Concorrência tratada com **optimistic concurrency** (campo `version`) no nível do saldo
  por depósito (DDD: aggregate + optimistic).

## Escopo
- **Dentro:** saldo por (variante, depósito); movimentações de **entrada/saída/ajuste/
  reserva/liberação/baixa** com histórico auditável; estoque mínimo + alerta (evento
  `product.low_stock`); reserva no checkout com **expiração** por job; inventário
  (contagem/ajuste em lote); consulta de disponibilidade (saldo − reservado).
- **Fora (non-goals):** lote/validade/número de série; transferência entre depósitos com
  workflow de aprovação; previsão de demanda. (Podem entrar depois.)

## Requisitos funcionais (EARS)

1. O sistema DEVE manter, por **(variante, depósito)**, os saldos `onHand` (físico) e
   `reserved` (reservado); **disponível = onHand − reserved**. _(aceite: consulta retorna
   os três.)_
2. QUANDO ocorre entrada/saída/ajuste, o sistema DEVE registrar uma **StockMovement**
   imutável (tipo, quantidade, motivo, referência, RM, timestamp) e atualizar o saldo na
   **mesma transação**. _(aceite: histórico reflete cada operação; saldo bate com a soma.)_
3. QUANDO o cliente faz **checkout**, o sistema DEVE **reservar** a quantidade de cada
   variante (incrementa `reserved`), SE houver disponível; SENÃO DEVE rejeitar o checkout
   com 422 identificando a variante. _(aceite: reserva aparece; sem disponível → 422.)_
4. QUANDO o pagamento do pedido é **aprovado**, o sistema DEVE **baixar** o estoque
   reservado (decrementa `onHand` e `reserved`) atomicamente. _(aceite: onHand cai, reserved
   volta a 0 para os itens; movimento `SALE` registrado.)_
5. SE um pedido reservado **não for pago** dentro de `RESERVATION_TTL` (ex.: 30 min) OU for
   cancelado, ENTÃO o sistema DEVE **liberar** a reserva (decrementa `reserved`, devolve ao
   disponível) e registrar movimento `RELEASE`. _(aceite: após TTL, reserva some e disponível
   volta; job idempotente.)_
6. SE o `disponível` de uma variante cruzar para **≤ estoque mínimo**, ENTÃO o sistema DEVE
   emitir o evento `product.low_stock` (Outbox — ADR-G5) uma vez por cruzamento.
   _(aceite: baixar até o mínimo dispara o evento; ficar abaixo não redispara a cada venda.)_
7. Sob **concorrência** (duas reservas simultâneas do último item), o sistema DEVE garantir
   que **apenas uma** tenha sucesso (optimistic concurrency / update condicional).
   _(aceite: teste concorrente — nunca `reserved > onHand`.)_
8. O sistema DEVE oferecer **inventário**: submeter contagem por (variante, depósito) e
   gerar movimentos de **ajuste** para reconciliar. _(aceite: contagem diferente do sistema
   gera ajuste com a diferença.)_
9. O app do grupo DEVE conseguir consultar o **histórico de movimentação** por variante,
   com filtros (tipo, período). _(aceite: histórico paginado e filtrável.)_

## Requisitos não-funcionais (NFRs)
- **Consistência forte** no saldo (ADR-G4): reserva/baixa nunca deixam `reserved > onHand`
  nem `onHand < 0` (invariante do aggregate).
- **Isolamento (ADR-G2)** e **segurança (ADR-G7):** operações de estoque exigem `X-API-Key`;
  `Idempotency-Key` em operações de baixa para evitar dupla baixa por retry.
- **Observabilidade:** todo movimento carrega `groupId` + `rm` (tenant context nos logs —
  multi-tenant-saas).

## Critérios de aceite globais
- [ ] Saldo por (variante, depósito) com onHand/reserved/disponível corretos.
- [ ] Fluxo reserva→pagamento→baixa e reserva→expiração→liberação funcionam e são auditáveis.
- [ ] Alerta de estoque mínimo dispara uma vez por cruzamento.
- [ ] Invariantes mantidos sob concorrência (teste de corrida verde).
