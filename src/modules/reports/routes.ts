import type { FastifyInstance, FastifyReply } from 'fastify';
import { badRequest } from '../../lib/errors.js';
import { toCsv } from './csv.js';
import { salesReport, topProducts, customersReport, inventoryReport } from './queries.js';

const sec = [{ apiKey: [], studentRm: [] }];

function parsePeriod(q: any): { from: Date; to: Date } {
  const from = q.from ? new Date(q.from) : new Date(0);
  let to: Date;
  if (q.to) {
    to = /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? new Date(`${q.to}T23:59:59.999Z`) : new Date(q.to);
  } else {
    to = new Date();
  }
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest('from/to inválidos (use ISO, ex.: 2026-08-01).');
  return { from, to };
}

function sendCsv(reply: FastifyReply, filename: string, rows: Record<string, unknown>[], columns: { key: string; label: string }[]) {
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
  return reply.send(toCsv(rows, columns));
}

const periodQuery = {
  type: 'object',
  properties: { from: { type: 'string' }, to: { type: 'string' }, format: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
};

export async function reportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireGroup);

  app.get('/reports/sales', {
    schema: { tags: ['Relatórios'], summary: 'Resumo de vendas + série diária (receita de pedidos pagos)', security: sec, querystring: periodQuery },
  }, async (req, reply) => {
    const { from, to } = parsePeriod(req.query);
    const report = await salesReport(req.group!.id, from, to);
    if ((req.query as any).format === 'csv') {
      return sendCsv(reply, 'vendas', report.series, [{ key: 'day', label: 'dia' }, { key: 'revenue', label: 'receita' }, { key: 'orders', label: 'pedidos' }]);
    }
    return report;
  });

  app.get('/reports/top-products', {
    schema: {
      tags: ['Relatórios'], summary: 'Produtos/variantes mais vendidos', security: sec,
      querystring: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' }, by: { type: 'string', enum: ['qty', 'revenue'], default: 'qty' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 }, format: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
      },
    },
  }, async (req, reply) => {
    const q = req.query as any;
    const { from, to } = parsePeriod(q);
    const data = await topProducts(req.group!.id, from, to, q.by ?? 'qty', q.limit ?? 10);
    if (q.format === 'csv') {
      return sendCsv(reply, 'mais-vendidos', data, [{ key: 'product', label: 'produto' }, { key: 'sku', label: 'sku' }, { key: 'variant', label: 'variante' }, { key: 'quantidade', label: 'quantidade' }, { key: 'receita', label: 'receita' }]);
    }
    return { data };
  });

  app.get('/reports/customers', {
    schema: { tags: ['Relatórios'], summary: 'Clientes: recorrentes vs novos', security: sec, querystring: periodQuery },
  }, async (req, reply) => {
    const { from, to } = parsePeriod(req.query);
    const report = await customersReport(req.group!.id, from, to);
    if ((req.query as any).format === 'csv') {
      return sendCsv(reply, 'clientes', report.data, [
        { key: 'nome', label: 'nome' }, { key: 'email', label: 'email' }, { key: 'segmento', label: 'segmento' },
        { key: 'pedidosNoPeriodo', label: 'pedidos_no_periodo' }, { key: 'pedidosTotais', label: 'pedidos_totais' }, { key: 'receita', label: 'receita' },
      ]);
    }
    return report;
  });

  app.get('/reports/inventory', {
    schema: { tags: ['Relatórios'], summary: 'Estoque: abaixo do mínimo / sem estoque', security: sec, querystring: { type: 'object', properties: { format: { type: 'string', enum: ['json', 'csv'], default: 'json' } } } },
  }, async (req, reply) => {
    const data = await inventoryReport(req.group!.id);
    if ((req.query as any).format === 'csv') {
      return sendCsv(reply, 'estoque', data, [{ key: 'produto', label: 'produto' }, { key: 'sku', label: 'sku' }, { key: 'disponivel', label: 'disponivel' }, { key: 'minimo', label: 'minimo' }, { key: 'situacao', label: 'situacao' }]);
    }
    return { data };
  });
}
