# Requirements — Promoções e Cupons (f1-promotions)

## Objetivo
Adicionar um **motor de regras de promoção** ao carrinho/checkout: cupom (percentual/fixo),
frete grátis, "compre X leve Y", desconto progressivo e promoções por categoria/cliente.
É um subdomínio **core-ish** (lógica rica, alto valor de aprendizado).

## Contexto e suposições
- Aplica sobre o carrinho existente (por cliente) e o checkout (que agora reserva estoque —
  [f1-inventory]).
- Suposição: descontos são calculados **na hora** (carrinho e no fechamento do pedido), a
  partir das regras ativas do grupo; o pedido guarda um **snapshot** dos descontos aplicados.
- Value objects `Money`/percentual (ADR-G8). Sem acúmulo abusivo: **regras de combinação**
  explícitas (ex.: 1 cupom por pedido + N promoções automáticas).

## Escopo
- **Dentro:** entidade Promoção com **tipos** (PERCENT, FIXED, FREE_SHIPPING, BUY_X_GET_Y,
  PROGRESSIVE) e **condições** (valor mínimo, categoria, produto/variante, grupo de cliente,
  janela de datas, limite de uso total e por cliente); **cupom** (código que ativa uma
  promoção); cálculo e **preview** no carrinho; snapshot no pedido; combinabilidade.
- **Fora (non-goals):** cashback/pontos de fidelidade, brindes físicos como item de estoque,
  promoções escalonadas por marketplace externo.

## Requisitos funcionais (EARS)

1. O sistema DEVE permitir ao app do grupo criar uma **Promoção** com tipo, condições e
   janela de validade. _(aceite: CRUD de promoção; promoção fora da janela não aplica.)_
2. QUANDO um cliente aplica um **cupom** válido no carrinho, o sistema DEVE recalcular e
   retornar o carrinho com o **desconto detalhado por linha e total**. _(aceite: `GET/POST
   /v1/cart/coupon` mostra desconto; cupom inválido/expirado → 422 com motivo.)_
2b. QUANDO o carrinho satisfaz uma promoção **automática** (sem código), o sistema DEVE
   aplicá-la sem cupom. _(aceite: atingir valor mínimo aplica o desconto sozinho.)_
3. SE a condição de **valor mínimo** não é atingida, ENTÃO o sistema DEVE **não** aplicar e
   informar o motivo. _(aceite: abaixo do mínimo → desconto 0 + mensagem.)_
4. Para **BUY_X_GET_Y**, QUANDO o cliente tem X unidades qualificadas, o sistema DEVE tornar
   Y unidades grátis (ou com desconto). _(aceite: 3 no carrinho, "compre 2 leve 3" → 1 grátis.)_
5. Para **PROGRESSIVE**, o sistema DEVE aplicar desconto crescente por faixa de quantidade/
   valor. _(aceite: faixas definidas retornam o percentual da faixa correta.)_
6. Para **FREE_SHIPPING**, o sistema DEVE zerar o frete na cotação do pedido quando a
   condição bate. _(aceite: integra com frete fake — [f1-sandbox-integrations].)_
7. SE uma promoção tem **limite de uso** (total ou por cliente) atingido, ENTÃO o sistema
   DEVE recusar novas aplicações. _(aceite: 2º uso além do limite → 422.)_
8. SE a promoção é restrita a um **grupo de clientes**/categoria/produto, ENTÃO só DEVE
   aplicar quando o carrinho/cliente se qualifica. _(aceite: cliente fora do grupo não recebe.)_
9. QUANDO o pedido é criado, o sistema DEVE gravar um **snapshot** das promoções aplicadas e
   o valor descontado, imutável no pedido. _(aceite: mudar a promoção depois não altera
   pedidos passados.)_
10. O sistema DEVE aplicar as **regras de combinabilidade** (ex.: 1 cupom manual + N
    automáticas; não empilhar dois cupons). _(aceite: 2 cupons → o 2º é recusado/subst.)_

## Requisitos não-funcionais (NFRs)
- **Determinismo:** dado o mesmo carrinho e regras, o resultado é sempre o mesmo (motor puro,
  testável). _(clean-code: função pura no core do cálculo.)_
- **Isolamento/segurança (ADR-G2/G7):** promoções e limites são por grupo; contagem de uso
  protegida contra corrida (não estourar limite sob concorrência).
- **Ética (ADR-G9):** ao expor no carrinho, mensagens claras ("faltam R$X para o desconto"),
  sem urgência falsa.

## Critérios de aceite globais
- [ ] 5 tipos de promoção calculam corretamente e são testáveis isoladamente.
- [ ] Cupom aplica/recusa com motivo; automáticas aplicam sozinhas.
- [ ] Limites de uso e restrições (cliente/categoria) respeitados, inclusive sob concorrência.
- [ ] Snapshot no pedido é imutável.
