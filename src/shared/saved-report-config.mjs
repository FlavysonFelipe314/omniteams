const TABS = ['indicators', 'management', 'profile', 'export'];

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, max = 500) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error('Um dos filtros excede o tamanho permitido.');
  return value;
}

function strings(value, max = 500) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error('Seleção de filtros inválida ou muito grande.');
  return [...new Set(value.map((entry) => text(entry, 250)))];
}

function date(value) {
  const result = text(value, 10);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error('Informe um período válido antes de salvar.');
  }
  return result;
}

// Store only configuration. Jira issues, worklogs and computed reports never enter storage.
export function normalizeReportConfig(input) {
  const value = object(input);
  const filters = object(value.filters);
  const management = object(value.managementFilters);
  const profile = object(value.profileFilters);
  const startDate = date(filters.startDate);
  const endDate = date(filters.endDate);
  if (startDate > endDate) throw new Error('A data final deve ser igual ou posterior à data inicial.');
  const accountIds = strings(filters.accountIds);
  const people = Array.isArray(value.people) ? value.people : [];
  const config = {
    version: 1,
    filters: {
      boardId: text(filters.boardId), sprintId: text(filters.sprintId), sprintQuery: text(filters.sprintQuery),
      status: text(filters.status), jql: text(filters.jql, 10000), startDate, endDate, accountIds
    },
    activeTab: TABS.includes(value.activeTab) ? value.activeTab : 'indicators',
    groupBy: value.groupBy === 'status' ? 'status' : 'person',
    managementFilters: {
      persons: strings(management.persons), status: text(management.status), project: text(management.project),
      sprint: text(management.sprint), category: text(management.category), search: text(management.search)
    },
    profileFilters: {
      role: text(profile.role), status: text(profile.status), project: text(profile.project),
      sprint: text(profile.sprint), category: text(profile.category), search: text(profile.search), onlyWorked: profile.onlyWorked === true
    },
    exportFields: strings(value.exportFields, 30),
    people: accountIds.map((accountId) => ({
      accountId, name: text(people.find((person) => person?.accountId === accountId)?.name || accountId, 250)
    }))
  };
  if (new TextEncoder().encode(JSON.stringify(config)).length > 100000) throw new Error('Há filtros demais para salvar neste relatório.');
  return config;
}

export function normalizeReportName(value) {
  const name = text(value, 80).trim();
  if (!name) throw new Error('Informe um nome para o relatório.');
  return name;
}
