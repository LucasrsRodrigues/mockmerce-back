import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

/**
 * Gera a especificação OpenAPI a partir dos schemas das rotas e serve o
 * Swagger UI em /docs. Os alunos leem a doc e testam a API ali mesmo.
 * O JSON em /docs/json também alimenta a geração do SDK cliente.
 */
export const swaggerPlugin = fp(async (app) => {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'E-commerce API — Projeto da Turma',
        description:
          'Backend multi-tenant para os projetos de e-commerce. ' +
          'Cada grupo usa sua API key (header **X-API-Key**) e, opcionalmente, ' +
          'o RM do aluno (header **X-Student-RM**) em cada chamada.',
        version: '1.0.0',
      },
      // Base URL das requisições na referência/playground. As rotas já têm o
      // prefixo /v1, então o server é só a origem (sem /v1).
      servers: [
        { url: 'https://api.mockmerce.com.br', description: 'Produção' },
        { url: 'http://localhost:3333', description: 'Local (desenvolvimento)' },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
            description: 'API key do grupo (fornecida pelo professor).',
          },
          studentRm: {
            type: 'apiKey',
            name: 'X-Student-RM',
            in: 'header',
            description: 'RM do aluno que está fazendo a chamada (para rastreio).',
          },
          customerToken: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Token do cliente final, obtido em POST /auth/login.',
          },
          studentToken: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Token do aluno (admin web), obtido em POST /store/auth/login. Vale no lugar da X-API-Key.',
          },
          adminToken: {
            type: 'apiKey',
            name: 'X-Admin-Token',
            in: 'header',
            description: 'Token mestre do professor (só você).',
          },
        },
      },
      tags: [
        { name: 'Catálogo', description: 'Categorias e produtos' },
        { name: 'Mídia', description: 'Upload de imagens e vídeos (S3) e biblioteca da loja' },
        { name: 'Avaliações', description: 'Nota, comentário e fotos dos clientes que compraram' },
        { name: 'Localização', description: 'Pontos de retirada, mapa e distância' },
        { name: 'Auth Cliente', description: 'Cadastro e login do comprador' },
        { name: 'Cliente', description: 'Endereços e favoritos do cliente logado' },
        { name: 'Carrinho', description: 'Carrinho do cliente logado' },
        { name: 'Pedidos', description: 'Checkout e pedidos (cliente)' },
        { name: 'Pedidos (loja)', description: 'Gestão de pedidos pela loja (X-API-Key)' },
        { name: 'Clientes (loja)', description: 'Clientes e segmentos (loja)' },
        { name: 'Comunicações', description: 'NF-e, e-mails e integrações fake' },
        { name: 'Pagamento', description: 'Pagamento simulado' },
        { name: 'Estoque', description: 'Saldo, movimentação, reserva, depósitos' },
        { name: 'Webhooks', description: 'Registro de webhooks, entregas e assinatura HMAC' },
        { name: 'Sandbox', description: 'Integrações FAKE: pagamento e frete simulados' },
        { name: 'Relatórios', description: 'Vendas, mais vendidos, clientes, estoque (+CSV)' },
        { name: 'Configurações', description: 'Config do grupo e LGPD' },
        { name: 'Ensino', description: 'Missões, XP, badges, ranking e nota (grupo)' },
        { name: 'Admin', description: 'Só o professor (X-Admin-Token / operador)' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });
});
