import 'fastify';
import type { preHandlerHookHandler } from 'fastify';
import type { OperatorContext } from './modules/admin/rbac.js';

/** Grupo autenticado via X-API-Key (o tenant). */
export interface GroupContext {
  id: string;
  name: string;
}

/** Cliente final autenticado via JWT. */
export interface CustomerContext {
  id: string;
  email: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Grupo dono da requisição. Definido por requireGroup. */
    group?: GroupContext;
    /** RM do aluno (header X-Student-RM), quando enviado. */
    rm?: string | null;
    /** Como a requisição autenticou: 'apiKey' (app/loja) ou 'student' (painel do aluno). */
    authVia?: 'apiKey' | 'student';
    /** Cliente final logado. Definido por requireCustomer. */
    customer?: CustomerContext;
    /** Operador do control plane. Definido por requireAdmin. */
    operator?: OperatorContext;
    /** Chave de idempotência a persistir (definida pelo plugin de idempotência). */
    idempotencyToStore?: { tenantKey: string; key: string } | null;
  }

  interface FastifyInstance {
    /** Exige X-API-Key válida. Popula request.group e request.rm. */
    requireGroup: preHandlerHookHandler;
    /** Exige grupo + JWT de cliente. Popula request.customer. */
    requireCustomer: preHandlerHookHandler;
    /** Autentica o control plane (X-Admin-Token OU token de operador). Popula request.operator. */
    requireAdmin: preHandlerHookHandler;
    /** Autoriza por permissão (deny-by-default). Use após requireAdmin. */
    requirePermission: (permission: string) => preHandlerHookHandler;
  }
}
