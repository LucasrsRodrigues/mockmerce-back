# Tasks — Promoções e Cupons (f1-promotions)

- [ ] **T1 — Modelagem Prisma (Promotion, Coupon, PromotionRedemption) + snapshot no Order** _(req: 1,9)_
  - `config Json`, contadores de uso, `Order.appliedPromotions`/`discountTotal`.
  - Verificação: migração aplica; CRUD básico de promoção.
- [ ] **T2 — Zod schemas de `config` por tipo** _(req: 1)_ · dep: T1
  - Validação por tipo (PERCENT/FIXED/FREE_SHIPPING/BUY_X_GET_Y/PROGRESSIVE).
  - Verificação: config inválida → 400 com detalhe.
- [ ] **T3 — Motor puro `calcularDescontos` + strategies** _(req: 2b,3,4,5)_ · dep: T2
  - Função pura + uma strategy por tipo; combinabilidade por `stackable`/`priority`.
  - Verificação: **tabela de casos** unit para cada tipo (inclui limites e sem elegibilidade).
- [ ] **T4 — Aplicar no carrinho + mensagens de elegibilidade** _(req: 2,2b,3)_ · dep: T3
  - `GET /v1/cart` retorna descontos e "faltam R$X"; cupom manual em `POST /v1/cart/coupon`.
  - Verificação: cupom válido aplica; inválido/expirado → 422 com motivo.
- [ ] **T5 — Restrições (cliente/categoria/produto/janela)** _(req: 8)_ · dep: T3
  - Condições avaliadas no motor a partir do snapshot + contexto do cliente.
  - Verificação: cliente/categoria fora do escopo não recebe.
- [ ] **T6 — Limites de uso atômicos** _(req: 7)_ · dep: T1,T4
  - `UPDATE ... WHERE usedCount<maxUses`; redemption por cliente.
  - Verificação: teste de concorrência não estoura o limite.
- [ ] **T7 — Snapshot imutável no checkout** _(req: 9,10)_ · dep: T4, [f1-inventory]
  - Congelar descontos no pedido; aplicar combinabilidade final.
  - Verificação: alterar promoção depois não muda pedido antigo.
- [ ] **T8 — FREE_SHIPPING integra com frete fake** _(req: 6)_ · dep: [f1-sandbox-integrations]
  - Zerar frete na cotação quando a condição bate.
  - Verificação: cotação retorna frete 0 sob a promoção.
- [ ] **T9 — Swagger + SDK + guia dos alunos** _(req: todos)_ · dep: T4–T8
  - Documentar os 5 tipos com exemplos.
  - Verificação: `/docs` e `sdk` atualizados; exemplos no INTEGRACAO.md.
- [ ] **T10 — Revisão de segurança/ética** _(req: NFR)_ · dep: T3–T9
  - Allowlist de config; anti-corrida no limite; mensagens sem dark pattern (ADR-G9).
  - Verificação: checklists preenchidos.

## Estratégia de testes
Motor = **unit puro com tabelas de casos** (o mais valioso). Integration para limites/
concorrência e snapshot. e2e: aplicar cupom → checkout → pedido reflete desconto congelado.
