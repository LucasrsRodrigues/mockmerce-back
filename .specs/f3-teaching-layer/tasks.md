# Tasks — Camada de Ensino (f3-teaching-layer)

- [ ] **T1 — Modelagem Prisma (Mission, MissionProgress, Badge, GroupBadge, XpLedger, Submission, GroupTeachingSettings)** _(req: 1,5,9)_
  - Uniques idempotentes; `criteria`/`evidence`/`snapshot` como Json.
  - Verificação: migração aplica.
- [ ] **T2 — mission.registry declarativo + CRUD do professor** _(req: 1)_ · dep: T1
  - Definições em código + config (pontos/pesos/ativo) editável.
  - Verificação: CRUD; missão inativa não pontua.
- [ ] **T3 — Avaliadores puros por tipo de critério** _(req: 2,4)_ · dep: T2
  - `request`, `flow` (cadeia), `state-exists`, `sequence-with-handling`; leem RequestLog +
    estado; retornam `{met, byRm, evidence}`.
  - Verificação: **fixtures** de RequestLog → cada avaliador liga só com evidência; idempotente.
- [ ] **T4 — progress.service (crédito idempotente + XP + badges)** _(req: 3,5,6)_ · dep: T3
  - Concede 1x; credita RM; XpLedger por grupo/RM.
  - Verificação: reavaliar não duplica XP/badge; XP do RM correto.
- [ ] **T5 — Endpoint de avaliação (grupo e turma)** _(req: 2,11)_ · dep: T4
  - `POST /admin/missions/evaluate`; incremental (só grupos com atividade nova).
  - Verificação: avaliar turma marca corretamente; 2ª rodada sem mudança = estável.
- [ ] **T6 — Dashboard do grupo/aluno (pendências acionáveis)** _(req: 8)_ · dep: T4
  - Missões cumpridas/pendentes, XP, badges, "o que falta".
  - Verificação: pendências claras; isolamento por grupo.
- [ ] **T7 — Ranking com opt-out** _(req: 7)_ · dep: T4
  - Ordena por XP; opt-out esconde da visão compartilhável; professor vê tudo.
  - Verificação: grupo em opt-out não aparece no ranking público.
- [ ] **T8 — "Enviar para correção" + nota automática** _(req: 9,10)_ · dep: T4
  - Snapshot imutável; nota = Σ pesos cumpridos normalizada.
  - Verificação: submissão congela estado+nota; nota bate com pesos.
- [ ] **T9 — Visão de turma do professor** _(req: 11)_ · dep: T5,T8
  - Por grupo e por RM; quem está atrás; distribuição de notas.
  - Verificação: agregados corretos; evidência acessível.
- [ ] **T10 — Missões seed da Fase 1/2 + Swagger + guia** _(req: 1,2)_ · dep: T2,T3
  - Seed: cadastrou produto, compra ponta-a-ponta, usou cupom, integrou webhook, tratou
    recusa, cotou frete, reembolsou, etc.
  - Verificação: `/docs`; guia do professor de como definir/avaliar missões.
- [ ] **T11 — Revisão de segurança/ética** _(req: NFR)_ · dep: T3–T10
  - Isolamento; evidência auditável; anti-gaming (missões de fluxo real); ranking sem shame.
  - Verificação: checklist secure-coding + revisão ética (ADR-G9).

## Estratégia de testes
Unit: avaliadores com **fixtures de RequestLog** (o coração — cada missão liga só com a
evidência certa) + cálculo de nota. Integration: idempotência do crédito; isolamento;
avaliação incremental de turma. e2e: rodar um fluxo completo de loja e verificar que as
missões correspondentes acendem com o RM correto.
