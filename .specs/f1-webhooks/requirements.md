# Requirements — Webhooks (f1-webhooks)

## Objetivo
Permitir que cada grupo **registre URLs de webhook** e receba **eventos** do backend em
tempo real (ex.: `order.paid`, `product.low_stock`), com entrega confiável (retry),
assinatura para verificação e um **inspector** para depurar. É a experiência central de
"integrar um SaaS de verdade".

## Contexto e suposições
- Entrega via padrão **Outbox** (ADR-G5): o evento é gravado na mesma transação do estado; um
  relay envia. Isso garante que um `order.paid` nunca se perca por falha de rede.
- A URL de destino é **fornecida pelo grupo** → superfície de **SSRF** (secure-coding A10) →
  exige allowlist/validação.
- Suposição: entrega **at-least-once** (o consumidor deve ser idempotente); assinatura
  **HMAC-SHA256** com um `signingSecret` por endpoint.

## Escopo
- **Dentro:** CRUD de endpoints de webhook por grupo (URL + eventos assinados + secret);
  catálogo de **tipos de evento**; geração de eventos no Outbox; relay com **retry
  exponencial** e **dead-letter**; assinatura HMAC + timestamp (anti-replay); **inspector**
  (histórico de entregas com status/resposta) e **reenvio manual**; endpoint de **teste**
  (ping).
- **Fora (non-goals):** GraphQL subscriptions; webhooks de entrada (receber de terceiros —
  isso é o sandbox de pagamento); filas externas (Kafka/SQS) — relay é in-process/DB.

## Requisitos funcionais (EARS)

1. O sistema DEVE permitir ao grupo registrar um **WebhookEndpoint** (URL HTTPS + lista de
   eventos + descrição) e receber de volta um **signingSecret** (mostrado uma vez).
   _(aceite: CRUD; secret só aparece na criação/rotação.)_
2. SE a URL informada aponta para host **interno/privado/metadata** (localhost, 127.0.0.1,
   169.254.169.254, ranges privados) ou esquema não-HTTPS, ENTÃO o sistema DEVE recusar o
   registro. _(aceite: URL interna → 400; SSRF bloqueado.)_
3. QUANDO ocorre um evento assinado por um endpoint (ex.: pagamento aprovado → `order.paid`),
   o sistema DEVE **gravar o evento no Outbox na mesma transação** do estado. _(aceite: se a
   transação do pedido falha, o evento não é criado; se sucede, o evento existe.)_
4. O relay DEVE **entregar** cada evento pendente via HTTP POST ao endpoint, com header
   `X-Signature: sha256=<hmac>` e `X-Timestamp`. _(aceite: consumidor valida a assinatura com
   o secret e confere.)_
5. SE a entrega falha (timeout/≥400), ENTÃO o sistema DEVE **repetir** com backoff
   exponencial até N tentativas; após esgotar, marcar como **dead-letter**. _(aceite: destino
   offline → tentativas registradas; esgota → dead-letter.)_
6. O sistema DEVE registrar cada **tentativa de entrega** (status HTTP, corpo resumido,
   duração) consultável pelo grupo (**inspector**). _(aceite: histórico por evento/endpoint.)_
7. O grupo DEVE poder **reenviar** manualmente um evento e disparar um **ping** de teste.
   _(aceite: reenvio cria nova tentativa; ping entrega um evento `webhook.ping`.)_
8. O sistema DEVE **isolar por tenant**: um grupo só vê/gerencia seus endpoints e entregas.
   _(aceite: grupo A não acessa webhook de B.)_

## Requisitos não-funcionais (NFRs)
- **Confiabilidade (ADR-G5):** at-least-once; nenhum evento perdido por falha do consumidor.
- **Segurança (ADR-G7):** anti-SSRF na URL; assinatura HMAC; `X-Timestamp` + tolerância
  (anti-replay); secret guardado com cuidado (não logado, mostrado 1x).
- **Noisy neighbor (multi-tenant):** um endpoint lento/offline de um grupo não pode travar a
  entrega dos outros (isolamento/concorrência no relay + timeouts curtos).
- **Observabilidade:** métricas de entrega (taxa de sucesso, fila, dead-letter) por tenant.

## Critérios de aceite globais
- [ ] Registro com validação anti-SSRF; secret HMAC por endpoint.
- [ ] Evento gravado no Outbox atômico com o estado; relay entrega assinado.
- [ ] Retry com backoff + dead-letter; inspector + reenvio + ping.
- [ ] Isolamento por tenant; destino ruim de um grupo não afeta os demais.
