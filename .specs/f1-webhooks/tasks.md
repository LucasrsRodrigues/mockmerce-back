# Tasks — Webhooks (f1-webhooks)

- [ ] **T1 — Modelagem Prisma (WebhookEndpoint, OutboxEvent, WebhookDelivery)** _(req: 1,3,6)_
  - Índices do relay `(status,nextAttemptAt)` e do inspector `(groupId,createdAt)`.
  - Verificação: migração aplica.
- [ ] **T2 — API interna `outbox.emit(groupId,type,payload,tx)`** _(req: 3)_ · dep: T1
  - Grava evento **na transação** recebida.
  - Verificação: falha da tx não cria evento; sucesso cria.
- [ ] **T3 — url-guard anti-SSRF** _(req: 2)_ · dep: —
  - Resolver host; bloquear loopback/privado/metadata; exigir HTTPS; sem redirect p/ interno.
  - Verificação: unit com URLs internas → rejeita; pública HTTPS → aceita.
- [ ] **T4 — CRUD de endpoints + secret + rotação** _(req: 1,8)_ · dep: T1,T3
  - Secret HMAC gerado (CSPRNG), hash no banco, mostrado 1x; isolamento por grupo.
  - Verificação: grupo A não vê endpoint de B; secret só na criação/rotação.
- [ ] **T5 — signer HMAC + headers** _(req: 4)_ · dep: T4
  - `X-Signature: sha256=…`, `X-Timestamp`.
  - Verificação: consumidor de teste valida a assinatura.
- [ ] **T6 — relay worker (fan-out + concorrência + timeout)** _(req: 4,5)_ · dep: T2,T5
  - Lê pendentes, entrega por endpoint, timeout curto, concorrência limitada.
  - Verificação: destino ok recebe; destino lento não trava os demais.
- [ ] **T7 — retry backoff + dead-letter** _(req: 5)_ · dep: T6
  - Agenda `nextAttemptAt`; após N falhas → DEAD_LETTER.
  - Verificação: destino offline gera tentativas e vira dead-letter.
- [ ] **T8 — inspector + reenvio + ping** _(req: 6,7)_ · dep: T6
  - Histórico de entregas; `resend`; `ping`.
  - Verificação: reenvio cria nova tentativa; ping entrega `webhook.ping`.
- [ ] **T9 — Ligar produtores de evento** _(req: 3)_ · dep: T2, [f1-inventory], orders
  - Emitir `order.paid/created/cancelled`, `product.low_stock`, `payment.*`.
  - Verificação: pagar um pedido dispara `order.paid` no endpoint inscrito.
- [ ] **T10 — Swagger + SDK + guia (verificar assinatura)** _(req: todos)_ · dep: T4–T9
  - Documentar payloads, headers e exemplo de verificação de assinatura para o aluno.
  - Verificação: `/docs` + exemplo no INTEGRACAO.md.
- [ ] **T11 — Revisão de segurança** _(req: NFR)_ · dep: T3–T10
  - SSRF, HMAC, anti-replay, secret não logado, isolamento.
  - Verificação: checklist secure-coding (A10 incluso).

## Estratégia de testes
Unit (url-guard, signer, backoff). Integration: Outbox atômico; relay contra um servidor de
teste (sucesso/timeout/erro→dead-letter). e2e: pagar pedido → webhook `order.paid` assinado
chega. Métrica de taxa de sucesso/dead-letter por tenant.
