import { randomUUID, createHash } from 'node:crypto';
import { normalizeReportConfig, normalizeReportName } from '../shared/saved-report-config.mjs';

function ownerPrefix(context) {
  if (!context?.accountId) throw new Error('Não foi possível identificar seu usuário para acessar os relatórios salvos.');
  // Forge isolates installations; the authenticated context isolates users within each installation.
  return `saved-report:v1:${createHash('sha256').update(context.accountId).digest('hex')}:`;
}

function reportKey(context, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Relatório inválido.');
  return ownerPrefix(context) + id;
}

export function savedReportService(storage, beginsWith) {
  return {
    async list({ context }) {
      const prefix = ownerPrefix(context);
      const reports = [];
      let cursor;
      do {
        let query = storage.query().where('key', beginsWith(prefix)).limit(20);
        if (cursor) query = query.cursor(cursor);
        const page = await query.getMany();
        reports.push(...page.results.map(({ value: { id, name, createdAt, updatedAt } }) => ({ id, name, createdAt, updatedAt })));
        cursor = page.nextCursor;
      } while (cursor);
      return reports.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    },
    async get({ payload = {}, context }) {
      const report = await storage.get(reportKey(context, payload.id));
      if (!report) throw new Error('Este relatório não existe mais. Atualize a lista.');
      return report;
    },
    async save({ payload = {}, context }) {
      const name = normalizeReportName(payload.name);
      const config = normalizeReportConfig(payload.config);
      const id = payload.id || randomUUID();
      const key = reportKey(context, id);
      const previous = payload.id ? await storage.get(key) : null;
      if (payload.id && !previous) throw new Error('Este relatório não existe mais. Salve como um novo relatório.');
      const now = new Date().toISOString();
      const report = { id, name, config, createdAt: previous?.createdAt || now, updatedAt: now };
      await storage.set(key, report);
      return report;
    },
    async remove({ payload = {}, context }) {
      await storage.delete(reportKey(context, payload.id));
      return { id: payload.id };
    }
  };
}
