# Design — Webhooks (f1-webhooks)

## Skills aplicadas
| Skill | Por que | Princípio aplicado aqui |
|---|---|---|
| domain-driven-design | Entrega confiável de eventos | **Outbox pattern** (evento + estado na mesma transação; relay at-least-once) |
| api-architecture | Integração north-south de saída | Contrato de payload estável/versionado; assinatura; retry |
| secure-coding | URL do consumidor = SSRF | Allowlist de destino, bloqueio de IP interno/metadata, HMAC, anti-replay |
| multi-tenant-saas | Muitos grupos, destinos ruins | Relay concorrente com timeout; isolamento; métricas por tenant |

## Visão geral — Outbox + relay
Produtores de eventos (pedido, estoque, etc.) **não** chamam HTTP. Eles gravam um
`OutboxEvent` na **mesma transação** do estado. Um **relay** (worker in-process com intervalo
curto, ou acionado por notificação) lê eventos pendentes, resolve os endpoints inscritos do
grupo e faz a entrega assinada, registrando cada tentativa.

```
[serviço de pedido]  --tx-->  Order(status=PAID) + OutboxEvent(order.paid)
                                          │
                              [relay] lê pendentes
                                          │  para cada endpoint inscrito do grupo
                              POST url  (X-Signature, X-Timestamp)
                                          │
                              WebhookDelivery(status, attempt, response)
                              sucesso→done | falha→backoff | esgota→dead-letter
```

## Componentes e responsabilidades
- **outbox** — API interna `emit(groupId, type, payload, tx)` usada pelos serviços.
- **webhook.service** — CRUD de endpoints; validação anti-SSRF da URL; rotação de secret.
- **relay worker** — busca `OutboxEvent` pendentes, faz fan-out para endpoints, controla
  concorrência e timeout; agenda retries; move para dead-letter.
- **signer** — HMAC-SHA256(`timestamp.body`, secret) → `X-Signature`.
- **url-guard** — resolve o host, bloqueia privado/loopback/metadata, exige HTTPS.
- **inspector API** — lista entregas/tentativas; reenvio; ping.

## Dados (Prisma)
- `WebhookEndpoint(groupId, url, description, events String[], signingSecretHash, active,
  createdAt)`.
- `OutboxEvent(groupId, type, payload Json, status: PENDING|DISPATCHED, createdAt)` —
  append; marcado DISPATCHED quando todos os endpoints foram tentados.
- `WebhookDelivery(groupId, endpointId, outboxEventId, status: PENDING|SUCCESS|FAILED|
  DEAD_LETTER, attempts, nextAttemptAt, lastStatusCode?, lastResponseSnippet?, createdAt,
  updatedAt)`.
- Índices: `(status, nextAttemptAt)` para o relay; `(groupId, createdAt)` para o inspector.

## Interfaces / APIs (`/v1`)
- `GET/POST /v1/webhooks`, `PATCH/DELETE /v1/webhooks/:id`, `POST /v1/webhooks/:id/rotate-secret`.
- `POST /v1/webhooks/:id/ping` — dispara `webhook.ping`.
- `GET /v1/webhooks/:id/deliveries` — inspector (histórico).
- `POST /v1/webhooks/deliveries/:id/resend` — reenvio manual.
- `GET /v1/webhooks/events` — catálogo de tipos de evento.
- **Catálogo inicial de eventos:** `order.created`, `order.paid`, `order.cancelled`,
  `order.refunded`, `product.low_stock`, `payment.approved`, `payment.declined`,
  `shipment.updated`, `webhook.ping`.

## Decisões (ADRs resumidos)
- **ADR-1 — Outbox in-DB, relay in-process (não fila externa).** Alternativa: Kafka/SQS
  (robusto, porém infra pesada para um projeto de ensino). Escolha: tabela Outbox + worker.
  Trade-off: escala limitada, aceitável aqui; ganho: zero infra extra, didático e visível no
  Prisma Studio. _(DDD Outbox; api-architecture "comece simples".)_
- **ADR-2 — Assinatura HMAC + timestamp (não mTLS/OAuth).** Simples de o aluno verificar em
  qualquer linguagem; `X-Timestamp` com tolerância evita replay. _(secure-coding: integridade
  + anti-replay; api-architecture: JWS-like, nunca segredo no payload.)_
- **ADR-3 — url-guard obrigatório (anti-SSRF).** Sem isso, um grupo poderia apontar o webhook
  para `169.254.169.254` e ler metadata do host. Bloqueio de ranges internos + só HTTPS.
  _(secure-coding A10.)_
- **ADR-4 — Retry com backoff + dead-letter, entrega at-least-once.** Consumidor deve ser
  idempotente (documentado ao aluno). Trade-off: possível entrega duplicada — preferível a
  perder evento. _(DDD at-least-once.)_

## Riscos e mitigações
- **Endpoint lento trava o relay (noisy neighbor)** → timeout curto (ex.: 5s) + concorrência
  limitada + isolamento por grupo; um destino ruim não bloqueia os demais.
- **SSRF via redirect** → não seguir redirects para destino não validado.
- **Vazamento do secret** → hash no banco, mostrado 1x, rotação; nunca logar payload+secret.
- **Tempestade de eventos** → coalescing de `product.low_stock` (já dedup no [f1-inventory]).
