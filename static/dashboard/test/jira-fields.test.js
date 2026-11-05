import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingPersonFieldIds } from '../../../src/shared/jira-fields.mjs';

test('ignora o campo técnico Development ao descobrir o Dev do card', () => {
  const fields = [
    {
      id: 'customfield_10000',
      name: 'Development',
      schema: { custom: 'com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf' }
    },
    {
      id: 'customfield_10001',
      name: 'Desenvolvedor',
      schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker', type: 'user' }
    }
  ];

  assert.deepEqual(
    matchingPersonFieldIds(fields, ['dev', 'developer', 'desenvolvedor', 'desenvolvimento']),
    ['customfield_10001']
  );
});

test('termo curto Dev precisa ser uma palavra completa', () => {
  const fields = [
    { id: 'customfield_10002', name: 'Device', schema: {} },
    { id: 'customfield_10003', name: 'Dev', schema: {} }
  ];

  assert.deepEqual(matchingPersonFieldIds(fields, ['dev']), ['customfield_10003']);
});
