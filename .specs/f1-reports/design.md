# Design — Relatórios e Dashboard (f1-reports)

## Skills aplicadas
| Skill | Por que | Princípio aplicado aqui |
|---|---|---|
| domain-driven-design | Leitura ≠ escrita | **CQRS leve**: read models/queries dedicados, sem tocar aggregates |
| clean-architecture | Módulo isolado | Camada de query separada; não reusa services de escrita |
| secure-coding | Export CSV | Prevenção de **CSV injection**; isolamento por grupo |
| multi-tenant-saas | Métrica por tenant | Toda agregação carrega/filtra `groupId` (base p/ cost-per-tenant no futuro) |

## Visão geral
Módulo **read-only** que roda agregações SQL (via Prisma `groupBy`/`$queryRaw` parametrizado)
sobre `Order`/`OrderItem`/`StockBalance`, sempre filtrando por `groupId` + período. Cada
relatório tem uma função de query + um serializador JSON/CSV.

## Componentes e responsabilidades
- **reports.queries** — uma função por relatório (pura em relação ao request; só lê).
- **csv.serializer** — converte linhas em CSV com sanitização anti-injeção.
- **reports.routes** — valida `from/to/format`, chama query, responde JSON ou CSV.

## Dados
- Sem novas tabelas. Índices adicionais: `Order(groupId, status, createdAt)`,
  `OrderItem(orderId)` já existente, `StockBalance(groupId, ...)`.
- Fonte da verdade: pedidos com `status=PAID` (receita), `OrderItem` (quantidades).

## Interfaces / APIs (`/v1/reports`)
- `GET /v1/reports/sales?from&to&format` — resumo + (opcional) série.
- `GET /v1/reports/top-products?from&to&limit&by=qty|revenue&format`.
- `GET /v1/reports/customers?from&to&format` — recorrentes vs novos.
- `GET /v1/reports/inventory?format` — abaixo do mínimo / sem estoque.
- Todos aceitam `format=json|csv` (default json).

## Decisões (ADRs resumidos)
- **ADR-1 — CQRS leve, sem event sourcing.** Agregação direta sobre as tabelas
  transacionais basta na escala de ensino; não há read store separado. Trade-off: consultas
  pesadas em período grande — mitigado por índices + cache curto opcional. _(DDD: CQRS onde
  agrega valor; não sobre-engenheirar.)_
- **ADR-2 — Receita só de pedidos PAID.** Define claramente a fonte da verdade; evita contar
  pedidos pendentes/cancelados. _(consistência de leitura.)_
- **ADR-3 — CSV com sanitização anti-injeção.** Células iniciando com `= + - @` são
  prefixadas com `'`. _(secure-coding: CSV/Formula injection.)_

## Riscos e mitigações
- **Query lenta em muitos pedidos** → índices compostos + `EXPLAIN` no teste; cache curto.
- **Divergência de número** → testes que comparam agregação com soma manual de fixtures.
- **CSV injection** → sanitização + testes com payload `=cmd()`.
