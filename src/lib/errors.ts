/** Erro de aplicação com status HTTP. O handler global traduz para JSON. */
export class AppError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = 'AppError';
  }
}

export const badRequest = (msg: string) => new AppError(400, 'BAD_REQUEST', msg);
export const unauthorized = (msg = 'Não autenticado') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Acesso negado') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Recurso não encontrado') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string) => new AppError(409, 'CONFLICT', msg);
export const unprocessable = (msg: string) => new AppError(422, 'UNPROCESSABLE', msg);
