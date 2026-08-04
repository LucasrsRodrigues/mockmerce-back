# Design — Integrações Sandbox: Pagamento e Frete (f1-sandbox-integrations)

## Skills aplicadas
| Skill | Por que | Princípio aplicado aqui |
|---|---|---|
| domain-driven-design | Pagamento/frete são **generic** | Simulação simples (transaction script), **published language** estável imitando PSPs reais |
| api-architecture | Imitar API externa north-south | Contrato tipo-PSP (create charge → status → webhook); idempotência |
| secure-coding | Dados de cartão | **Nunca** aceitar PAN real; token fake; sandbox explícito |
| flow-architectures (implícito) | Confirmação assíncrona | Callback via evento/webhook, não polling acoplado |

## Visão geral
Dois "provedores fake" com contratos parecidos com PSPs/transportadoras reais, para o aluno
aprender o **shape** de uma integração: `criar → obter status → receber webhook`. A
confirmação assíncrona (PIX/boleto) usa o Outbox/webhook do [f1-webhooks]. Tudo
**determinístico** para ser testável e para as missões [f3] detectarem uso.

```
Pagamento:  POST /sandbox/payments  -> {id, method, status:PENDING, pix/boleto/card}
            POST /sandbox/payments/:id/settle (ou simulate) -> APPROVED/DECLINED
                         └─ emite webhook payment.approved -> atualiza Order -> commit estoque
Frete:      POST /sandbox/shipping/quote {cepDestino, itens} -> [ {servico, preco, prazo} ]
            POST /sandbox/shipments (despacho) -> tracking; /advance -> evolui + webhook
```

## Componentes e responsabilidades
- **payments.sandbox.service** — cria cobrança por método (gera QR/linha digitável/token
  fake), aplica regra determinística de aprovação, `settle` assíncrono, recorrência.
- **shipping.sandbox.service** — motor de cotação **puro** (peso/dims × faixa de CEP →
  tabela), retirada na loja, criação de tracking e `advance`.
- **tracking** — máquina de estados de envio (POSTED→IN_TRANSIT→OUT_FOR_DELIVERY→DELIVERED).
- Integração: aprovação de pagamento chama `inventory.commit` e emite eventos; cotação
  consulta promoções (free shipping).

## Dados (Prisma)
- `SandboxPayment(groupId, orderId?, method, amount, installments?, status, providerRef,
  pixPayload?, boletoLine?, cardTokenFake?, createdAt)`.
- `SandboxSubscription(groupId, customerId, amount, intervalDays, nextChargeAt, status)`.
- `Shipment(groupId, orderId, service, cost, etaDays, status, trackingCode)`.
- `TrackingEvent(shipmentId, status, description, createdAt)` — append.
- Tabela de tarifas de frete = **constante em código** (determinística), não no banco.

## Interfaces / APIs (`/v1/sandbox`)
- `POST /v1/sandbox/payments` `{method, amount, installments?, orderId?, simulate?}`
- `GET /v1/sandbox/payments/:id` · `POST /v1/sandbox/payments/:id/settle`
- `POST /v1/sandbox/subscriptions` · `POST /v1/sandbox/subscriptions/:id/advance`
- `POST /v1/sandbox/shipping/quote` `{cepDestino, items|orderId}`
- `POST /v1/sandbox/shipments` · `GET /v1/sandbox/shipments/:id` ·
  `POST /v1/sandbox/shipments/:id/advance`
- **Migração do pagamento atual:** o `POST /orders/:id/pay` existente passa a delegar ao
  sandbox de pagamento (mantendo o campo `simulate`), unificando o fluxo.

## Decisões (ADRs resumidos)
- **ADR-1 — Contrato imitando PSP real (published language).** Nomes/fluxo parecidos com
  Stripe/Mercado Pago (create charge, webhook de confirmação). Ganho: o aluno aprende um
  padrão transferível. _(DDD OHS/published language; api-architecture: contrato estável.)_
- **ADR-2 — Cotação de frete é função pura + tabela em código.** Determinismo p/ testes e
  missões; sem dependência externa. Trade-off: não reflete tarifa real (aceitável, é fake).
- **ADR-3 — Confirmação assíncrona via webhook, com gatilho manual `settle`.** Em vez de
  timers escondidos, um endpoint explícito avança o estado — o aluno **provoca** o callback e
  entende o assíncrono. Também dá determinismo. _(flow-architectures: eventing explícito.)_
- **ADR-4 — Zero dado real de cartão.** Só um token fake; recusar qualquer PAN. Sandbox
  rotulado no Swagger. _(secure-coding: minimizar dado sensível/attack surface; PCI-safe.)_

## Riscos e mitigações
- **Aluno achar que é gateway real** → rótulo SANDBOX no Swagger + docs; sem persistir cartão.
- **Acoplar pagamento↔estoque errado** → aprovação emite evento; o `commit` de estoque
  reage ao evento (idempotente), não é chamada síncrona rígida.
- **Cotação não-determinística** → tabela fixa + função pura (teste trava o resultado).
