# Tasks — Admin RBAC e Segurança de Plataforma (f2-admin-rbac-security)

- [ ] **T1 — OperatorUser + papéis + login** _(req: 1,3)_
  - Senha com bcrypt/argon2; token de operação; token mestre preservado.
  - Verificação: login funciona; token mestre acessa tudo.
- [ ] **T2 — Middleware `requirePermission` deny-by-default** _(req: 2)_ · dep: T1
  - Mapa papel→permissões; aplicar em todas as rotas de control plane.
  - Verificação: VIEWER em escrita → 403; teste que toda rota declara permissão.
- [ ] **T3 — Auditoria de ações sensíveis** _(req: 4)_ · dep: T1
  - Hook grava `AuditLog` em criar grupo/rotacionar chave/apagar dados.
  - Verificação: ação sensível aparece no `GET /admin/audit`.
- [ ] **T4 — Config por grupo** _(req: 5)_
  - locale/currency/timezone com defaults.
  - Verificação: GET/PUT; default pt-BR/BRL.
- [ ] **T5 — Rate limiting por tenant (plugin)** _(req: 6)_
  - Token bucket por API key; 429 + `Retry-After`; buckets isolados.
  - Verificação: exceder → 429; grupo A não afeta B.
- [ ] **T6 — Idempotency-Key (plugin + tabela)** _(req: 7)_
  - Grava 1ª execução; repetição retorna original; escopo por grupo.
  - Verificação: 2º POST igual não duplica recurso.
- [ ] **T7 — LGPD export** _(req: 8)_
  - Agrega todos os dados do cliente em JSON.
  - Verificação: export contém perfil, endereços, pedidos, favoritos.
- [ ] **T8 — LGPD delete/anonimização** _(req: 8)_ · dep: T7
  - Remove PII, mantém pedidos anonimizados (integridade contábil).
  - Verificação: após delete, PII some; pedido histórico permanece anonimizado.
- [ ] **T9 — Versionamento `/v1` + openapi-diff no CI** _(req: 9)_
  - Migrar rotas para `/v1` com alias; pipeline barra breaking.
  - Verificação: breaking simulado falha o CI.
- [ ] **T10 — Revisão de segurança final da plataforma** _(req: NFR)_ · dep: T1–T9
  - Checklist secure-coding completo (authz, rate limit, idempotência, PII, segredos, erros).
  - Verificação: checklist preenchido; testes verdes.

## Estratégia de testes
Unit (mapa de permissões; anonimização de PII). Integration (rate limit 429; idempotência
sem duplicar; LGPD export/delete). Fitness functions: toda rota de control plane declara
permissão; openapi-diff barra breaking.
