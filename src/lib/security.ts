import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';

// ---- Senhas do cliente final ----
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ---- JWT do cliente final ----
export interface CustomerTokenPayload {
  sub: string; // customerId
  groupId: string;
  email: string;
}

export function signCustomerToken(payload: CustomerTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyCustomerToken(token: string): CustomerTokenPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as CustomerTokenPayload & { kind?: string };
  if (payload.kind === 'operator') throw new jwt.JsonWebTokenError('token de operador não vale como cliente');
  return payload;
}

// ---- JWT do OPERADOR (control plane: professor/monitor) ----
export interface OperatorTokenPayload {
  sub: string; // operatorId
  email: string;
  role: 'ADMIN' | 'MONITOR' | 'VIEWER';
  kind: 'operator';
}

export function signOperatorToken(payload: Omit<OperatorTokenPayload, 'kind'>): string {
  return jwt.sign({ ...payload, kind: 'operator' }, env.JWT_SECRET, { expiresIn: '12h' });
}

export function verifyOperatorToken(token: string): OperatorTokenPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as OperatorTokenPayload;
  if (payload.kind !== 'operator') throw new jwt.JsonWebTokenError('não é um token de operador');
  return payload;
}

// ---- JWT do ALUNO (admin web da loja) ----
export interface StudentTokenPayload {
  sub: string; // studentId
  rm: string;
  groupId: string | null; // null = aluno ainda sem loja (só login)
  kind: 'student';
}

export function signStudentToken(payload: Omit<StudentTokenPayload, 'kind'>): string {
  return jwt.sign({ ...payload, kind: 'student' }, env.JWT_SECRET, { expiresIn: '8h' });
}

export function verifyStudentToken(token: string): StudentTokenPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as StudentTokenPayload;
  if (payload.kind !== 'student') throw new jwt.JsonWebTokenError('não é um token de aluno');
  return payload;
}
