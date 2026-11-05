const JIRA_DEVELOPMENT_FIELD = 'com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf';

function normalizeFieldName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function matchesToken(name, token) {
  const normalizedToken = normalizeFieldName(token);
  if (normalizedToken.length > 3) return name.includes(normalizedToken);
  return name.split(/[^a-z0-9]+/).includes(normalizedToken);
}

export function matchingPersonFieldIds(fields = [], tokens = []) {
  return fields
    .filter((field) => field.id?.startsWith('customfield_'))
    .filter((field) => field.schema?.custom !== JIRA_DEVELOPMENT_FIELD)
    .filter((field) => {
      const name = normalizeFieldName(field.name);
      return tokens.some((token) => matchesToken(name, token));
    })
    .map((field) => field.id);
}
