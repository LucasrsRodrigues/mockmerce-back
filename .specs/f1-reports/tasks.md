# Tasks — Relatórios e Dashboard (f1-reports)

- [ ] **T1 — Índices + camada de query read-only** _(req: 7, NFR perf)_
  - `Order(groupId,status,createdAt)`; módulo `reports.queries` isolado.
  - Verificação: `EXPLAIN` usa índice; nenhuma escrita no módulo.
- [ ] **T2 — Resumo de vendas + série diária** _(req: 1,2)_ · dep: T1
  - Receita/pedidos/ticket médio/itens; série por dia.
  - Verificação: soma da série = total; valores batem com fixtures.
- [ ] **T3 — Mais vendidos (por qty e receita)** _(req: 3)_ · dep: T1
  - Top-N configurável.
  - Verificação: ordenação e período corretos.
- [ ] **T4 — Recorrentes vs novos** _(req: 4)_ · dep: T1
  - ≥2 pedidos pagos = recorrente.
  - Verificação: cliente com 2 pedidos conta como recorrente.
- [ ] **T5 — Status de estoque** _(req: 5)_ · dep: [f1-inventory]
  - Abaixo do mínimo / sem disponível.
  - Verificação: reflete os saldos.
- [ ] **T6 — Export CSV com sanitização** _(req: 6, NFR seg)_ · dep: T2–T5
  - `format=csv`; prefixar `= + - @`.
  - Verificação: abre em planilha; payload `=cmd()` neutralizado.
- [ ] **T7 — Swagger + SDK** _(req: todos)_ · dep: T2–T6
  - Documentar; adicionar ao SDK.
  - Verificação: `/docs` completo.
- [ ] **T8 — Revisão de segurança** _(req: NFR)_ · dep: T1–T7
  - Isolamento por grupo; CSV injection; sem `$queryRaw` concatenado.
  - Verificação: checklist secure-coding.

## Estratégia de testes
Unit (serializador CSV + sanitização). Integration (agregações vs fixtures conhecidas;
isolamento). Sem e2e dedicado (coberto pelos fluxos anteriores gerando os dados).
