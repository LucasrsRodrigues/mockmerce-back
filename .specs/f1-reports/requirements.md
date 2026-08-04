# Requirements — Relatórios e Dashboard (f1-reports)

## Objetivo
Expor métricas de negócio por grupo (vendas, produtos mais vendidos, ticket médio, receita,
clientes recorrentes, estoque) com **exportação CSV**. Faz o sistema "sentir" como um SaaS e
dá dados para o app do aluno montar o painel dele.

## Contexto e suposições
- Subdomínio **supporting**: são **agregações de leitura** sobre pedidos/estoque existentes.
- Aplica **CQRS leve** (DDD): endpoints de leitura otimizados, sem tocar a lógica de escrita.
- Período configurável (`from`/`to`); tudo escopado por grupo (ADR-G2).

## Escopo
- **Dentro:** resumo de vendas por período (receita, nº pedidos, ticket médio, itens);
  série temporal (por dia); produtos/variantes mais vendidos; clientes recorrentes vs novos;
  status de estoque (abaixo do mínimo, sem estoque); **export CSV** de cada relatório.
- **Fora (non-goals):** lucro/margem real (exige custo do produto — pode entrar depois como
  campo `cost`); BI/dashboards visuais (é do app do aluno); data warehouse.

## Requisitos funcionais (EARS)

1. QUANDO o app pede o **resumo de vendas** com `from/to`, o sistema DEVE retornar receita
   total (só pedidos pagos), nº de pedidos, **ticket médio** e itens vendidos. _(aceite:
   valores batem com os pedidos do período.)_
2. O sistema DEVE retornar uma **série diária** de receita/pedidos no período. _(aceite: soma
   da série = total do resumo.)_
3. O sistema DEVE listar **produtos/variantes mais vendidos** por quantidade e por receita,
   com top-N. _(aceite: ordenação correta; respeita período.)_
4. O sistema DEVE distinguir **clientes recorrentes** (≥2 pedidos pagos) de novos e retornar
   contagens/receita por grupo. _(aceite: cliente com 2 pedidos conta como recorrente.)_
5. O sistema DEVE retornar **status de estoque**: itens abaixo do mínimo e sem disponível.
   _(aceite: reflete o [f1-inventory].)_
6. QUANDO o app pede `?format=csv`, o sistema DEVE devolver o relatório como **CSV**
   (`text/csv`) com cabeçalho. _(aceite: CSV abre em planilha; colunas corretas.)_
7. O sistema DEVE considerar **apenas dados do grupo** e do período informado. _(aceite:
   isolamento verificado.)_

## Requisitos não-funcionais (NFRs)
- **Performance:** consultas agregadas usam índices por `(groupId, createdAt, status)`;
  período grande não faz table scan. Cache curto opcional por (grupo, relatório, período).
- **Isolamento/segurança (ADR-G2/G7):** `X-API-Key`; CSV sem fórmula injetável (prevenir
  **CSV injection** — prefixar células que começam com `= + - @`).
- **Consistência de leitura:** valores derivados sempre de pedidos **pagos** (fonte da
  verdade), nunca de estados transitórios.

## Critérios de aceite globais
- [ ] 5 relatórios (vendas, série, mais vendidos, recorrentes, estoque) corretos e por grupo.
- [ ] Export CSV com cabeçalho e sem injeção de fórmula.
- [ ] Isolamento e período respeitados; performance com índices.
