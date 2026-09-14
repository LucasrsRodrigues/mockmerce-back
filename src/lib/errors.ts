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
/// Aluno autenticado mas ainda sem loja/grupo. O painel usa o code p/ redirecionar
/// à tela de "criar loja".
export const noGroup = (msg = 'Você ainda não tem uma loja. Crie a sua para continuar.') =>
  new AppError(403, 'NO_GROUP', msg);
export const unprocessable = (msg: string) => new AppError(422, 'UNPROCESSABLE', msg);
/// Arquivo maior que o limite de upload (UPLOAD_MAX_MB).
export const payloadTooLarge = (msg: string) => new AppError(413, 'FILE_TOO_LARGE', msg);
/// Arquivo enviado num formato fora da allowlist (ver lib/fileType.ts).
export const unsupportedMedia = (msg: string) => new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', msg);
/// Recurso opcional não configurado no ambiente (ex.: upload sem S3_BUCKET).
export const serviceUnavailable = (code: string, msg: string) => new AppError(503, code, msg);
