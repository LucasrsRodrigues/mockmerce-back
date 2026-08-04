# Requirements — Admin RBAC e Segurança de Plataforma (f2-admin-rbac-security)

## Objetivo
Profissionalizar o **control plane** (operação) e endurecer a plataforma: usuários/perfis/
permissões (**RBAC**) para além do token mestre único, **auditoria** estendida, **config**
por grupo (idioma/moeda/fuso), e os controles transversais de segurança (**rate limiting**
por tenant, **Idempotency-Key**, **LGPD** export/delete, **versionamento `/v1`**).

## Contexto e suposições
- Hoje o admin é um único `X-Admin-Token` (o professor). Aqui adicionamos usuários de
  operação com papéis (ex.: professor(admin), monitor, leitura), sem quebrar o token mestre.
- RBAC é subdomínio **generic** (padrão conhecido) → implementar de forma direta e segura.
- Rate limit e idempotência são NFRs globais (ADR-G7) materializados aqui como plataforma.

## Escopo
- **Dentro:** usuários de operação + login próprio; **papéis** e **permissões** (deny-by-
  default); **auditoria** (quem fez ação sensível de control plane) estendendo o RequestLog;
  **config por grupo** (idioma/moeda/fuso como campos); **rate limiting por tenant**;
  **Idempotency-Key** em POST de escrita; **LGPD** (exportar todos os dados de um cliente;
  apagar/anonimizar sob solicitação); **versionamento** das rotas sob `/v1` + política de
  breaking change.
- **Fora (non-goals):** SSO/OAuth externo; 2FA (pode entrar depois); billing real; multi-
  região.

## Requisitos funcionais (EARS)

### RBAC / operação
1. O sistema DEVE permitir criar **usuários de operação** com **papel** (ADMIN, MONITOR,
   VIEWER). _(aceite: CRUD de usuário; login retorna token de operação.)_
2. O sistema DEVE autorizar cada rota de control plane por **permissão**, **deny-by-default**;
   um VIEWER não executa ações de escrita. _(aceite: VIEWER em rota de escrita → 403.)_
3. O **token mestre** (`X-Admin-Token`) DEVE continuar válido como super-admin de bootstrap.
   _(aceite: token mestre acessa tudo.)_
4. QUANDO um usuário executa ação sensível (criar grupo, rotacionar chave, apagar dados),
   o sistema DEVE registrar **auditoria** (usuário, ação, alvo, timestamp). _(aceite: log de
   auditoria consultável.)_

### Config
5. O sistema DEVE guardar **config por grupo** (idioma, moeda, fuso) e retorná-la ao app.
   _(aceite: GET/PUT config; default pt-BR/BRL/America-Sao_Paulo.)_

### Segurança de plataforma
6. O sistema DEVE aplicar **rate limiting por tenant** (por API key), retornando 429 com
   `Retry-After` ao exceder. _(aceite: exceder o limite → 429; um grupo não afeta o limite de
   outro.)_
7. QUANDO um POST de escrita traz `Idempotency-Key`, o sistema DEVE garantir que reprocessar a
   **mesma chave** não duplique o efeito (retorna o resultado original). _(aceite: 2º POST
   igual não cria segundo recurso.)_
8. O sistema DEVE oferecer **LGPD**: exportar todos os dados de um cliente (JSON) e
   **apagar/anonimizar** a pedido, preservando integridade contábil dos pedidos (anonimiza
   PII, mantém registros financeiros). _(aceite: export completo; após delete, PII some mas o
   pedido histórico permanece anonimizado.)_
9. As rotas de negócio DEVEM estar sob **`/v1`**; mudanças breaking exigem nova major.
   _(aceite: `openapi-diff` barra breaking no CI.)_

## Requisitos não-funcionais (NFRs)
- **Secure by default (ADR-G7):** deny-by-default; senha de operação com bcrypt/argon2;
  tokens curtos; erros sem vazar detalhe; segredos fora do código.
- **Noisy neighbor (multi-tenant):** rate limit protege o serviço de um grupo abusivo.
- **Auditabilidade e tenant context:** logs de segurança com grupo/usuário.

## Critérios de aceite globais
- [ ] RBAC deny-by-default com papéis; token mestre preservado; auditoria de ações sensíveis.
- [ ] Rate limit por tenant (429 + Retry-After); Idempotency-Key sem duplicação.
- [ ] LGPD export + delete/anonimização preservando pedidos.
- [ ] Rotas sob `/v1`; breaking barrado no CI.
