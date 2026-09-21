import type { FastifyInstance } from 'fastify';
import { serverPushEnabled } from '../../lib/push.js';
import { deliver, listDevices, listMessages, registerDevice, removeDevice } from './service.js';
import { deleteGroupConfig, getGroupConfig, recheckGroupConfig, resolveCredentials, saveGroupCredentials } from './credentials.js';

/** Rotas do grupo (X-API-Key): disparar e inspecionar. */
const sec = [{ apiKey: [], studentRm: [] }];
/** Rotas do cliente final (JWT do app). */
const custSec = [{ apiKey: [], customerToken: [] }];

const PLATFORMS = ['ANDROID', 'IOS', 'WEB'] as const;

export async function pushRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  // ------------------------------------------------------------- STATUS
  app.get('/push/status', {
    schema: {
      tags: ['Push'],
      summary: 'O push está configurado neste ambiente?',
      description:
        'Use antes de abrir um chamado: `enabled: false` significa que a credencial do FCM não foi configurada no servidor, e todo envio responde 503 PUSH_DISABLED.',
      security: sec,
    },
  }, async (req) => {
    const resolved = await resolveCredentials(req.group!.id);
    const config = await getGroupConfig(req.group!.id);
    return {
      enabled: resolved !== null,
      // 'group'  = o projeto Firebase desta loja
      // 'server' = a credencial do professor (nenhuma foi registrada aqui)
      credencial: resolved?.source ?? null,
      projectId: resolved?.cred.projectId ?? null,
      servidorTemCredencial: serverPushEnabled(),
      config,
    };
  });

  // --------------------------------------------- APARELHOS (cliente logado)
  app.post('/customers/me/devices', {
    preHandler: app.requireCustomer,
    schema: {
      tags: ['Push'],
      summary: 'Registra o aparelho do cliente para receber push',
      description:
        'Chame a CADA abertura do app, depois do login. O token do FCM é por instalação e pode rotacionar sozinho — re-registrar é barato (upsert) e é o que mantém a entrega funcionando.',
      security: custSec,
      body: {
        type: 'object',
        required: ['token', 'platform'],
        properties: {
          token: { type: 'string', minLength: 10, description: 'Token CRU do FCM (getDevicePushTokenAsync), não o ExponentPushToken[...].' },
          platform: { type: 'string', enum: PLATFORMS as unknown as string[] },
          deviceName: { type: 'string' },
          appVersion: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as any;
    const device = await registerDevice(req.group!.id, req.customer!.id, body);
    return reply.code(201).send(device);
  });

  app.get('/customers/me/devices', {
    preHandler: app.requireCustomer,
    schema: { tags: ['Push'], summary: 'Aparelhos registrados do cliente', security: custSec },
  }, async (req) => listDevices(req.group!.id, { customerId: req.customer!.id }));

  app.delete('/customers/me/devices/:idOrToken', {
    preHandler: app.requireCustomer,
    schema: {
      tags: ['Push'],
      summary: 'Remove um aparelho (chame no logout)',
      description: 'Aceita o id do registro ou o token cru. Sem isto, quem sai da conta continua recebendo push do dono anterior.',
      security: custSec,
      params: { type: 'object', required: ['idOrToken'], properties: { idOrToken: { type: 'string' } } },
    },
  }, async (req, reply) => {
    await removeDevice(req.group!.id, (req.params as any).idOrToken, req.customer!.id);
    return reply.code(204).send();
  });

  // ------------------------------------------------- APARELHOS (a loja vê)
  app.get('/push/devices', {
    schema: {
      tags: ['Push'],
      summary: 'Aparelhos registrados na loja',
      security: sec,
      querystring: { type: 'object', properties: { customerId: { type: 'string' } } },
    },
  }, async (req) => listDevices(req.group!.id, req.query as any));

  // ---------------------------------------------------------------- ENVIO
  app.post('/push/send', {
    schema: {
      tags: ['Push'],
      summary: 'Dispara um push (FCM v1)',
      description: [
        'Escolha UM alvo: `customerId`, `deviceId`, `token` ou `allDevices: true`.',
        '',
        '`kind` decide o comportamento nos três estados do app:',
        '- `NOTIFICATION` — o sistema operacional desenha a notificação. Aparece com o app em segundo plano ou FECHADO, mas seu código só roda quando o usuário toca.',
        '- `DATA` — nada aparece sozinho; o app recebe os dados e decide. Com o app fechado no Android, a entrega não é garantida.',
        '',
        'O `data` é o que leva o deep link: mande `{ "rota": "produto", "produtoId": "..." }` e abra a tela certa no toque.',
      ].join('\n'),
      security: sec,
      body: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          deviceId: { type: 'string' },
          token: { type: 'string' },
          allDevices: { type: 'boolean' },
          title: { type: 'string' },
          body: { type: 'string' },
          data: { type: 'object', additionalProperties: true },
          kind: { type: 'string', enum: ['NOTIFICATION', 'DATA'], default: 'NOTIFICATION' },
          androidChannelId: { type: 'string', description: 'Canal do Android. Precisa já existir no app.' },
        },
      },
    },
  }, async (req) => {
    const b = req.body as any;
    return deliver(
      req.group!.id,
      { customerId: b.customerId, deviceId: b.deviceId, token: b.token, allDevices: b.allDevices },
      { title: b.title, body: b.body, data: b.data, kind: b.kind, androidChannelId: b.androidChannelId, reason: 'manual' },
    );
  });

  app.post('/push/test', {
    schema: {
      tags: ['Push'],
      summary: 'Push de teste com payload pronto (inclui deep link de exemplo)',
      description: 'Atalho de aula: mesmo caminho do /push/send, com título, corpo e `data` já preenchidos. Sem alvo, vai para todos os aparelhos ativos da loja.',
      security: sec,
      body: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          deviceId: { type: 'string' },
          token: { type: 'string' },
          produtoId: { type: 'string', description: 'Se informado, o toque deve abrir este produto.' },
          kind: { type: 'string', enum: ['NOTIFICATION', 'DATA'], default: 'NOTIFICATION' },
        },
      },
    },
  }, async (req) => {
    const b = (req.body ?? {}) as any;
    const hasTarget = Boolean(b.customerId || b.deviceId || b.token);
    return deliver(
      req.group!.id,
      { customerId: b.customerId, deviceId: b.deviceId, token: b.token, allDevices: !hasTarget },
      {
        title: 'Push de teste 🚀',
        body: 'Se você está lendo isto, o caminho servidor → FCM → aparelho está fechado.',
        data: b.produtoId ? { rota: 'produto', produtoId: b.produtoId } : { rota: 'home' },
        kind: b.kind ?? 'NOTIFICATION',
        reason: 'test',
      },
    );
  });

  // ------------------------------------------ CREDENCIAL DO FIREBASE (loja)
  app.get('/store/push-config', {
    schema: {
      tags: ['Push'],
      summary: 'Credencial do Firebase desta loja',
      description: 'Devolve projeto, conta de serviço e o resultado do último teste. A chave privada NUNCA volta.',
      security: sec,
    },
  }, async (req) => (await getGroupConfig(req.group!.id)) ?? { configurada: false });

  app.put('/store/push-config', {
    schema: {
      tags: ['Push'],
      summary: 'Registra a credencial do Firebase da loja',
      description: [
        'Cole o JSON da **conta de serviço** — Firebase Console → Configurações do projeto → Contas de serviço → "Gerar nova chave privada". Cru ou em base64, tanto faz.',
        '',
        'Não confunda com o `google-services.json`: aquele vai dentro do APP e identifica o aplicativo; este fica no servidor e autoriza o ENVIO.',
        '',
        'A chave é testada contra o Google na hora e guardada cifrada. Sem esta configuração, os envios da loja usam a credencial do servidor (a do professor).',
      ].join('\n'),
      security: sec,
      body: {
        type: 'object',
        required: ['serviceAccount'],
        properties: {
          serviceAccount: { type: 'string', minLength: 40, description: 'O JSON da conta de serviço (texto ou base64).' },
        },
      },
    },
  }, async (req) => saveGroupCredentials(req.group!.id, (req.body as any).serviceAccount));

  app.post('/store/push-config/check', {
    schema: { tags: ['Push'], summary: 'Testa a credencial salva (handshake OAuth, não envia nada)', security: sec },
  }, async (req) => recheckGroupConfig(req.group!.id));

  app.delete('/store/push-config', {
    schema: { tags: ['Push'], summary: 'Remove a credencial da loja (volta a usar a do servidor)', security: sec },
  }, async (req, reply) => {
    await deleteGroupConfig(req.group!.id);
    return reply.code(204).send();
  });

  // ------------------------------------------------------------ INSPECTOR
  app.get('/push/messages', {
    schema: {
      tags: ['Push'],
      summary: 'Histórico de envios (inspector)',
      description: 'Toda tentativa fica aqui, com o payload que saiu e a resposta do FCM. É o primeiro lugar a olhar quando "a notificação não chegou".',
      security: sec,
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['SENT', 'FAILED', 'SKIPPED'] },
          reason: { type: 'string', description: 'manual | test | price_drop' },
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async (req) => listMessages(req.group!.id, req.query as any));
}
