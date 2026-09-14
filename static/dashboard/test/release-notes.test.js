import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReleaseNoteRows, releaseCardLayer, releaseCardType, releaseNotesJql } from '../../../src/shared/release-notes.mjs';

test('classifica camada e tipo dos cards para release notes', () => {
  assert.equal(releaseCardLayer({ categories: 'Frontend, React' }), 'FRONT');
  assert.equal(releaseCardLayer({ categories: 'API, Back-end' }), 'BACK');
  assert.equal(releaseCardLayer({ categories: 'Front-end, Backend' }), 'FRONT/BACK');
  assert.equal(releaseCardLayer({ categories: 'Financeiro' }), 'NÃO INFORMADO');
  assert.equal(releaseCardType({ issueType: 'Bug' }), 'BUG');
  assert.equal(releaseCardType({ issueType: 'Melhoria' }), 'MELHORIA');
  assert.equal(releaseCardType({ issueType: 'Story' }), 'TAREFA');
});

test('monta texto numerado, ordena pela homologacao e remove cards duplicados', () => {
  const rows = buildReleaseNoteRows([
    { key: 'APP-2', summary: 'Corrigir formulário', issueType: 'Bug', categories: 'Front', homologationDate: '2026-09-10' },
    { key: 'APP-1', summary: 'Ajustar endpoint', issueType: 'Melhoria', categories: 'Back', homologationDate: '2026-09-09' },
    { key: 'APP-1', summary: 'Duplicado', issueType: 'Tarefa', homologationDate: '2026-09-09' }
  ]);

  assert.deepEqual(rows.map((row) => row.key), ['APP-1', 'APP-2']);
  assert.equal(rows[0].releaseText, '1º - MELHORIA: Ajustar endpoint (APP-1);');
  assert.equal(rows[1].releaseText, '2º - BUG: Corrigir formulário (APP-2);');
});

test('ordena release notes alfabeticamente pelo resumo nas duas direcoes', () => {
  const issues = [
    { key: 'APP-1', summary: 'Zerar contador', issueType: 'Tarefa', homologationDate: '2026-09-09' },
    { key: 'APP-2', summary: 'Ajustar formulário', issueType: 'Tarefa', homologationDate: '2026-09-10' },
    { key: 'APP-3', summary: 'Épico financeiro', issueType: 'Tarefa', homologationDate: '2026-09-11' }
  ];

  assert.deepEqual(buildReleaseNoteRows(issues, 'summary-asc').map((row) => row.key), ['APP-2', 'APP-3', 'APP-1']);
  assert.deepEqual(buildReleaseNoteRows(issues, 'summary-desc').map((row) => row.key), ['APP-1', 'APP-3', 'APP-2']);
});

test('gera JQL por campo de homologacao, projeto e fim exclusivo', () => {
  const customFieldJql = releaseNotesJql({ startDate: '2026-09-08', endDate: '2026-09-10', projectKey: 'APP', dateFieldIds: ['customfield_12345'] });
  assert.match(customFieldJql, /project = "APP"/);
  assert.match(customFieldJql, /statusCategory = Done/);
  assert.match(customFieldJql, /cf\[12345\] >= "2026-09-08"/);
  assert.match(customFieldJql, /cf\[12345\] < "2026-09-11"/);

  const fallbackJql = releaseNotesJql({ startDate: '2026-09-08', endDate: '2026-09-10' });
  assert.match(fallbackJql, /resolutiondate >= "2026-09-08"/);

  const multipleProjectsJql = releaseNotesJql({ startDate: '2026-09-08', endDate: '2026-09-10', projectKeys: ['APP', 'WEB'] });
  assert.match(multipleProjectsJql, /project in \("APP", "WEB"\)/);
});
