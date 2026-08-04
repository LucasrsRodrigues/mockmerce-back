# Requirements — Integrações Sandbox: Pagamento e Frete (f1-sandbox-integrations)

## Objetivo
Oferecer **gateways fake** de **pagamento** e **frete** que imitam APIs reais (PIX/cartão/
boleto; cotação por CEP + rastreamento), para o aluno viver a experiência de **integrar um
serviço externo** — incluindo o **webhook de confirmação** assíncrono — sem infra real.

## Contexto e suposições
- Subdomínio **generic** (DDD): simulações intencionalmente simplificadas; o valor é
  pedagógico, não fidelidade fiscal/bancária.
- Usa os webhooks do [f1-webhooks] para os callbacks assíncronos (ex.: PIX "pago").
- Expostos sob um namespace claro `/v1/sandbox/*` (control/data plane de simulação),
  documentados como fake no Swagger.

## Escopo
- **Dentro — Pagamento fake:** criar cobrança por método (**PIX** com QR/copia-e-cola fake,
  **CARTÃO** com aprovação/recusa + **parcelamento**, **BOLETO** com linha digitável fake),
  **pagamento recorrente** (assinatura simples), consulta de status, **webhook de
  confirmação** (assíncrono), e controle determinístico de resultado para testar sucesso e
  falha.
- **Dentro — Frete fake:** **cotação por CEP** (origem→destino, usando peso/dimensões das
  variantes) devolvendo opções (PAC/SEDEX/Transportadora) com preço+prazo; **retirada na
  loja**; **rastreamento** com eventos que evoluem (postado→em trânsito→saiu para entrega→
  entregue); webhook `shipment.updated`.
- **Fora (non-goals):** integração real com PSP/Correios; antifraude; cálculo tributário
  (impostos ficam em Fase 2 como campos); geração de PDF de boleto real (só linha digitável
  fake). NF-e fake é do épico [f2-customers-orders].

## Requisitos funcionais (EARS)

### Pagamento
1. QUANDO o app cria uma cobrança **PIX**, o sistema DEVE retornar um `paymentId`, um
   **QR code fake** (payload copia-e-cola) e status `PENDING`. _(aceite: campos presentes.)_
2. QUANDO o app cria uma cobrança **CARTÃO**, o sistema DEVE aceitar `installments` e retornar
   aprovação **imediata** (síncrona) conforme regra determinística. _(aceite: parcelas
   refletidas; aprovado/recusado controlável.)_
3. QUANDO o app cria um **BOLETO**, o sistema DEVE retornar **linha digitável** e código de
   barras fake e status `PENDING`. _(aceite: linha digitável no formato plausível.)_
4. Para simular confirmação **assíncrona** (PIX/boleto), o sistema DEVE, após um gatilho
   (endpoint `/sandbox/payments/:id/settle` ou tempo simulado), mudar o status para
   `APPROVED`/`DECLINED` e **emitir webhook** `payment.approved`/`payment.declined`.
   _(aceite: settle dispara o webhook e atualiza o pedido ligado.)_
5. O sistema DEVE permitir **forçar o resultado** (`simulate: approve|decline`) para testar
   os dois caminhos de forma determinística. _(aceite: decline não baixa estoque — integra
   [f1-inventory].)_
6. Para **recorrente**, o sistema DEVE criar uma assinatura que gera cobranças periódicas
   (simuladas) e emite webhook a cada ciclo. _(aceite: avançar ciclo gera nova cobrança +
   evento.)_
7. O sistema DEVE expor **consulta de status** de uma cobrança. _(aceite: `GET
   /v1/sandbox/payments/:id`.)_

### Frete
8. QUANDO o app pede **cotação** com CEP de destino e o carrinho/pedido, o sistema DEVE
   calcular preço+prazo por **serviço** a partir de peso/dimensões (tabela fake
   determinística por faixa de peso × distância de CEP). _(aceite: itens mais pesados/
   distantes custam mais; resultado estável.)_
9. SE uma promoção **FREE_SHIPPING** se aplica, ENTÃO a cotação DEVE zerar o frete do serviço
   elegível. _(aceite: integra [f1-promotions].)_
10. O sistema DEVE oferecer **retirada na loja** como opção de frete custo 0. _(aceite: opção
    presente.)_
11. QUANDO um pedido é despachado, o sistema DEVE criar um **rastreamento** cujos eventos
    **evoluem** por um gatilho (`/sandbox/shipments/:id/advance`), emitindo `shipment.updated`
    a cada mudança. _(aceite: advance progride o status e dispara webhook.)_

## Requisitos não-funcionais (NFRs)
- **Determinismo:** dado o mesmo input, cotação/aprovação são reproduzíveis (bom para aula e
  para as **missões** de correção — [f3]).
- **Segurança (ADR-G7):** nunca aceitar/armazenar dados reais de cartão (só um token fake);
  deixar explícito que é sandbox; validação de input (CEP, valores).
- **Clareza:** Swagger marca cada rota como **SANDBOX/FAKE**; docs orientam o aluno.

## Critérios de aceite globais
- [ ] PIX/cartão/boleto/recorrente criam cobrança e confirmam (sincrono e via webhook).
- [ ] `simulate` controla sucesso/falha; decline não baixa estoque.
- [ ] Cotação por CEP determinística usando peso/dimensões; retirada na loja; free shipping.
- [ ] Rastreamento evolui e emite `shipment.updated`.
- [ ] Nenhum dado real de cartão é aceito/persistido.
