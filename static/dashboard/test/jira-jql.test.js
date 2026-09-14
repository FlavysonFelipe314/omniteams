import test from 'node:test';
import assert from 'node:assert/strict';
import { boardScope, jqlLiteral } from '../../../src/shared/jira-jql.mjs';

test('coloca aspas em chaves que podem ser palavras reservadas do JQL', () => {
  assert.equal(jqlLiteral('AND'), '"AND"');
  assert.equal(jqlLiteral('API'), '"API"');
  assert.equal(jqlLiteral('Sprint 12'), '"Sprint 12"');
  assert.equal(jqlLiteral('123'), '123');
});

test('distingue corretamente quadros e espaços selecionados', () => {
  assert.deepEqual(boardScope('board:123'), { type: 'board', id: '123' });
  assert.deepEqual(boardScope('project:AND'), { type: 'project', key: 'AND' });
  assert.deepEqual(boardScope('123'), { type: 'board', id: '123' });
  assert.deepEqual(boardScope('API'), { type: 'project', key: 'API' });
});
