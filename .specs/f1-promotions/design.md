# Design — Promoções e Cupons (f1-promotions)

## Skills aplicadas
| Skill | Por que | Princípio aplicado aqui |
|---|---|---|
| domain-driven-design | Lógica de negócio rica (core-ish) | **Domain model** para o motor; `Promotion` como aggregate; `Discount` value object; regra pura |
| clean-code | Cálculo testável | Motor de cálculo é **função pura** (carrinho + regras → descontos), sem I/O |
| secure-coding | Limites de uso | Contagem de uso com update atômico (anti-corrida) |
| ux-design | Exposição no carrinho | Mensagens de progresso claras, sem dark pattern (ADR-G9) |

## Visão geral — motor de regras puro
Separa **avaliação** (pura) de **aplicação/persistência** (efeito). O coração é:

```
calcularDescontos(cartSnapshot, activePromotions, customerCtx) -> AppliedDiscount[]
```
função **determinística e pura** — recebe um snapshot (itens, quantidades, preços,
categorias, cliente) e as promoções ativas, devolve os descontos. Fácil de testar com
tabelas de casos. A camada de serviço busca as promoções ativas, chama o motor, e (no
checkout) persiste o snapshot e incrementa contadores de uso.

## Componentes e responsabilidades
- **promotion.engine (puro)** — avalia cada tipo (strategy por tipo: PercentRule, FixedRule,
  FreeShippingRule, BuyXGetYRule, ProgressiveRule) + resolve **combinabilidade**.
- **promotion.service** — CRUD de promoções; buscar ativas por grupo; aplicar no carrinho;
  no checkout, validar limites, gravar snapshot, incrementar uso (atômico).
- **coupon** — mapeia `code → promotionId`; valida janela/limite.
- Integração: carrinho chama o motor no `GET /cart`; checkout congela o resultado no pedido.

## Dados (Prisma)
- `Promotion(groupId, name, type, active, startsAt?, endsAt?, config Json, maxUses?,
  maxUsesPerCustomer?, usedCount, stackable Boolean, priority Int)`.
  `config` guarda os parâmetros do tipo (ex.: `{percent:10, minSubtotal:100}`,
  `{buy:2,get:1,scope:...}`, faixas do progressive).
- `Coupon(groupId, code, promotionId)` — `@@unique([groupId, code])`.
- `PromotionCondition` (ou dentro de `config`): minSubtotal, categoryIds, variantIds,
  customerSegmentId, ...
- `PromotionRedemption(groupId, promotionId, customerId, orderId, amount, createdAt)` — para
  limite por cliente e auditoria.
- `Order.appliedPromotions Json` (snapshot) + `Order.discountTotal`.

> **`config` como Json validado por Zod** por tipo — flexível sem explodir o schema; a
> validação por tipo mora no service (allowlist — secure-coding).

## Interfaces / APIs (`/v1`)
- `GET/POST /v1/promotions`, `PATCH/DELETE /v1/promotions/:id` — app do grupo.
- `POST /v1/promotions/:id/coupons` — gera/associa código.
- `POST /v1/cart/coupon` `{code}` / `DELETE /v1/cart/coupon` — cliente aplica/remove.
- `GET /v1/cart` — passa a retornar `discounts[]`, `discountTotal`, e **mensagens de
  elegibilidade** ("faltam R$X para 10% off").

## Decisões (ADRs resumidos)
- **ADR-1 — Motor puro separado da persistência.** Alternativa: calcular dentro do handler
  com queries no meio (difícil de testar). Escolha: função pura + strategies por tipo.
  Trade-off: precisa montar um snapshot de entrada; ganho: determinismo e cobertura de teste
  alta. _(clean-code; DDD domain model com propósito único.)_
- **ADR-2 — `config` como Json validado por tipo.** Alternativa: uma tabela por tipo de
  promoção (rígido, muitas migrações). Escolha: Json + Zod schema por tipo. Trade-off: menos
  garantias no banco; mitigado por validação forte na borda. _(secure-coding: allowlist.)_
- **ADR-3 — Snapshot imutável no pedido (ADR-G8/DDD).** O pedido é fonte da verdade do que
  foi cobrado; mudar promoção depois não reescreve o passado. _(DDD: pedido é registro do
  que aconteceu.)_
- **ADR-4 — Combinabilidade explícita por `stackable`+`priority`.** Motor ordena por
  prioridade e respeita "1 cupom manual + automáticas". Trade-off: regra de negócio a
  documentar bem para os alunos.

## Riscos e mitigações
- **Estouro de limite sob concorrência** → incremento atômico `UPDATE ... SET usedCount=
  usedCount+1 WHERE usedCount < maxUses` (compare-and-set); se 0 linhas, recusa.
- **Descontos negativos/total < 0** → clamp em 0; invariante no value object `Money`.
- **Complexidade percebida pelos alunos** → documentar os 5 tipos com exemplos no `/docs` e
  no guia de integração.
