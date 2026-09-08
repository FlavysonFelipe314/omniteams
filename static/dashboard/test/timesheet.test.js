import test from 'node:test';
import assert from 'node:assert/strict';
import { parentIssue } from '../../../src/shared/parent-issue.mjs';
import { buildTimesheet, timesheetJql } from '../../../src/shared/timesheet.mjs';

test('normaliza pai direto, epic link legado e cards sem pai', () => {
  assert.deepEqual(parentIssue({ parent: { key: 'APP-10', fields: { summary: 'Portal' } }, customfield_1: 'OLD-1' }, ['customfield_1']), { parentKey: 'APP-10', parentSummary: 'Portal', parent: 'APP-10 · Portal' });
  assert.equal(parentIssue({ customfield_1: 'APP-20' }, ['customfield_1']).parent, 'APP-20');
  assert.equal(parentIssue({}).parent, 'Sem Épico/Pai');
});

const people = [{ accountId: 'ana', name: 'Ana' }, { accountId: 'bia', name: 'Bia' }];
const issues = [{ key: 'APP-1', parent: 'APP-10 · Portal', status: 'Concluído' }, { key: 'APP-2', parent: 'APP-20 · App' }];
const entries = [
  { id: '1', issue: 'APP-1', accountId: 'ana', date: '2026-09-07', seconds: 1800 },
  { id: '2', issue: 'APP-1', accountId: 'ana', date: '2026-09-07', seconds: 3600 },
  { id: '3', issue: 'APP-2', accountId: 'ana', date: '2026-09-08', seconds: 7200 },
  { id: '4', issue: 'APP-1', accountId: 'ana', date: '2026-09-12', seconds: 900 }
];
const base = { people, issues, entries, startDate: '2026-09-07', endDate: '2026-09-13', today: '2026-09-09' };

test('grade soma múltiplos apontamentos, deduplica lotes e preserva pessoa com zero horas', () => {
  const matrix = buildTimesheet({ ...base, entries: [...entries, entries[0]] });
  assert.equal(matrix.days.length, 5);
  assert.equal(matrix.rows[0].byDate['2026-09-07'], 5400);
  assert.equal(matrix.rows[0].seconds, 13500, 'total inclui sábado mesmo quando oculto');
  assert.equal(matrix.rows[1].seconds, 0);
  assert.equal(matrix.days[4].future, true);
  const weekends = buildTimesheet({ ...base, weekdaysOnly: false });
  assert.equal(weekends.days.length, 7);
  assert.equal(weekends.days[5].weekend, true);
});

test('grade respeita pessoa, período e pai sem ocultar a pessoa sem horas no filtro', () => {
  const matrix = buildTimesheet({ ...base, endDate: '2026-09-11', filters: { parent: 'APP-10 · Portal' } });
  assert.equal(matrix.rows[0].seconds, 5400);
  assert.equal(matrix.rows[1].seconds, 0);
  const selected = buildTimesheet({ ...base, filters: { persons: ['Bia'], parent: 'APP-10 · Portal' } });
  assert.deepEqual(selected.rows.map((row) => row.name), ['Bia']);
  assert.equal(selected.rows[0].seconds, 0);
});

test('consulta horas pela data do worklog sem aplicar a janela padrão de atualização do card', () => {
  const jql = timesheetJql({ startDate: '2026-08-03', endDate: '2026-08-14', jql: 'updated >= -30d ORDER BY updated DESC' });
  assert.match(jql, /worklogDate >= "2026-08-03"/);
  assert.doesNotMatch(jql, /updated >=/);
  assert.match(timesheetJql({ startDate: '2026-08-03', endDate: '2026-08-14', jql: 'project = APP ORDER BY created DESC' }), /\(project = APP\) AND worklogDate/);
  assert.throws(() => timesheetJql({ startDate: '', endDate: '' }), /datas/);
});
