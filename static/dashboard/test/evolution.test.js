import test from 'node:test';
import assert from 'node:assert/strict';
import { completedEvolutionJql } from '../../../src/shared/evolution.mjs';

test('gera JQL de evolução pelo período real de conclusão', () => {
  const jql = completedEvolutionJql({
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    jql: 'updated >= -30d ORDER BY updated DESC'
  });

  assert.match(jql, /statusCategory = Done/);
  assert.match(jql, /resolutiondate >= "2026-08-01"/);
  assert.match(jql, /resolutiondate < "2026-09-01"/);
  assert.doesNotMatch(jql, /updated >= -30d/);
});

test('preserva o filtro JQL personalizado na comparação', () => {
  const jql = completedEvolutionJql({
    startDate: '2026-09-01',
    endDate: '2026-09-07',
    jql: 'component = API ORDER BY created DESC'
  });

  assert.match(jql, /^\(component = API\) AND statusCategory = Done/);
  assert.match(jql, /ORDER BY resolutiondate ASC, key ASC$/);
});
