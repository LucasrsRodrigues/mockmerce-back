# Design — Admin RBAC e Segurança de Plataforma (f2-admin-rbac-security)

## Skills aplicadas
| Skill | Por que | Princípio aplicado aqui |
|---|---|---|
| secure-coding | Coração do épico | Deny-by-default authz por objeto, rate limit, idempotência, LGPD, hashing forte |
| multi-tenant-saas | Control plane + noisy neighbor | Separação control/application plane; rate limit por tenant; auditoria com tenant context |
| api-architecture | Versionamento | `/v1`, semver, openapi-diff no CI; authz em **todo** endpoint |
| clean-architecture | RBAC reusável | Middleware de permissão central, não espalhado |

## Visão geral
Materializa o **control plane** (multi-tenant-saas) como um subsistema de operação com RBAC,
e injeta 4 controles transversais como **plugins Fastify** (interception — centralizar
multi-tenancy/segurança): rate limit, idempotency, versionamento, auditoria.

## Componentes e responsabilidades
- **rbac** — `OperatorUser` + `Role` + `Permission`; middleware `requirePermission(p)`
  deny-by-default; token mestre = super-admin.
- **audit** — grava `AuditLog` em ações sensíveis (decorator/hook).
- **rate-limit plugin** — janela por API key (token bucket), 429 + `Retry-After`; buckets
  isolados por tenant.
- **idempotency plugin** — tabela `IdempotencyKey(groupId, key, requestHash, response,
  status)`; primeira execução grava; repetição retorna resultado.
- **lgpd.service** — export (agrega tudo do cliente) e delete/anonimização (limpa PII,
  mantém pedido com `customer` anonimizado).
- **config.service** — config por grupo.
- **versioning** — prefixo `/v1`; `openapi-diff` no CI (fitness function ADR-G6).

## Dados (Prisma)
- `OperatorUser(email, passwordHash, role, active)` — global do control plane (não por grupo).
- `Role`/`Permission` (ou enum de papéis + mapa de permissões em código, mais simples).
- `AuditLog(operatorId?, tokenMaster Bool, action, targetType, targetId, groupId?, meta Json,
  createdAt)`.
- `IdempotencyKey(groupId, key, method, path, requestHash, responseJson, statusCode,
  createdAt)` — `@@unique([groupId, key])`.
- `GroupConfig(groupId, locale, currency, timezone)`.
- Rate limit: contadores em memória (ou tabela/Redis se distribuído — começar em memória).

## Interfaces / APIs
- Control plane: `POST /admin/users`, `/admin/roles`, `POST /admin/login`,
  `GET /admin/audit`.
- Config: `GET/PUT /v1/settings` (por grupo, via API key) e `GET /admin/groups/:id/config`.
- LGPD: `GET /v1/customers/:id/export`, `DELETE /v1/customers/:id` (anonimiza).
- Todas as rotas de loja passam a viver sob `/v1` (alias temporário das antigas).

## Decisões (ADRs resumidos)
- **ADR-1 — Papéis em código + permissões mapeadas (não RBAC dinâmico completo).** Escala de
  ensino não precisa de editor de permissões; um enum de papéis + mapa é seguro e simples.
  Trade-off: adicionar papel exige deploy — aceitável. _(secure-coding deny-by-default; DDD
  generic → não sobre-engenheirar.)_
- **ADR-2 — Idempotência por tabela de chaves, escopada ao grupo.** Protege pagamentos/pedidos
  de duplicação por retry (complementa ADR-G4). _(secure-coding: replay.)_
- **ADR-3 — Rate limit por tenant em memória primeiro.** Simples; se o deploy escalar para
  múltiplas instâncias, migrar para store compartilhado (Redis). Documentar o limite atual.
  _(multi-tenant-saas: noisy neighbor; api-architecture: comece simples.)_
- **ADR-4 — LGPD delete = anonimização, não hard-delete.** Preserva integridade dos pedidos
  (registro contábil) enquanto remove PII. _(secure-coding + escopo: prohibited hard-delete de
  dado financeiro; anonimizar é o correto.)_
- **ADR-5 — Auditoria separada do RequestLog.** RequestLog = todo tráfego (ensino/participação);
  AuditLog = ações sensíveis de control plane. Propósitos distintos. _(clean-architecture SRP.)_

## Riscos e mitigações
- **Bypass de authz** → middleware central obrigatório + teste que garante que toda rota de
  control plane declara permissão (fitness function).
- **Rate limit inconsistente entre instâncias** → documentar; migrar para Redis se necessário.
- **Anonimização incompleta (PII residual)** → checklist de campos PII por entidade + teste.
