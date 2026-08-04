# Requirements — Catálogo com Variantes (f1-catalog-variants)

## Objetivo
Evoluir o catálogo (hoje: produto simples + SKU + categoria) para suportar **produtos
variáveis** com **variações** (cor, tamanho) que têm **estoque, preço e SKU próprios**,
além de imagens, tags, coleções, marca, estados de publicação e relacionamentos
(cross-sell/upsell). Base para um catálogo estilo Shopify.

## Contexto e suposições
- Parte do módulo `catalog` existente; **não** recomeça (ADR-G1). Multi-tenant por grupo
  (ADR-G2): todo registro pertence a um `Group`.
- Preço/peso/dimensão como value objects (ADR-G8).
- Estoque **por variante** é definido aqui como campo; a mecânica rica (movimentação,
  reserva, depósitos) é do épico [f1-inventory].
- Suposição: um produto é **simples** (1 variante implícita "default") **ou** **variável**
  (N variantes por combinação de opções). Não há kits/compostos (non-goal).

## Escopo
- **Dentro:** produto simples e variável; opções (ex.: Cor, Tamanho) e valores; variantes
  = combinação de valores, cada uma com SKU/preço/estoque/peso próprios; código de barras
  (GTIN/EAN); imagens (URLs) por produto e por variante; tags; coleções; marca/fabricante;
  estados **rascunho / publicado / oculto** e **publicação agendada**; produtos
  relacionados, cross-sell, upsell; campos de SEO (slug, meta title/description); peso e
  dimensões.
- **Fora (non-goals):** upload/hospedagem de imagem (só URL); produtos digitais/kits/
  compostos; vídeos e arquivos para download; qualquer UI.

## Usuários e personas
- **App do grupo (aluno)** — cadastra e gerencia o catálogo da loja via `X-API-Key`.
- **Cliente final** — só **lê** o catálogo publicado (não vê rascunho/oculto).

## Requisitos funcionais (EARS)

1. QUANDO o app cria um produto com `type=SIMPLE`, o sistema DEVE criar uma variante
   "default" implícita carregando SKU/preço/estoque. _(aceite: `GET /v1/products/:id`
   retorna 1 variante; comportamento atual preservado.)_
2. QUANDO o app cria um produto com `type=VARIABLE` e um conjunto de **opções**
   (ex.: Cor=[Preto,Branco], Tamanho=[P,M]), o sistema DEVE permitir cadastrar **variantes**
   para combinações desses valores, cada uma com SKU/preço/estoque próprios.
   _(aceite: criar 4 variantes; cada uma consultável e com estoque independente.)_
3. SE duas variantes do mesmo produto tiverem a **mesma combinação** de valores de opção,
   ENTÃO o sistema DEVE rejeitar com 409. _(aceite: 2ª tentativa idêntica → 409 CONFLICT.)_
4. SE um SKU se repetir **dentro do mesmo grupo**, ENTÃO o sistema DEVE rejeitar com 409
   (SKU único por tenant). _(aceite: reuso de SKU → 409.)_
5. O sistema DEVE permitir associar a um produto: **tags** (N), **coleções** (N), **marca**
   (0..1), **produtos relacionados / cross-sell / upsell** (N, do mesmo grupo).
   _(aceite: `GET /v1/products/:id` retorna essas associações; referências cruzadas de
   outro grupo → 400.)_
6. O sistema DEVE aceitar **imagens** (lista de URLs) no produto e por variante, com ordem
   e uma marcada como principal. _(aceite: primeira imagem é `primary` por padrão.)_
7. ENQUANTO um produto está em estado `DRAFT` ou `HIDDEN`, o sistema DEVE ocultá-lo das
   listagens/consultas feitas com **token de cliente final**, mas exibi-lo para o app do
   grupo (dono). _(aceite: cliente não vê draft/hidden; app do grupo vê.)_
8. SE um produto tem `publishAt` no futuro, ENTÃO ENQUANTO `now < publishAt` ele DEVE se
   comportar como não-publicado para o cliente final; QUANDO `now >= publishAt`, DEVE
   aparecer automaticamente. _(aceite: agendar +1h; cliente não vê antes, vê depois — sem
   job manual, avaliação na query.)_
9. O sistema DEVE expor **filtros** em `GET /v1/products`: por tag, coleção, marca, estado,
   faixa de preço, busca textual, com paginação. _(aceite: cada filtro retorna subconjunto
   correto.)_
10. O sistema DEVE persistir **SEO** (slug único por grupo, metaTitle, metaDescription) e
    **peso/dimensões** (altura, largura, profundidade) por variante, usados depois pelo
    frete fake. _(aceite: campos retornam no detalhe; slug duplicado no grupo → 409.)_

## Requisitos não-funcionais (NFRs)
- **Isolamento (ADR-G2):** toda consulta de produto/variante filtra por `groupId`; um grupo
  nunca lê/edita produto de outro (verificado por teste de integração).
- **Segurança (ADR-G7):** escrita de catálogo exige `X-API-Key` válida; validação de input
  por allowlist (tipos/tamanhos); referências (categoryId, relatedIds) validadas como
  pertencentes ao grupo (anti-IDOR).
- **Compatibilidade (ADR-G6):** o contrato atual de produto continua válido em `/v1`
  (campos novos são adições non-breaking).
- **Performance:** listagem paginada com índices por `(groupId, ...)`; N+1 evitado
  (variantes/imagens carregadas em batch).

## Critérios de aceite globais
- [ ] Produto simples e variável coexistem; variante default para simples.
- [ ] Estoque/preço/SKU **por variante**; SKU único por grupo; combinação única por produto.
- [ ] Tags, coleções, marca, relacionados/cross/upsell, imagens, SEO, peso/dimensões.
- [ ] Estados DRAFT/PUBLISHED/HIDDEN + agendamento respeitados na ótica do cliente final.
- [ ] Teste de isolamento de tenant passa; contrato antigo não quebra.
