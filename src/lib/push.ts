import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { badRequest, serviceUnavailable } from './errors.js';

/**
 * Camada de push (Firebase Cloud Messaging HTTP v1). O resto do código NÃO
 * conhece o protocolo do Google: fala só com `sendPush`. Mesma ideia do
 * lib/storage.ts — a regra de negócio não deve saber quem entrega.
 *
 * POR QUE NÃO O SDK firebase-admin?
 * Porque ele traz ~40 MB de dependências para fazer duas requisições HTTP. O
 * que o FCM v1 pede é: (1) trocar um JWT assinado por um access token OAuth2,
 * (2) POSTar o payload. Node 20 tem `fetch` nativo e o `jsonwebtoken` já está
 * no projeto. Escrever à mão também deixa o mecanismo VISÍVEL — nesta aula
 * isso é o conteúdo, não um detalhe.
 *
 * A CREDENCIAL É UM PARÂMETRO, não um global: cada grupo tem o próprio
 * projeto no Firebase, e um token só pode ser alcançado pela credencial do
 * projeto que o emitiu. Quem resolve de quem é a credencial é o
 * modules/push/credentials.ts.
 */

export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

// ----------------------------------------------------------- credenciais

/**
 * Lê o JSON da conta de serviço — cru ou em base64, que é como ele cabe numa
 * variável de ambiente ou num campo de formulário sem virar um pesadelo de
 * escape.
 */
export function parseServiceAccount(raw: string): FcmCredentials {
  const text = raw.trim().startsWith('{') ? raw : safeBase64(raw);
  let json: Record<string, string>;
  try {
    json = JSON.parse(text);
  } catch {
    throw badRequest('O conteúdo não é um JSON válido (nem cru, nem em base64). Cole o arquivo que o Firebase baixou, inteiro.');
  }
  if (json.type && json.type !== 'service_account') {
    throw badRequest(`Esse JSON é do tipo "${json.type}". O arquivo certo é o da CONTA DE SERVIÇO (Configurações do projeto → Contas de serviço → Gerar nova chave privada).`);
  }
  if (!json.project_id || !json.client_email || !json.private_key) {
    throw badRequest('Faltam campos no JSON (project_id, client_email, private_key). Provavelmente é o google-services.json, que vai no APP — aqui vai o da conta de serviço.');
  }
  return {
    projectId: json.project_id,
    clientEmail: json.client_email,
    privateKey: normalizeKey(json.private_key),
  };
}

function safeBase64(raw: string): string {
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * No .env a chave privada vive numa linha só, com `\n` LITERAIS (dois
 * caracteres). O OpenSSL precisa das quebras de verdade, senão o erro que
 * aparece é um críptico "error:1E08010C:DECODER routines::unsupported".
 */
function normalizeKey(key: string): string {
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
}

let cachedEnvCred: FcmCredentials | null | undefined;

/** Credencial do SERVIDOR (.env) — o fallback de quem ainda não configurou. */
export function envCredentials(): FcmCredentials | null {
  if (cachedEnvCred !== undefined) return cachedEnvCred;

  try {
    if (env.FCM_SERVICE_ACCOUNT_JSON) {
      cachedEnvCred = parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON);
    } else if (env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY) {
      cachedEnvCred = {
        projectId: env.FCM_PROJECT_ID,
        clientEmail: env.FCM_CLIENT_EMAIL,
        privateKey: normalizeKey(env.FCM_PRIVATE_KEY),
      };
    } else {
      cachedEnvCred = null;
    }
  } catch (err) {
    console.error('[push] credencial do .env inválida:', (err as Error).message);
    cachedEnvCred = null;
  }
  return cachedEnvCred;
}

export function serverPushEnabled(): boolean {
  return envCredentials() !== null;
}

/** Garante que EXISTE alguma credencial utilizável; senão, 503 acionável. */
export function requirePush(cred: FcmCredentials | null): asserts cred is FcmCredentials {
  if (!cred) {
    throw serviceUnavailable(
      'PUSH_DISABLED',
      'Nenhuma credencial do FCM disponível: a loja não registrou a dela (PUT /v1/store/push-config) e o servidor não tem uma configurada.',
    );
  }
}

// --------------------------------------------------------- OAuth2 (JWT bearer)

/** Cache por conta de serviço: cada grupo tem o seu token, com prazos próprios. */
const tokens = new Map<string, { value: string; expiresAt: number }>();

/**
 * Troca um JWT auto-assinado por um access token do Google (fluxo
 * "JWT bearer", o que service accounts usam quando não há usuário no meio).
 * O token vale 1h; guardamos até 60s antes do fim para não correr risco de
 * usar um token que expira no meio do voo.
 */
async function getAccessToken(cred: FcmCredentials): Promise<string> {
  const cached = tokens.get(cred.clientEmail);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const now = Math.floor(Date.now() / 1000);
  let assertion: string;
  try {
    assertion = jwt.sign(
      {
        iss: cred.clientEmail,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      },
      cred.privateKey,
      { algorithm: 'RS256' },
    );
  } catch (err) {
    throw new Error(`chave privada inválida: ${(err as Error).message}`);
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== 'string') {
    // Quase sempre: relógio do servidor fora de hora, chave revogada, ou a
    // service account sem o papel de FCM.
    throw new Error(`OAuth do FCM recusou (${res.status}): ${JSON.stringify(json)}`);
  }

  const ttl = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  tokens.set(cred.clientEmail, { value: json.access_token, expiresAt: Date.now() + (ttl - 60) * 1000 });
  return json.access_token;
}

function forgetAccessToken(cred: FcmCredentials): void {
  tokens.delete(cred.clientEmail);
}

/**
 * Só o handshake OAuth, sem enviar nada. É o "testar conexão" que o aluno
 * aperta logo depois de colar a chave — a diferença entre saber na hora e
 * descobrir pelo silêncio do aparelho.
 */
export async function verifyCredentials(cred: FcmCredentials): Promise<{ ok: boolean; message: string }> {
  try {
    await getAccessToken(cred);
    return { ok: true, message: `Autenticou no projeto ${cred.projectId}.` };
  } catch (err) {
    return { ok: false, message: (err as Error).message.slice(0, 500) };
  }
}

// --------------------------------------------------------------- envio

export type PushKind = 'NOTIFICATION' | 'DATA';

export interface PushInput {
  /** Token do aparelho (o cru do FCM, não o ExponentPushToken[...]). */
  token: string;
  title?: string;
  body?: string;
  /** O FCM exige strings dos dois lados; números/objetos são serializados. */
  data?: Record<string, unknown>;
  kind?: PushKind;
  /** Canal do Android. Precisa existir no app. */
  androidChannelId?: string;
}

export interface PushResult {
  ok: boolean;
  /** `name` devolvido pelo FCM: projects/<id>/messages/<id>. */
  messageId?: string;
  errorCode?: string;
  errorDetail?: string;
  /** true quando o token morreu (app desinstalado / token rotacionado). */
  tokenGone?: boolean;
}

/**
 * Envia para UM aparelho. O FCM v1 não tem multicast: um token, uma
 * requisição. Quem precisa de vários chama isto em paralelo (ver
 * modules/push/service.ts).
 *
 * NUNCA lança por falha de entrega — devolve `ok: false`. Um push que não
 * chegou não pode derrubar o fluxo que o originou (mudar o preço de um
 * produto tem que funcionar mesmo com o FCM fora do ar).
 */
export async function sendPush(cred: FcmCredentials, input: PushInput): Promise<PushResult> {
  const kind = input.kind ?? 'NOTIFICATION';
  const data = stringifyData(input.data);

  const message: Record<string, unknown> = {
    token: input.token,
    ...(Object.keys(data).length > 0 ? { data } : {}),
    android: {
      // "high" é o que acorda o app em doze mode. Em envio DATA, sem isto o
      // Android pode segurar a mensagem por minutos.
      priority: 'high',
      ...(kind === 'NOTIFICATION'
        ? { notification: { channel_id: input.androidChannelId ?? env.PUSH_ANDROID_CHANNEL_ID } }
        : {}),
    },
    apns: {
      headers: { 'apns-priority': kind === 'DATA' ? '5' : '10' },
      payload: {
        aps: kind === 'DATA'
          ? { 'content-available': 1 } // silenciosa: acorda o app, não desenha nada
          : { sound: 'default' },
      },
    },
  };

  // Em NOTIFICATION o bloco `notification` faz o SO desenhar sozinho — é o que
  // permite a notificação aparecer com o app FECHADO. Em DATA ele some: nada
  // aparece até o app decidir exibir.
  if (kind === 'NOTIFICATION') {
    message.notification = { title: input.title ?? '', body: input.body ?? '' };
  }

  try {
    const result = await post(cred, message);
    if (result.status === 401) {
      // Token OAuth expirado antes da hora (relógio, rotação). Uma segunda
      // tentativa com token novo resolve; duas falhas seguidas é erro real.
      forgetAccessToken(cred);
      return interpret(await post(cred, message));
    }
    return interpret(result);
  } catch (err) {
    return { ok: false, errorCode: 'NETWORK', errorDetail: (err as Error).message };
  }
}

async function post(cred: FcmCredentials, message: Record<string, unknown>) {
  const accessToken = await getAccessToken(cred);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${cred.projectId}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json };
}

function interpret(res: { status: number; json: Record<string, any> }): PushResult {
  if (res.status >= 200 && res.status < 300) {
    return { ok: true, messageId: typeof res.json.name === 'string' ? res.json.name : undefined };
  }

  // O código útil não está no `error.status`, e sim no detalhe tipado.
  const details = (res.json?.error?.details ?? []) as Array<Record<string, string>>;
  const fcmError = details.find((d) => typeof d['errorCode'] === 'string')?.['errorCode'];
  const code = fcmError ?? res.json?.error?.status ?? `HTTP_${res.status}`;
  const detail: string = res.json?.error?.message ?? JSON.stringify(res.json).slice(0, 500);

  return { ok: false, errorCode: code, errorDetail: detail, tokenGone: isTokenGone(code, detail) };
}

/**
 * O token morreu e não adianta insistir?
 *
 * UNREGISTERED é inequívoco: app desinstalado ou token rotacionado.
 *
 * INVALID_ARGUMENT exige cuidado — ele tanto significa "esse token é lixo"
 * quanto "seu payload está errado" (um número cru dentro de `data`, por
 * exemplo). Tratar os dois igual seria destrutivo: um erro de payload chega
 * em TODOS os aparelhos ao mesmo tempo e desativaria a turma inteira por um
 * bug de uma linha. Por isso só desativamos quando a mensagem do Google
 * aponta o campo do token.
 *
 * SENDER_ID_MISMATCH é o erro clássico desta aula: o token foi emitido por um
 * projeto Firebase e o envio saiu com a credencial de OUTRO. O aparelho está
 * vivo — quem está errado é a configuração —, então não desativamos nada.
 */
function isTokenGone(code: string, detail: string): boolean {
  if (code === 'UNREGISTERED') return true;
  if (code !== 'INVALID_ARGUMENT') return false;
  return /registration token|message\.token|not a valid FCM registration token/i.test(detail);
}

/**
 * O payload `data` do FCM é um mapa de string para string — sem exceção. Um
 * número cru ali devolve 400 INVALID_ARGUMENT, que é um dos erros mais chatos
 * de diagnosticar porque a mensagem do Google não diz qual campo errou.
 */
function stringifyData(data?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}
