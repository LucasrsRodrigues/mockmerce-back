# Tasks — Integrações Sandbox: Pagamento e Frete (f1-sandbox-integrations)

- [ ] **T1 — Modelagem Prisma (SandboxPayment, Subscription, Shipment, TrackingEvent)** _(req: 1–11)_
  - Verificação: migração aplica.
- [ ] **T2 — Pagamento: criar cobrança por método (PIX/cartão/boleto)** _(req: 1,2,3)_ · dep: T1
  - Gerar QR/linha digitável/token fake; parcelamento no cartão; regra determinística de aprovação.
  - Verificação: cada método retorna os campos certos; cartão aprova/recusa por regra.
- [ ] **T3 — `settle` assíncrono + `simulate` + webhooks payment.*** _(req: 4,5)_ · dep: T2, [f1-webhooks]
  - Mudar status e emitir `payment.approved/declined`; decline não baixa estoque.
  - Verificação: settle dispara webhook e atualiza o pedido; decline mantém estoque.
- [ ] **T4 — Recorrente (assinatura + advance)** _(req: 6)_ · dep: T2
  - Ciclos simulados com webhook por cobrança.
  - Verificação: advance gera nova cobrança + evento.
- [ ] **T5 — Consulta de status + migrar `/orders/:id/pay` p/ delegar ao sandbox** _(req: 7)_ · dep: T3
  - Unificar o pagamento atual com o sandbox mantendo `simulate`.
  - Verificação: fluxo antigo continua funcionando via sandbox.
- [ ] **T6 — Frete: motor de cotação puro (peso/dims × CEP)** _(req: 8,10)_ · dep: [f1-catalog-variants]
  - Tabela em código; serviços PAC/SEDEX/Transportadora + retirada na loja.
  - Verificação: unit — pesado/distante custa mais; resultado estável.
- [ ] **T7 — Free shipping integra promoções** _(req: 9)_ · dep: T6, [f1-promotions]
  - Zerar serviço elegível.
  - Verificação: cotação retorna 0 sob a promoção.
- [ ] **T8 — Despacho + rastreamento + advance + webhook shipment.updated** _(req: 11)_ · dep: T1,[f1-webhooks]
  - Máquina de estados do envio; advance progride e emite evento.
  - Verificação: advance evolui status e dispara webhook.
- [ ] **T9 — Swagger (rótulo SANDBOX) + SDK + guia** _(req: NFR clareza)_ · dep: T2–T8
  - Marcar rotas como fake; exemplos no INTEGRACAO.md.
  - Verificação: `/docs` mostra a seção sandbox rotulada.
- [ ] **T10 — Revisão de segurança** _(req: NFR)_ · dep: T2–T9
  - Recusar PAN real; nada sensível persistido; input validado (CEP/valor).
  - Verificação: checklist secure-coding.

## Estratégia de testes
Unit (regra de aprovação, cotação pura). Integration (settle→webhook→commit estoque;
tracking advance→webhook). e2e: comprar → cotar frete → pagar (PIX settle) → estoque baixa →
webhooks `order.paid`/`shipment.updated` chegam.
