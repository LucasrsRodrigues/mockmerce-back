import type { FastifyInstance, FastifyError } from 'fastify';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors.js';

/** Traduz qualquer erro para um JSON consistente: { error: { code, message } }. */
export function setErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Erros de negócio previstos.
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }

    // Erros de validação de schema do Fastify.
    if (error.validation) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Dados inválidos na requisição.',
          details: error.validation,
        },
      });
    }

    // Erros conhecidos do Prisma.
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return reply.code(409).send({
          error: { code: 'CONFLICT', message: 'Registro duplicado (violação de unicidade).' },
        });
      }
      if (error.code === 'P2025') {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Registro não encontrado.' },
        });
      }
    }

    // Rate limit / payload etc. do próprio Fastify já vêm com statusCode.
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: { code: error.code ?? 'ERROR', message: error.message },
      });
    }

    // Qualquer outra coisa = erro interno (logado, mas sem vazar detalhes).
    request.log.error({ err: error }, 'Erro não tratado');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno no servidor.' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Rota não encontrada: ${request.method} ${request.url}` },
    });
  });
}
