import { buildApp } from './app.js';
import { env } from './env.js';
import { prisma } from './prisma.js';
import { startReservationExpirer } from './modules/inventory/expirer.js';
import { startWebhookRelay } from './modules/webhooks/relay.js';
import { startAbandonmentJob } from './modules/cart/abandonment.js';
import { ensureProfessorOperator } from './modules/admin/bootstrap.js';

async function main() {
  const app = await buildApp();

  // Garante a conta ADMIN do professor (a partir do .env) antes de aceitar tráfego.
  await ensureProfessorOperator(app.log);

  // Job que libera reservas de estoque vencidas e cancela os pedidos.
  const stopExpirer = startReservationExpirer();
  // Worker que entrega os eventos do Outbox aos webhooks dos grupos.
  const stopRelay = startWebhookRelay();
  // Job que marca carrinhos abandonados.
  const stopAbandonment = startAbandonmentJob();

  const shutdown = async (signal: string) => {
    app.log.info(`Recebido ${signal}, encerrando...`);
    stopExpirer();
    stopRelay();
    stopAbandonment();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`📚 Swagger em http://localhost:${env.PORT}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
