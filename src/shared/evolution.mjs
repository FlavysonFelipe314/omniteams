function nextDate(value) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function quote(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function splitOrder(jql) {
  const match = String(jql || '').match(/\border\s+by\b/i);
  return match ? jql.slice(0, match.index).trim() : String(jql || '').trim();
}

function normalized(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function completedEvolutionJql({ startDate, endDate, jql = '' }) {
  const defaultJql = 'updated >= -30d order by updated desc';
  const condition = normalized(jql) === defaultJql ? '' : splitOrder(jql);
  const clauses = [
    condition ? `(${condition})` : '',
    'statusCategory = Done',
    `resolutiondate >= ${quote(startDate)}`,
    `resolutiondate < ${quote(nextDate(endDate))}`
  ].filter(Boolean);
  return `${clauses.join(' AND ')} ORDER BY resolutiondate ASC, key ASC`;
}
