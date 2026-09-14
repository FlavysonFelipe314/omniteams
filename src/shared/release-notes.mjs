function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[._-]+/g, ' ');
}

function quotedJql(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function nextDate(value) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function releaseCardLayer(issue) {
  const value = normalizeText(issue?.categories);
  const front = /\b(front\s*end|frontend|front)\b/.test(value);
  const back = /\b(back\s*end|backend|back)\b/.test(value);
  if (front && back) return 'FRONT/BACK';
  if (front) return 'FRONT';
  if (back) return 'BACK';
  return 'NÃO INFORMADO';
}

export function releaseCardType(issue) {
  const value = normalizeText(issue?.issueType);
  if (/\b(bug|erro|defeito|incident|incidente)\b/.test(value)) return 'BUG';
  if (/\b(melhoria|improvement|enhancement|evolucao)\b/.test(value)) return 'MELHORIA';
  return 'TAREFA';
}

export function releaseNoteText(issue, position) {
  const type = releaseCardType(issue);
  const summary = String(issue?.summary || 'Sem resumo').trim();
  const key = String(issue?.key || '').trim();
  return `${position}º - ${type}: ${summary} (${key});`;
}

export function buildReleaseNoteRows(issues = [], order = 'homologation') {
  const uniqueIssues = new Map();
  issues.filter((issue) => issue?.key).forEach((issue) => {
    if (!uniqueIssues.has(issue.key)) uniqueIssues.set(issue.key, issue);
  });
  return [...uniqueIssues.values()]
    .sort((a, b) => {
      if (order === 'summary-asc' || order === 'summary-desc') {
        const difference = String(a.summary || '').localeCompare(String(b.summary || ''), 'pt-BR', { sensitivity: 'base' });
        if (difference) return order === 'summary-desc' ? -difference : difference;
      }
      return String(a.homologationDate || '').localeCompare(String(b.homologationDate || '')) || String(a.key).localeCompare(String(b.key));
    })
    .map((issue, index) => ({
      ...issue,
      layer: releaseCardLayer(issue),
      releaseType: releaseCardType(issue),
      releaseText: releaseNoteText(issue, index + 1)
    }));
}

export function releaseNotesJql({ startDate, endDate, projectKey = '', dateFieldIds = [] }) {
  const validFieldIds = [...new Set(dateFieldIds.map((fieldId) => String(fieldId).match(/\d+/)?.[0]).filter(Boolean))];
  const finishExclusive = nextDate(endDate);
  const dateFields = validFieldIds.length ? validFieldIds.map((fieldId) => `cf[${fieldId}]`) : ['resolutiondate'];
  const dateClause = dateFields
    .map((field) => `(${field} >= ${quotedJql(startDate)} AND ${field} < ${quotedJql(finishExclusive)})`)
    .join(' OR ');
  const projectClause = projectKey ? `project = ${quotedJql(projectKey)} AND ` : '';
  return `${projectClause}statusCategory = Done AND (${dateClause}) ORDER BY resolutiondate ASC, key ASC`;
}
