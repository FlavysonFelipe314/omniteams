export function timesheetJql(filters) {
  const { startDate, endDate } = filters;
  for (const value of [startDate, endDate]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('Informe as datas da grade de horas.');
  }
  if (startDate > endDate) throw new Error('Período inválido.');
  const custom = String(filters.jql || '').replace(/\border\s+by\b.*$/i, '').trim();
  const defaultWindow = !custom || /^updated\s*>=\s*-30d$/i.test(custom);
  return `${!defaultWindow ? `(${custom}) AND ` : ''}worklogDate >= "${startDate}" AND worklogDate <= "${endDate}" ORDER BY updated DESC`;
}

export function buildTimesheet({ people = [], entries = [], issues = [], startDate, endDate, filters = {}, today, weekdaysOnly = true }) {
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  const days = [];
  if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
    for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const date = cursor.toISOString().slice(0, 10);
      const weekend = [0, 6].includes(cursor.getUTCDay());
      if (!weekdaysOnly || !weekend) days.push({ date, weekend, future: date > today });
    }
  }
  const selected = people.filter((person) => !filters.persons?.length || filters.persons.includes(person.name));
  const issueByKey = new Map(issues.map((issue) => [issue.key, issue]));
  const rows = new Map(selected.map((person) => [person.accountId, { ...person, seconds: 0, byDate: {} }]));
  const seen = new Set();
  for (const entry of entries) {
    const row = rows.get(entry.accountId);
    if (!row || entry.date < startDate || entry.date > endDate) continue;
    const issue = issueByKey.get(entry.issue) || {};
    const multipleMatch = (value, filter) => !filter || String(value || '').split(',').map((x) => x.trim()).includes(filter);
    if (filters.parent && (issue.parent || 'Sem Épico/Pai') !== filters.parent) continue;
    if (filters.project && issue.project !== filters.project) continue;
    if (filters.status && issue.status !== filters.status) continue;
    if (!multipleMatch(issue.sprint, filters.sprint) || !multipleMatch(issue.categories, filters.category)) continue;
    if (filters.search && !`${issue.key || entry.issue} ${issue.summary || ''}`.toLowerCase().includes(filters.search.trim().toLowerCase())) continue;
    const identity = `${entry.issue}:${entry.id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    row.byDate[entry.date] = (row.byDate[entry.date] || 0) + Number(entry.seconds || 0);
    row.seconds += Number(entry.seconds || 0);
  }
  return { days, rows: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')) };
}
