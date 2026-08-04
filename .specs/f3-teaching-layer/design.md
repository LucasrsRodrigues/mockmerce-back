# Design — Camada de Ensino (f3-teaching-layer)

## Skills aplicadas
| Skill | Por que | Princípio aplicado aqui |
|---|---|---|
| domain-driven-design | **Core subdomain** — máximo rigor | Bounded context próprio (control plane); avaliador como **domain service** puro; missão como policy declarativa |
| ux-design | Gamificação | Feedback claro, **progresso visível/acionável** (design principles), gamification **ética** (nota ética — ADR-G9) |
| clean-architecture | Observador desacoplado | Lê RequestLog + read models; **não** acopla nas APIs de loja |
| secure-coding | Notas/evidências | Isolamento por grupo; evidência auditável; sem manipulação por parte do aluno |

## Visão geral — avaliação por evidência
A camada de ensino é um **bounded context separado** (control plane) que **observa** o
application plane. O núcleo é um **avaliador declarativo**:

```
Mission (declarativa) = { id, título, pontos, fase, badge?, evaluator }
evaluator(groupId): { met: boolean, byRm?: string, evidence: {...} }   // função PURA de leitura

para cada grupo:
  para cada missão ativa:  resultado = evaluator(groupId)
  se met e ainda não creditada:  concede XP+badge (uma vez), registra evidência e o RM
```
Cada `evaluator` consulta **RequestLog** (ex.: houve `POST /v1/products` 2xx?) e/ou o
**estado** (ex.: existe WebhookEndpoint ativo com entrega SUCCESS?). Como é leitura pura e os
dados são append-mostly, a avaliação é **idempotente e reprodutível** (req 4).

## Componentes e responsabilidades
- **mission.registry** — catálogo declarativo de missões (código + config do professor).
- **mission.evaluator (domain service, puro)** — dado `groupId`, avalia uma missão →
  `{met, byRm, evidence}`. Uma função por tipo de critério (existe-request, cadeia-de-fluxo,
  estado-existe, sequência-com-tratamento).
- **progress.service** — persiste `MissionProgress` (idempotente); concede XP/badges 1x;
  calcula XP por grupo e por RM.
- **grading.service** — nota = Σ(peso das missões cumpridas)/Σ pesos; snapshot de submissão.
- **dashboard.queries** — visão do grupo/aluno (pendências acionáveis) e do professor (turma).
- **ranking** — ordena grupos por XP; respeita opt-out para visão compartilhável.

## Dados (Prisma)
- `Mission(id, title, description, phase, points, weight, badgeId?, criteria Json, active)` —
  `criteria` = tipo + parâmetros (ex.: `{type:'request', method:'POST', path:'/v1/products',
  status:'2xx'}`, `{type:'flow', steps:['checkout','pay:approved']}`).
- `MissionProgress(groupId, missionId, met, byRm?, evidence Json, metAt)` —
  `@@unique([groupId, missionId])`; idempotente.
- `Badge(id, name, icon, description)` + `GroupBadge(groupId, badgeId, awardedAt)`.
- `XpLedger(groupId, rm?, missionId, points, createdAt)` — soma auditável por grupo e RM.
- `Submission(groupId, snapshot Json, grade, submittedByRm, createdAt)` — imutável.
- `GroupTeachingSettings(groupId, rankingOptOut Bool)`.
- Fonte de evidência: `RequestLog` (já existe) + tabelas de negócio (read-only).

## Interfaces / APIs
- Professor (control plane): `GET/POST /admin/missions`, `POST /admin/missions/evaluate`
  (dispara avaliação de um grupo/turma), `GET /admin/teaching/class` (visão de turma),
  `GET /admin/teaching/groups/:id`.
- Grupo/aluno (via API key): `GET /v1/teaching/dashboard` (missões, XP, badges, pendências),
  `GET /v1/teaching/ranking`, `POST /v1/teaching/submit` ("enviar para correção").

## Decisões (ADRs resumidos)
- **ADR-1 — Bounded context separado (control plane), observador.** A camada de ensino tem
  sua própria linguagem (missão, XP, submissão) e **não** contamina o domínio de e-commerce.
  Lê o rastro; não muda as APIs de loja. _(DDD: bounded context = fronteira de linguagem;
  clean-architecture: dependência aponta para dentro, loja não conhece ensino.)_
- **ADR-2 — Missões declarativas (policy as data), avaliador puro.** Adicionar uma missão =
  adicionar uma definição, não reescrever lógica. Avaliador puro → idempotente e testável com
  fixtures de RequestLog. _(DDD domain service; clean-code função pura.)_
- **ADR-3 — Crédito por RM a partir do `X-Student-RM`.** Liga participação individual à
  evidência. Se o grupo não enviar RM, credita ao grupo e **sinaliza** — incentivo honesto a
  usar o header (isso já é o mecanismo de participação do professor). _(escopo/objetivo.)_
- **ADR-4 — Nota = soma ponderada normalizada, snapshot imutável na submissão.** Transparente
  e auditável (cada missão tem evidência). O professor ajusta pesos. _(ux-design: progresso
  mensurável; secure-coding: evidência não-repudiável.)_
- **ADR-5 — Gamificação ética.** Ranking opt-out, sem shame, pendências como "próximos passos"
  motivadores, não punição. _(ux-design nota ética; ADR-G9.)_

## Riscos e mitigações
- **Aluno "gamear" a missão** (chamar a API só para pontuar) → missões exigem **evidência de
  fluxo real** (ex.: compra ponta a ponta com pagamento aprovado e estoque baixado), não só um
  request isolado; professor vê a evidência e pode auditar.
- **Falso negativo por falta de RM** → dashboard destaca "ações sem RM"; orienta o grupo.
- **Avaliação pesada na turma toda** → avaliação sob demanda + incremental (só reavaliar
  grupos com atividade nova desde a última avaliação).
- **Injustiça na nota** → tudo rastreável à evidência; professor pode revisar/ajustar peso.
