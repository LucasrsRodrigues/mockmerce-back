# Requirements — Camada de Ensino (f3-teaching-layer)

## Objetivo
O **diferencial** da plataforma (subdomínio **core**): transformar o rastro que o backend já
coleta (`RequestLog` + dados de negócio) em **correção automática por missões**, com
**badges/XP**, **dashboard do aluno/grupo**, **ranking** e **nota automática** — para o
professor saber, com evidência, **quem implementou o quê**.

## Contexto e suposições
- Observa **todas as fases anteriores**: uma "missão" é uma capacidade do e-commerce que o
  grupo deveria implementar (ex.: cadastrar produto, completar compra, usar cupom, configurar
  webhook, tratar pagamento recusado).
- A avaliação é **por evidência**: detecta que o grupo **usou** a API de forma que comprova a
  capacidade, atribuindo o crédito ao **RM** que disparou a ação.
- Gamificação **ética** (ADR-G9): serve ao aprendizado; ranking com opt-out; sem shame.
- Não altera o comportamento das APIs de loja — é **read/observe** + um pouco de estado
  próprio (progresso, submissões).

## Escopo
- **Dentro:** catálogo de **missões** (definição declarativa: evento/condição que a
  satisfaz); **avaliador** que verifica missões a partir de RequestLog + estado do banco;
  **progresso por grupo** e **crédito por RM**; **badges** (conquistas) e **XP**; **dashboard**
  (grupo e aluno) com o que falta; **ranking** (opt-out); **"enviar para correção"**
  (snapshot avaliado) e **nota automática** (soma ponderada de missões); visão do professor
  (turma inteira).
- **Fora (non-goals):** avaliar qualidade de **código-fonte** do aluno (isto observa
  comportamento da API, não o repositório deles); plágio; correção subjetiva de UI.

## Requisitos funcionais (EARS)

### Missões e avaliação
1. O professor DEVE poder definir **missões** declarativas (id, título, descrição, pontos,
   critério verificável, fase). _(aceite: CRUD de missão; missão inativa não pontua.)_
2. QUANDO o avaliador roda para um grupo, o sistema DEVE marcar cada missão como
   **cumprida/pendente** com base em **evidência** (ex.: existe ≥1 `POST /v1/products` 2xx do
   grupo → "cadastrou produto"; existe cadeia checkout→pay aprovada → "compra ponta a ponta";
   `cart/coupon` aplicado com sucesso → "usou cupom"; `WebhookEndpoint` ativo + entrega
   SUCCESS → "integrou webhook"; pagamento com `simulate=decline` seguido de tratamento →
   "tratou recusa"). _(aceite: cada missão vira verdadeira só quando a evidência existe.)_
3. QUANDO uma missão é cumprida, o sistema DEVE atribuir o **crédito ao RM** que disparou a
   ação que a satisfez (do header `X-Student-RM`). _(aceite: a missão mostra qual RM a
   completou; sem RM → conta ao grupo mas sinaliza "sem RM".)_
4. O avaliador DEVE ser **idempotente e reprodutível**: reavaliar não muda o resultado se os
   dados não mudaram. _(aceite: rodar 2x dá o mesmo estado.)_

### Gamificação
5. QUANDO um grupo cumpre uma missão, o sistema DEVE conceder os **pontos (XP)** e, se houver,
   o **badge** associado, **uma vez**. _(aceite: XP soma uma vez; badge não duplica.)_
6. O sistema DEVE calcular **XP por grupo** e **por RM** (participação individual). _(aceite:
   XP do RM reflete as missões que ele disparou.)_
7. O sistema DEVE oferecer um **ranking** de grupos por XP, com **opt-out** de exibição
   pública por grupo. _(aceite: grupo em opt-out não aparece no ranking compartilhável; o
   professor ainda vê tudo.)_

### Dashboards e nota
8. O sistema DEVE expor um **dashboard do grupo/aluno**: missões cumpridas/pendentes, XP,
   badges, **e o que falta** (próximos passos claros). _(aceite: lista pendências acionáveis.)_
9. O grupo DEVE poder **"enviar para correção"**: o sistema tira um **snapshot** avaliado
   (missões cumpridas + evidências + nota) num instante, imutável. _(aceite: submissão
   registra estado e nota daquele momento.)_
10. O sistema DEVE calcular uma **nota automática** = soma ponderada das missões cumpridas
    (normalizada), configurável pelo professor. _(aceite: nota bate com os pesos.)_
11. O professor DEVE ter uma visão da **turma inteira**: por grupo e por RM (participação),
    quem está atrás, distribuição de notas. _(aceite: painel agregado por turma.)_

## Requisitos não-funcionais (NFRs)
- **Evidência auditável:** cada missão cumprida guarda a **evidência** (ex.: ids de logs/
  entidades) — o professor pode justificar a nota.
- **Não-intrusivo:** a avaliação é assíncrona/sob demanda; não afeta latência das APIs de loja.
- **Ética (ADR-G9/ux-design):** progresso e pendências motivam (feedback claro, progresso
  visível); ranking sem shame; sem urgência falsa. Foco em **aprender**, não em competir.
- **Isolamento (ADR-G2):** cada grupo só vê o próprio dashboard; professor vê todos.

## Critérios de aceite globais
- [ ] Missões declarativas avaliadas por evidência real (RequestLog + dados), idempotentes.
- [ ] Crédito por RM; XP e badges por grupo e por aluno; ranking com opt-out.
- [ ] Dashboard com pendências acionáveis; "enviar para correção" com snapshot imutável.
- [ ] Nota automática ponderada; visão de turma para o professor com evidência.
