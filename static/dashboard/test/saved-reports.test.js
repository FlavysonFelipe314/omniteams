import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReportConfig } from '../../../src/shared/saved-report-config.mjs';
import { savedReportService } from '../../../src/resolvers/saved-reports.mjs';

function config() {
  return {
    filters: { boardId: 'project:APP', sprintId: '12', sprintQuery: '', jql: 'project = APP', status: 'Concluído', startDate: '2026-08-03', endDate: '2026-08-14', accountIds: ['ana', 'bia'] },
    activeTab: 'management', groupBy: 'status',
    managementFilters: { persons: ['Ana'], project: 'APP', category: 'Backend', search: 'login' },
    profileFilters: { role: 'QA', onlyWorked: true }, exportFields: ['key', 'summary', 'hours'],
    people: [{ accountId: 'ana', name: 'Ana' }, { accountId: 'bia', name: 'Bia' }],
    issueOptions: [{ key: 'APP-1', summary: 'Não armazenar dados de cards' }]
  };
}

function fixture() {
  const values = new Map();
  const storage = {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)); },
    delete: async (key) => { values.delete(key); },
    query() {
      let prefix; let offset = 0;
      return {
        where(_key, condition) { prefix = condition; return this; },
        limit() { return this; },
        cursor(value) { offset = Number(value); return this; },
        async getMany() {
          const all = [...values].filter(([key]) => key.startsWith(prefix));
          return {
            results: all.slice(offset, offset + 1).map(([key, value]) => ({ key, value: structuredClone(value) })),
            nextCursor: offset + 1 < all.length ? String(offset + 1) : undefined
          };
        }
      };
    }
  };
  return savedReportService(storage, (prefix) => prefix);
}

test('salva filtros completos sem persistir cards e sem vincular o snapshot ao estado mutável', () => {
  const source = config();
  const saved = normalizeReportConfig(source);
  assert.deepEqual(saved.filters, source.filters);
  assert.equal(saved.managementFilters.search, 'login');
  assert.equal(saved.profileFilters.onlyWorked, true);
  assert.equal(saved.groupBy, 'status');
  assert.deepEqual(saved.exportFields, ['key', 'summary', 'hours']);
  assert.equal(saved.issueOptions, undefined);
  source.filters.accountIds.push('carlos');
  source.people[0].name = 'Modificado';
  assert.deepEqual(saved.filters.accountIds, ['ana', 'bia']);
  assert.equal(saved.people[0].name, 'Ana');
  assert.deepEqual(normalizeReportConfig({ ...config(), filters: { ...config().filters, accountIds: [] } }).filters.accountIds, []);
});

test('cria, lista com paginação, restaura, renomeia, atualiza e exclui apenas o relatório escolhido', async () => {
  const service = fixture();
  const context = { accountId: 'gestor' };
  const first = await service.save({ context, payload: { name: ' Pessoa por Projeto ', config: config() } });
  const second = await service.save({ context, payload: { name: 'Outro', config: config() } });
  assert.equal(first.name, 'Pessoa por Projeto');
  const list = await service.list({ context });
  assert.equal(list.length, 2);
  assert.equal(list[0].config, undefined, 'lista não deve transportar todos os snapshots');
  assert.deepEqual((await service.get({ context, payload: { id: first.id } })).config, first.config);
  const updated = await service.save({ context, payload: { id: first.id, name: 'Renomeado', config: { ...config(), activeTab: 'profile' } } });
  assert.equal(updated.id, first.id);
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal(updated.config.activeTab, 'profile');
  await service.remove({ context, payload: { id: first.id } });
  assert.deepEqual((await service.list({ context })).map((report) => report.id), [second.id]);
  await assert.rejects(service.save({ context, payload: { id: first.id, name: 'Não recriar', config: config() } }), /não existe/);
});

test('usa o usuário autenticado e impede ler, alterar ou excluir relatórios de outra pessoa', async () => {
  const service = fixture();
  const owner = { accountId: 'ana' };
  const other = { accountId: 'bia' };
  const report = await service.save({ context: owner, payload: { name: 'Privado', config: config() } });
  assert.deepEqual(await service.list({ context: other }), []);
  await assert.rejects(service.get({ context: other, payload: { id: report.id, accountId: 'ana' } }), /não existe/);
  await assert.rejects(service.save({ context: other, payload: { id: report.id, accountId: 'ana', name: 'Alterado', config: config() } }), /não existe/);
  await service.remove({ context: other, payload: { id: report.id, accountId: 'ana' } });
  assert.equal((await service.get({ context: owner, payload: { id: report.id } })).name, 'Privado');
  await assert.rejects(service.list({ context: {} }), /identificar/);
});

test('rejeita nome vazio, períodos inválidos e seleções grandes sem gravar parcialmente', async () => {
  const service = fixture();
  const context = { accountId: 'ana' };
  await assert.rejects(service.save({ context, payload: { name: ' ', config: config() } }), /nome/);
  assert.throws(() => normalizeReportConfig({ filters: { startDate: '2026-02-30', endDate: '2026-09-01' } }), /período/);
  assert.throws(() => normalizeReportConfig({ filters: { startDate: '2026-09-02', endDate: '2026-09-01' } }), /data final/);
  assert.throws(() => normalizeReportConfig({ ...config(), filters: { ...config().filters, accountIds: Array(501).fill('a') } }), /grande/);
  assert.deepEqual(await service.list({ context }), []);
});
