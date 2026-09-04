import Resolver from '@forge/resolver';
import api, { assumeTrustedRoute } from '@forge/api';

const resolver = new Resolver();

const DONE_CATEGORIES = new Set(['done']);
const BLOCKED_STATUS = new Set(['blocked', 'bloqueado', 'impedido', 'impedida']);
const APPROVED_STATUS = new Set(['aprovado', 'approved', 'aceito', 'accepted']);
const REPROVED_STATUS = new Set(['reprovado', 'reprovada', 'rejected', 'recusado', 'recusada']);
const STORY_POINTS_FIELDS = ['customfield_10016', 'customfield_10020', 'customfield_10026'];
const BASE_ISSUE_FIELDS = ['summary', 'status', 'assignee', 'reporter', 'project', 'issuetype', 'priority', 'updated', 'labels', 'components', 'worklog', ...STORY_POINTS_FIELDS];
const DEFAULT_JQL = 'updated >= -30d ORDER BY updated DESC';
const metadataCache = new Map();

define('getDashboardData', async ({ payload, context }) => {
  const filters = normalizeFilters(payload);
  const installationKey = context?.installContext || context?.installationContext || context?.cloudId || 'unknown-installation';
  const cacheScope = `${installationKey}:${context?.accountId || 'unknown-user'}`;
  const [peopleFields, boardData] = await Promise.all([
    cached(`fields:${cacheScope}`, 15 * 60_000, getPeopleFields),
    cached(`boards:${cacheScope}`, 5 * 60_000, getBoardData)
  ]);
  const boards = boardData.options;
  const scope = boardScope(filters.boardId);
  const scopeCacheKey = scope.type === 'board' ? `board:${scope.id}` : scope.type === 'project' ? `project:${scope.key}` : 'all';
  const sprintsForScope = scope.type === 'all'
    ? []
    : await cached(`sprints:${cacheScope}:${scopeCacheKey}`, 3 * 60_000, () => getSprintsForScope(scope, boardData.boards));
  const scopedJql = scopedFilterJql(filters, scope);
  const sprintBaseJql = scope.type === 'project' ? scopedProjectJql(scope.key, scopedJql) : scopedJql;
  const sprintFilter = filters.sprintId || filters.sprintQuery;
  const issues = sprintFilter
    ? await searchIssues(sprintJql(sprintFilter, sprintBaseJql), peopleFields)
    : scope.type === 'board'
    ? await searchBoardIssues(scope.id, scopedJql, peopleFields)
    : scope.type === 'project'
    ? await searchIssues(scopedProjectJql(scope.key, scopedJql), peopleFields)
    : await searchIssues(scopedJql, peopleFields);
  const worklogsByIssue = await loadWorklogs(issues, filters.startDate, filters.endDate);
  const discoveredCollaborators = getCollaborators(issues, worklogsByIssue, peopleFields);
  const knownAccountIds = new Set(discoveredCollaborators.map((person) => person.accountId));
  const viewerAccountId = context?.accountId || '';
  const requestedAccountIds = unique([...filters.accountIds, viewerAccountId].filter(Boolean));
  const missingAccountIds = requestedAccountIds.filter((accountId) => !knownAccountIds.has(accountId));
  const collaborators = mergeCollaborators(discoveredCollaborators, await getUsersByAccountIds(missingAccountIds));
  const reportIndex = buildReportIndex(issues, worklogsByIssue, peopleFields);
  const accountIds = filters.accountIds.length
    ? filters.accountIds
    : collaborators.slice(0, 1).map((person) => person.accountId);
  const reports = accountIds.map((accountId) => buildReport({
    accountId,
    name: collaborators.find((person) => person.accountId === accountId)?.name || accountId,
    avatarUrl: collaborators.find((person) => person.accountId === accountId)?.avatarUrl || '',
    issues,
    worklogsByIssue,
    reportIndex,
    peopleFields,
    startDate: filters.startDate,
    endDate: filters.endDate
  }));
  const managementReports = collaborators.map((person) => buildReport({
    accountId: person.accountId,
    name: person.name,
    avatarUrl: person.avatarUrl,
    issues,
    worklogsByIssue,
    reportIndex,
    peopleFields,
    startDate: filters.startDate,
    endDate: filters.endDate
  }));
  const currentUser = collaborators.find((person) => person.accountId === viewerAccountId) || null;
  const currentUserReport = managementReports.find((report) => report.accountId === viewerAccountId) || null;
  const discoveredSprints = getIssueSprints(issues, peopleFields);
  const sprints = mergeSprints(sprintsForScope, discoveredSprints);

  return {
    boards,
    sprints,
    collaborators,
    scopeCollaboratorIds: discoveredCollaborators.map((person) => person.accountId),
    reports,
    managementReports,
    currentUser,
    currentUserReport,
    issueOptions: issues.map((issue) => normalizeIssue(issue, peopleFields))
  };
});

async function cached(key, ttlMs, loader) {
  const now = Date.now();
  const existing = metadataCache.get(key);
  if (existing && existing.expiresAt > now) return existing.value;

  const pending = Promise.resolve().then(loader);
  metadataCache.set(key, { value: pending, expiresAt: now + ttlMs });
  try {
    const value = await pending;
    metadataCache.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  } catch (error) {
    metadataCache.delete(key);
    throw error;
  }
}

define('createWorklog', async ({ payload }) => {
  const body = worklogPayload(payload.startedUtc || payload.started, payload.hours, payload.comment);
  return jira(`/rest/api/3/issue/${encodeURIComponent(payload.issueKey)}/worklog`, {
    method: 'POST',
    body: JSON.stringify(body),
    asUser: true
  });
});

define('updateWorklog', async ({ payload }) => {
  const body = worklogPayload(payload.startedUtc || payload.started, payload.hours, payload.comment);
  return jira(`/rest/api/3/issue/${encodeURIComponent(payload.issueKey)}/worklog/${payload.worklogId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    asUser: true
  });
});

define('deleteWorklog', async ({ payload }) => {
  return jira(`/rest/api/3/issue/${encodeURIComponent(payload.issueKey)}/worklog/${payload.worklogId}`, {
    method: 'DELETE',
    asUser: true
  });
});

define('searchUsers', async ({ payload, context }) => {
  const rawQuery = String(payload?.query || '').trim();
  const projectKey = String(payload?.projectKey || '').trim();
  if (projectKey) {
    const cacheScope = context?.installContext || context?.installationContext || context?.cloudId || 'unknown-installation';
    const people = await cached(`project-collaborators:${cacheScope}:${projectKey}`, 3 * 60_000, async () => {
      const peopleFields = await cached(`fields:${cacheScope}`, 15 * 60_000, getPeopleFields);
      return getProjectCollaborators(projectKey, peopleFields);
    });
    const normalizedQuery = normalizeFieldName(rawQuery);
    return normalizedQuery
      ? people.filter((person) => normalizeFieldName(person.name).includes(normalizedQuery))
      : people;
  }
  const path = rawQuery
    ? `/rest/api/3/user/search?query=${encodeURIComponent(rawQuery)}&maxResults=30`
    : '/rest/api/3/users/search?maxResults=50';
  const users = await jira(path, { asUser: true });
  return (users || [])
    .filter((user) => user.accountId && user.accountType !== 'app')
    .map((user) => ({
      accountId: user.accountId,
      name: user.displayName || user.accountId,
      avatarUrl: user.avatarUrls?.['32x32'] || user.avatarUrls?.['48x48'] || ''
    }));
});

async function getProjectCollaborators(projectKey, peopleFields) {
  const issues = [];
  let nextPageToken = '';
  // Limita a leitura a 500 cards para manter a busca responsiva em projetos muito grandes.
  while (issues.length < 500) {
    const body = {
      jql: `project = ${jqlLiteral(projectKey)} ORDER BY updated DESC`,
      maxResults: 100,
      fields: unique(['assignee', 'reporter', ...(peopleFields.dev || []), ...(peopleFields.qa || [])])
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const data = await jira('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify(body),
      asUser: true
    });
    issues.push(...(data.issues || []));
    nextPageToken = data.nextPageToken || '';
    if (!data.issues?.length || !nextPageToken) break;
  }
  return getCollaborators(issues, {}, peopleFields);
}

async function jira(path, options = {}) {
  const client = options.asUser ? api.asUser() : api.asApp();
  const { asUser, ...requestOptions } = options;
  const response = await client.requestJira(assumeTrustedRoute(path), {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(requestOptions.headers || {})
    },
    ...requestOptions
  });
  if (response.status === 204) return {};
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data.errorMessages?.join(' ') || Object.values(data.errors || {}).join(' ') || `Jira HTTP ${response.status}`;
    throw new Error(`${message} em ${path}`);
  }
  return data;
}

function define(name, handler) {
  resolver.define(name, async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      throw normalizeError(error);
    }
  });
}

function normalizeError(error) {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  if (error && typeof error === 'object') {
    try {
      return new Error(JSON.stringify(error));
    } catch {
      return new Error('Erro desconhecido no resolver Forge.');
    }
  }
  return new Error('Erro desconhecido no resolver Forge.');
}

async function getBoardData() {
  const [boards, projects] = await Promise.all([getBoards(), getProjects()]);
  const options = [
    ...boards.map((board) => ({ ...board, id: `board:${board.id}`, source: 'board' })),
    ...projects.map((project) => ({ ...project, id: `project:${project.key}`, source: 'project' }))
  ].sort((a, b) => a.name.localeCompare(b.name));
  return { boards, projects, options };
}

async function getBoards(params = {}) {
  const boards = [];
  let startAt = 0;
  try {
    while (true) {
      const query = new URLSearchParams({
        startAt: String(startAt),
        maxResults: '50',
        ...(params.projectKeyOrId ? { projectKeyOrId: params.projectKeyOrId } : {})
      });
      const data = await jira(`/rest/agile/1.0/board?${query.toString()}`, { asUser: true });
      boards.push(...(data.values || []));
      startAt += data.values?.length || 0;
      if (data.isLast || !data.values?.length) break;
    }
  } catch (error) {
    console.warn(`Nao foi possivel listar boards: ${error.message}`);
    return [];
  }
  return boards.map((board) => ({
    id: String(board.id),
    name: board.name,
    type: board.type,
    projectKey: board.location?.projectKey || '',
    projectId: board.location?.projectId ? String(board.location.projectId) : ''
  }));
}

async function getProjects() {
  const projects = [];
  let startAt = 0;
  try {
    while (true) {
      const data = await jira(`/rest/api/3/project/search?startAt=${startAt}&maxResults=50&orderBy=name`, { asUser: true });
      projects.push(...(data.values || []));
      startAt += data.values?.length || 0;
      if (!data.values?.length || startAt >= (data.total || 0)) break;
    }
  } catch (error) {
    console.warn(`Nao foi possivel listar projetos/espacos: ${error.message}`);
    return [];
  }
  return projects
    .filter((project) => project.key)
    .map((project) => ({
      key: project.key,
      name: project.name || project.key,
      type: project.projectTypeKey || 'project',
      source: 'project'
    }));
}

async function getSprints(boardId) {
  const sprints = [];
  let startAt = 0;
  try {
    while (true) {
      const data = await jira(`/rest/agile/1.0/board/${boardId}/sprint?state=active,closed,future&startAt=${startAt}&maxResults=50`, { asUser: true });
      sprints.push(...(data.values || []));
      startAt += data.values?.length || 0;
      if (data.isLast || !data.values?.length) break;
    }
  } catch (error) {
    console.warn(`Nao foi possivel listar sprints: ${error.message}`);
    return [];
  }
  return sprints
    .map((sprint) => ({
      id: String(sprint.id),
      name: sprint.name,
      state: sprint.state,
      startDate: sprint.startDate || '',
      endDate: sprint.endDate || '',
      completeDate: sprint.completeDate || '',
      boardId: String(boardId)
    }))
    .sort(compareSprints);
}

async function getSprintsForScope(scope, allBoards) {
  if (scope.type === 'board') {
    const board = allBoards.find((item) => item.id === scope.id);
    return addBoardNames(await getSprints(scope.id), board);
  }

  if (scope.type === 'project') {
    const boards = allBoards.filter((board) => board.projectKey === scope.key || board.projectId === scope.key);
    const projectBoards = boards.length ? boards : await getBoards({ projectKeyOrId: scope.key });
    return getSprintsForBoards(projectBoards);
  }

  return [];
}

async function getSprintsForBoards(boards) {
  const sprintLists = await Promise.all(
    boards.map(async (board) => addBoardNames(await getSprints(board.id), board))
  );
  return mergeSprints(...sprintLists);
}

function addBoardNames(sprints, board) {
  return sprints.map((sprint) => ({
    ...sprint,
    boardName: board?.name || sprint.boardName || '',
    boardType: board?.type || sprint.boardType || ''
  }));
}

function mergeSprints(...groups) {
  const sprints = new Map();
  groups.flat().filter(Boolean).forEach((sprint) => {
    const key = sprint.id ? `id:${sprint.id}` : `name:${normalizeFieldName(sprint.name)}`;
    const current = sprints.get(key) || {};
    sprints.set(key, { ...current, ...sprint });
  });
  return [...sprints.values()].sort(compareSprints);
}

function compareSprints(a, b) {
  const stateOrder = { active: 0, future: 1, closed: 2 };
  const stateDiff = (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9);
  if (stateDiff) return stateDiff;
  return String(b.startDate || b.completeDate || b.endDate || b.id || b.name)
    .localeCompare(String(a.startDate || a.completeDate || a.endDate || a.id || a.name));
}

async function getPeopleFields() {
  try {
    const fields = await jira('/rest/api/3/field', { asUser: true });
    return {
      dev: matchingFieldIds(fields, ['dev', 'developer', 'desenvolvedor', 'desenvolvimento', 'responsavel desenvolvimento']),
      qa: matchingFieldIds(fields, ['qa', 'q.a', 'quality', 'tester', 'testador', 'homologador']),
      rejection: matchingFieldIds(fields, ['reprovacao', 'reprovacoes', 'rejection', 'rejected']),
      approval: matchingFieldIds(fields, ['aprovacao', 'aprovacoes', 'approval', 'approved']),
      category: matchingFieldIds(fields, ['categoria', 'categorias', 'category']),
      project: matchingFieldIds(fields, ['projeto', 'project']),
      sprint: matchingFieldIds(fields, ['sprint'])
    };
  } catch (error) {
    console.warn(`Nao foi possivel listar campos customizados: ${error.message}`);
    return { dev: [], qa: [], rejection: [], approval: [], category: [], project: [], sprint: [] };
  }
}

function matchingFieldIds(fields, tokens) {
  return (fields || [])
    .filter((field) => field.id?.startsWith('customfield_'))
    .filter((field) => {
      const name = normalizeFieldName(field.name);
      return tokens.some((token) => name.includes(normalizeFieldName(token)));
    })
    .map((field) => field.id);
}

function issueFields(peopleFields = {}) {
  return unique([
    ...BASE_ISSUE_FIELDS,
    ...(peopleFields.dev || []),
    ...(peopleFields.qa || []),
    ...(peopleFields.rejection || []),
    ...(peopleFields.approval || []),
    ...(peopleFields.category || []),
    ...(peopleFields.project || []),
    ...(peopleFields.sprint || [])
  ]);
}

async function searchIssues(jql, peopleFields) {
  const issues = [];
  let nextPageToken = '';
  while (true) {
    const body = {
      jql: boundedJql(jql),
      maxResults: 100,
      fields: issueFields(peopleFields)
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const data = await jira('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify(body),
      asUser: true
    });
    issues.push(...(data.issues || []));
    nextPageToken = data.nextPageToken || '';
    if (!data.issues?.length || !nextPageToken) break;
  }
  return issues;
}

async function searchBoardIssues(boardId, jql, peopleFields) {
  const issues = [];
  let startAt = 0;
  while (true) {
    const fields = issueFields(peopleFields).join(',');
    const data = await jira(`/rest/agile/1.0/board/${boardId}/issue?startAt=${startAt}&maxResults=100&jql=${encodeURIComponent(boundedJql(jql))}&fields=${encodeURIComponent(fields)}`, { asUser: true });
    issues.push(...(data.issues || []));
    startAt += data.issues?.length || 0;
    if (!data.issues?.length || startAt >= (data.total || 0)) break;
  }
  return issues;
}

async function loadWorklogs(issues, startDate, endDate) {
  const entries = await Promise.all(issues.map(async (issue) => {
    const embedded = issue.fields?.worklog;
    const allEmbeddedWorklogs = embedded?.worklogs || [];
    const periodWorklogs = allEmbeddedWorklogs.filter((worklog) => inPeriod(worklog.started, startDate, endDate));
    const hasAllEmbedded = embedded && Number(embedded.total || 0) <= allEmbeddedWorklogs.length;
    return [issue.key, hasAllEmbedded ? periodWorklogs : await getWorklogs(issue.key, startDate, endDate)];
  }));
  return Object.fromEntries(entries);
}

async function getWorklogs(issueKey, startDate, endDate) {
  const worklogs = [];
  let startAt = 0;
  while (true) {
    const query = new URLSearchParams({ startAt: String(startAt), maxResults: '100' });
    // A folga cobre worklogs gravados em qualquer fuso; inPeriod faz o corte exato depois.
    const startedAfter = dateBoundaryTimestamp(startDate, 0, -14);
    const startedBefore = dateBoundaryTimestamp(endDate, 1, 14);
    if (startedAfter) query.set('startedAfter', String(startedAfter));
    if (startedBefore) query.set('startedBefore', String(startedBefore));
    const data = await jira(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog?${query.toString()}`, { asUser: true });
    worklogs.push(...(data.worklogs || []));
    startAt += data.worklogs?.length || 0;
    if (!data.worklogs?.length || startAt >= (data.total || 0)) break;
  }
  return worklogs.filter((worklog) => inPeriod(worklog.started, startDate, endDate));
}

function dateBoundaryTimestamp(value, dayOffset = 0, hourOffset = 0) {
  if (!value) return 0;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return 0;
  date.setUTCDate(date.getUTCDate() + dayOffset);
  date.setUTCHours(date.getUTCHours() + hourOffset);
  return date.getTime();
}

function buildReport({ accountId, name, avatarUrl, issues, worklogsByIssue, reportIndex, peopleFields, startDate, endDate }) {
  const userIssues = reportIndex
    ? (reportIndex.issuesByAssignee.get(accountId) || [])
    : issues.filter((issue) => assigneeId(issue) === accountId);
  const qaIssues = (reportIndex?.issuesByQa.get(accountId) || [])
    .filter((issue) => wasReviewed(issue, peopleFields));
  const reporterIssues = reportIndex
    ? (reportIndex.issuesByReporter.get(accountId) || [])
    : issues.filter((issue) => reporterId(issue) === accountId);
  const worklogs = [];
  const touched = new Set();

  const userWorklogs = reportIndex
    ? (reportIndex.worklogsByAuthor.get(accountId) || [])
    : issues.flatMap((issue) => (worklogsByIssue[issue.key] || []).map((worklog) => ({ issue, worklog })));
  for (const entry of userWorklogs) {
    const { issue, worklog } = entry;
    if (worklog.author?.accountId !== accountId) continue;
    if (!inPeriod(worklog.started, startDate, endDate)) continue;
    touched.add(issue.key);
    worklogs.push(normalizeWorklog(issue, worklog));
  }

  const touchedIssues = issues.filter((issue) => touched.has(issue.key));
  const normalizedIssues = userIssues.map((issue) => normalizeIssue(issue, peopleFields));
  const normalizedQaIssues = qaIssues.map((issue) => normalizeIssue(issue, peopleFields));
  const normalizedReporterIssues = reporterIssues.map((issue) => normalizeIssue(issue, peopleFields));
  const creditedIssues = [...new Map([...userIssues, ...qaIssues].map((issue) => [issue.key, issue])).values()];
  const normalizedCreditedIssues = creditedIssues.map((issue) => normalizeIssue(issue, peopleFields));
  const approvedIssues = normalizedCreditedIssues.filter((issue) => issue.approved);
  const reprovedIssues = normalizedCreditedIssues.filter((issue) => issue.rejection > 0);

  return {
    accountId,
    name,
    avatarUrl,
    metrics: {
      totalCards: creditedIssues.length,
      workedCards: touched.size,
      storyPoints: sum(creditedIssues.map(storyPoints)),
      workedStoryPoints: sum(touchedIssues.map(storyPoints)),
      hours: round(sum(worklogs.map((row) => row.seconds)) / 3600),
      done: creditedIssues.filter(isDone).length,
      inProgress: creditedIssues.filter(isInProgress).length,
      blocked: creditedIssues.filter(isBlocked).length,
      approved: approvedIssues.length,
      reproved: sum(reprovedIssues.map((issue) => issue.rejection)),
      qaCards: qaIssues.length,
      qaStoryPoints: sum(qaIssues.map(storyPoints)),
      reportedCards: reporterIssues.length
    },
    issues: normalizedIssues,
    qaIssues: normalizedQaIssues,
    reportedIssues: normalizedReporterIssues,
    approvedIssues,
    reprovedIssues,
    worklogs,
    calendarWeeks: buildCalendar(worklogs, startDate, endDate)
  };
}

async function getUsersByAccountIds(accountIds) {
  const uniqueIds = unique(accountIds || []);
  const people = await Promise.all(uniqueIds.map(async (accountId) => {
    try {
      const user = await jira(`/rest/api/3/user?accountId=${encodeURIComponent(accountId)}`, { asUser: true });
      return {
        accountId: user.accountId || accountId,
        name: user.displayName || accountId,
        avatarUrl: user.avatarUrls?.['32x32'] || user.avatarUrls?.['48x48'] || ''
      };
    } catch (error) {
      console.warn(`Nao foi possivel carregar o colaborador ${accountId}: ${error.message}`);
      return null;
    }
  }));
  return people.filter(Boolean);
}

function mergeCollaborators(...groups) {
  const people = new Map();
  groups.flat().filter((person) => person?.accountId).forEach((person) => people.set(person.accountId, person));
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildReportIndex(issues, worklogsByIssue, peopleFields) {
  const issuesByAssignee = new Map();
  const issuesByQa = new Map();
  const issuesByReporter = new Map();
  const worklogsByAuthor = new Map();
  for (const issue of issues) {
    const accountId = assigneeId(issue);
    if (accountId) {
      const assigned = issuesByAssignee.get(accountId) || [];
      assigned.push(issue);
      issuesByAssignee.set(accountId, assigned);
    }
    const issueReporterId = reporterId(issue);
    if (issueReporterId) {
      const reported = issuesByReporter.get(issueReporterId) || [];
      reported.push(issue);
      issuesByReporter.set(issueReporterId, reported);
    }
    for (const person of customPeople(issue, peopleFields.qa)) {
      const qaIssues = issuesByQa.get(person.accountId) || [];
      qaIssues.push(issue);
      issuesByQa.set(person.accountId, qaIssues);
    }
    for (const worklog of worklogsByIssue[issue.key] || []) {
      const authorId = worklog.author?.accountId;
      if (!authorId) continue;
      const authored = worklogsByAuthor.get(authorId) || [];
      authored.push({ issue, worklog });
      worklogsByAuthor.set(authorId, authored);
    }
  }
  return { issuesByAssignee, issuesByQa, issuesByReporter, worklogsByAuthor };
}

function getCollaborators(issues, worklogsByIssue, peopleFields) {
  const people = new Map();
  for (const issue of issues) {
    if (assigneeId(issue)) {
      people.set(assigneeId(issue), {
        accountId: assigneeId(issue),
        name: assigneeName(issue) || assigneeId(issue),
        avatarUrl: issue.fields?.assignee?.avatarUrls?.['32x32'] || issue.fields?.assignee?.avatarUrls?.['48x48'] || ''
      });
    }
    if (reporterId(issue)) {
      people.set(reporterId(issue), {
        accountId: reporterId(issue),
        name: reporterName(issue) || reporterId(issue),
        avatarUrl: issue.fields?.reporter?.avatarUrls?.['32x32'] || issue.fields?.reporter?.avatarUrls?.['48x48'] || ''
      });
    }
    for (const person of customPeople(issue, peopleFields.dev)) {
      people.set(person.accountId, person);
    }
    for (const person of customPeople(issue, peopleFields.qa)) {
      people.set(person.accountId, person);
    }
  }
  for (const worklogs of Object.values(worklogsByIssue)) {
    for (const worklog of worklogs) {
      if (worklog.author?.accountId) {
        people.set(worklog.author.accountId, {
          accountId: worklog.author.accountId,
          name: worklog.author.displayName || worklog.author.accountId,
          avatarUrl: worklog.author.avatarUrls?.['32x32'] || worklog.author.avatarUrls?.['48x48'] || ''
        });
      }
    }
  }
  return [...people.values()]
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeIssue(issue, peopleFields = {}) {
  const dev = customPersonName(issue, peopleFields.dev) || assigneeName(issue) || 'Sem responsavel';
  const qa = customPersonName(issue, peopleFields.qa) || '';
  const categories = customFieldText(issue, peopleFields.category) || categoryText(issue);
  const project = customFieldText(issue, peopleFields.project) || issue.fields?.project?.name || issue.fields?.project?.key || '';
  const sprint = customFieldText(issue, peopleFields.sprint) || '';
  const rejection = rejectionCount(issue, peopleFields);
  const approved = isApproved(issue, peopleFields);
  const result = approved ? 'Aprovado' : rejection > 0 ? 'Reprovado' : '';
  return {
    key: issue.key,
    summary: issue.fields?.summary || '',
    status: statusName(issue),
    reviewResult: result,
    approved,
    rejection,
    assignee: assigneeName(issue) || 'Sem responsavel',
    assigneeAccountId: assigneeId(issue),
    reporter: reporterName(issue) || 'Sem relator',
    reporterAccountId: reporterId(issue),
    dev,
    qa,
    qaAccountIds: customPeople(issue, peopleFields.qa).map((person) => person.accountId),
    categories,
    avatarUrl: issue.fields?.assignee?.avatarUrls?.['32x32'] || issue.fields?.assignee?.avatarUrls?.['48x48'] || '',
    project,
    sprint,
    storyPoints: storyPoints(issue),
    updated: issue.fields?.updated || ''
  };
}

function getIssueSprints(issues, peopleFields = {}) {
  const sprintFields = peopleFields.sprint || [];
  return mergeSprints(...issues.map((issue) => {
    const fields = sprintFields.length
      ? sprintFields
      : Object.keys(issue.fields || {}).filter((fieldId) => fieldId.startsWith('customfield_'));
    return fields.flatMap((fieldId) => sprintOptionsFromValue(issue.fields?.[fieldId]));
  }));
}

function sprintOptionsFromValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(sprintOptionsFromValue);
  if (typeof value === 'object') {
    const name = value.name || value.value || '';
    if (!name && !value.id) return [];
    return [{
      id: value.id ? String(value.id) : '',
      name: name || String(value.id),
      state: value.state || '',
      startDate: value.startDate || '',
      endDate: value.endDate || '',
      completeDate: value.completeDate || '',
      boardId: value.boardId ? String(value.boardId) : '',
      boardName: value.boardName || '',
      discovered: true
    }];
  }
  if (typeof value === 'string') return sprintOptionsFromLegacyString(value);
  return [];
}

function sprintOptionsFromLegacyString(value) {
  const text = String(value || '');
  const matches = [...text.matchAll(/id=([^,\]]+).*?state=([^,\]]+).*?name=([^,\]]+).*?(?:startDate=([^,\]]+))?.*?(?:endDate=([^,\]]+))?.*?(?:completeDate=([^,\]]+))?/gi)];
  if (matches.length) {
    return matches.map((match) => ({
      id: match[1] ? String(match[1]).trim() : '',
      state: match[2] ? String(match[2]).trim().toLowerCase() : '',
      name: match[3] ? String(match[3]).trim() : '',
      startDate: match[4] ? String(match[4]).trim() : '',
      endDate: match[5] ? String(match[5]).trim() : '',
      completeDate: match[6] ? String(match[6]).trim() : '',
      discovered: true
    })).filter((sprint) => sprint.name || sprint.id);
  }

  const name = text.match(/name=([^,\]]+)/i)?.[1] || '';
  const id = text.match(/id=([^,\]]+)/i)?.[1] || '';
  if (!name && !id) return [];
  return [{ id: String(id).trim(), name: String(name || id).trim(), discovered: true }];
}

function normalizeWorklog(issue, worklog) {
  return {
    id: worklog.id,
    issue: issue.key,
    summary: issue.fields?.summary || '',
    status: statusName(issue),
    started: worklog.started,
    startedRaw: toDatetimeLocal(worklog.started),
    date: worklog.started?.slice(0, 10) || '',
    seconds: worklog.timeSpentSeconds || 0,
    hours: round((worklog.timeSpentSeconds || 0) / 3600),
    comment: plainText(worklog.comment)
  };
}

function buildCalendar(worklogs, startDate, endDate) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  const cursor = new Date(start);
  cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
  const last = new Date(end);
  last.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7)));
  const byDate = groupBy(worklogs, (row) => row.date);
  const days = [];
  while (cursor <= last) {
    const key = cursor.toISOString().slice(0, 10);
    const entries = byDate[key] || [];
    days.push({
      date: key,
      label: cursor.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
      inPeriod: cursor >= start && cursor <= end,
      hours: round(sum(entries.map((entry) => entry.seconds)) / 3600),
      entries
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

function worklogPayload(started, hours, comment) {
  return {
    started: formatStarted(started),
    timeSpentSeconds: Math.max(1, Math.round(Number(hours || 0) * 3600)),
    comment: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: comment || '' }] }]
    }
  };
}

function normalizeFilters(payload = {}) {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  return {
    boardId: payload.boardId || '',
    sprintId: payload.sprintId || '',
    sprintQuery: String(payload.sprintQuery || '').trim(),
    jql: payload.jql || DEFAULT_JQL,
    startDate: payload.startDate || localDate(monday),
    endDate: payload.endDate || localDate(friday),
    accountIds: Array.isArray(payload.accountIds) ? payload.accountIds : []
  };
}

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function boardScope(value) {
  const raw = String(value || '').trim();
  if (!raw) return { type: 'all' };
  if (raw.startsWith('board:')) return { type: 'board', id: raw.slice('board:'.length) };
  if (raw.startsWith('project:')) return { type: 'project', key: raw.slice('project:'.length) };
  if (/^\d+$/.test(raw)) return { type: 'board', id: raw };
  return { type: 'project', key: raw };
}

function scopedFilterJql(filters, scope) {
  return withDateRangeJql(filters.jql, filters.startDate, filters.endDate, scope.type === 'all');
}

function scopedProjectJql(projectKey, jql) {
  const base = boundedJql(jql);
  const orderMatch = base.match(/\border\s+by\b/i);
  const condition = orderMatch ? base.slice(0, orderMatch.index).trim() : base.trim();
  const order = orderMatch ? base.slice(orderMatch.index).trim() : 'ORDER BY updated DESC';
  return `project = ${jqlLiteral(projectKey)}${condition ? ` AND (${condition})` : ''} ${order}`;
}

function sprintJql(sprintId, jql) {
  const base = boundedJql(jql);
  const { condition, order } = splitJqlOrder(base);
  return `sprint = ${jqlLiteral(sprintId)}${condition ? ` AND (${condition})` : ''} ${order}`;
}

function withDateRangeJql(jql, startDate, endDate, requireDefaultWindow = false) {
  const base = boundedJql(jql);
  const { condition, order } = splitJqlOrder(base);
  const isDefaultJql = normalizeJql(base) === normalizeJql(DEFAULT_JQL);
  const effectiveCondition = isDefaultJql ? '' : condition;
  const clauses = [];
  if (effectiveCondition) clauses.push(effectiveCondition);
  if (startDate && !hasJqlField(effectiveCondition, 'updated')) clauses.push(`updated >= ${jqlLiteral(startDate)}`);
  if (endDate && !hasJqlField(effectiveCondition, 'updated')) clauses.push(`updated <= ${jqlLiteral(`${endDate} 23:59`)}`);
  if (requireDefaultWindow && !clauses.length) clauses.push('updated >= -30d');
  return `${clauses.join(' AND ')} ${order}`.trim();
}

function splitJqlOrder(jql) {
  const orderMatch = String(jql || '').match(/\border\s+by\b/i);
  return {
    condition: orderMatch ? jql.slice(0, orderMatch.index).trim() : String(jql || '').trim(),
    order: orderMatch ? jql.slice(orderMatch.index).trim() : 'ORDER BY updated DESC'
  };
}

function hasJqlField(jql, field) {
  return new RegExp(`\\b${field}\\b\\s*(=|!=|in|not in|>=|<=|>|<|~)`, 'i').test(String(jql || ''));
}

function normalizeJql(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function jqlLiteral(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return text;
  if (/^[A-Z][A-Z0-9_]*$/i.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function boundedJql(jql) {
  const clean = String(jql || '').trim() || DEFAULT_JQL;
  if (/\b(project|assignee|reporter|created|updated|key|issuekey|status|sprint|fixversion|component|filter)\b\s*(=|!=|in|not in|>=|<=|>|<|~)/i.test(clean)) return clean;
  const orderMatch = clean.match(/\border\s+by\b/i);
  if (orderMatch) return `updated >= -30d ${clean.slice(orderMatch.index)}`;
  return `updated >= -30d AND (${clean}) ORDER BY updated DESC`;
}

function assigneeId(issue) {
  return issue.fields?.assignee?.accountId || '';
}

function assigneeName(issue) {
  return issue.fields?.assignee?.displayName || '';
}

function reporterId(issue) {
  return issue.fields?.reporter?.accountId || '';
}

function reporterName(issue) {
  return issue.fields?.reporter?.displayName || '';
}

function statusName(issue) {
  return issue.fields?.status?.name || 'Sem status';
}

function statusKey(issue) {
  return (issue.fields?.status?.statusCategory?.key || '').toLowerCase();
}

function storyPoints(issue) {
  for (const field of STORY_POINTS_FIELDS) {
    const value = issue.fields?.[field];
    if (typeof value === 'number') return value;
  }
  return 0;
}

function customPersonName(issue, fieldIds = []) {
  const people = customPeople(issue, fieldIds);
  return people.length ? people.map((person) => person.name).join(', ') : customFieldText(issue, fieldIds);
}

function customPeople(issue, fieldIds = []) {
  const people = new Map();
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    if (value.accountId) {
      people.set(value.accountId, {
        accountId: value.accountId,
        name: value.displayName || value.name || value.accountId,
        avatarUrl: value.avatarUrls?.['32x32'] || value.avatarUrls?.['48x48'] || ''
      });
      return;
    }
    if (value.value && typeof value.value === 'object') visit(value.value);
    if (value.values) visit(value.values);
  };
  fieldIds.forEach((fieldId) => visit(issue.fields?.[fieldId]));
  return [...people.values()];
}

function customFieldText(issue, fieldIds = []) {
  for (const fieldId of fieldIds) {
    const value = issue.fields?.[fieldId];
    const name = valueToName(value);
    if (name) return name;
  }
  return '';
}

function valueToName(value) {
  if (!value) return '';
  if (typeof value === 'string') return readableLegacyValue(value);
  if (Array.isArray(value)) return value.map(valueToName).filter(Boolean).join(', ');
  if (typeof value === 'object' && value.name) return value.name;
  if (typeof value === 'object') return value.displayName || value.name || value.value || value.emailAddress || '';
  return String(value);
}

function readableLegacyValue(value) {
  const sprintName = value.match(/name=([^,\]]+)/i)?.[1];
  if (sprintName) return sprintName;
  return value;
}

function categoryText(issue) {
  const components = (issue.fields?.components || []).map((component) => component.name).filter(Boolean);
  if (components.length) return components.join(', ');
  const labels = issue.fields?.labels || [];
  if (labels.length) return labels.join(', ');
  return issue.fields?.issuetype?.name || '';
}

function normalizeFieldName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function rejectionCount(issue, peopleFields = {}) {
  const fieldCount = sum((peopleFields.rejection || []).map((fieldId) => countRejections(issue.fields?.[fieldId])));
  if (fieldCount > 0) return fieldCount;
  return REPROVED_STATUS.has(normalizeFieldName(statusName(issue))) ? 1 : 0;
}

function countRejections(value) {
  if (value === null || value === undefined || value === '' || value === false) return 0;
  if (typeof value === 'number') return Math.max(0, value);
  if (Array.isArray(value)) return sum(value.map(countRejections));
  if (typeof value === 'object') {
    if ('value' in value) return countRejections(value.value);
    if ('count' in value) return countRejections(value.count);
    return Object.keys(value).length ? 1 : 0;
  }
  const text = normalizeFieldName(value).trim();
  if (!text || ['0', 'nenhum', 'nenhuma', 'nao', 'false', 'n/a'].includes(text)) return 0;
  const numeric = Number(String(value).replace(',', '.'));
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 1;
}

function isApproved(issue, peopleFields = {}) {
  const name = normalizeFieldName(statusName(issue));
  if (APPROVED_STATUS.has(name) || isDone(issue)) return true;
  return (peopleFields.approval || []).some((fieldId) => countApprovals(issue.fields?.[fieldId]) > 0);
}

function countApprovals(value) {
  if (value === null || value === undefined || value === '' || value === false) return 0;
  if (typeof value === 'number') return Math.max(0, value);
  if (Array.isArray(value)) return sum(value.map(countApprovals));
  if (typeof value === 'object') {
    if ('value' in value) return countApprovals(value.value);
    if ('count' in value) return countApprovals(value.count);
    return Object.keys(value).length ? 1 : 0;
  }
  const text = normalizeFieldName(value).trim();
  return ['0', 'nenhum', 'nenhuma', 'nao', 'false', 'n/a'].includes(text) ? 0 : 1;
}

function wasReviewed(issue, peopleFields = {}) {
  return isApproved(issue, peopleFields) || rejectionCount(issue, peopleFields) > 0;
}

function isDone(issue) {
  return DONE_CATEGORIES.has(statusKey(issue));
}

function isInProgress(issue) {
  return statusKey(issue) === 'indeterminate';
}

function isBlocked(issue) {
  return BLOCKED_STATUS.has(statusName(issue).trim().toLowerCase());
}

function inPeriod(started, startDate, endDate) {
  if (!started) return true;
  const day = started.slice(0, 10);
  return (!startDate || day >= startDate) && (!endDate || day <= endDate);
}

function parseDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function toDatetimeLocal(value) {
  return value ? value.slice(0, 16) : '';
}

function formatStarted(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    const withSeconds = value.length === 16 ? `${value}:00` : value;
    return `${withSeconds}.000+0000`;
  }
  return date.toISOString().replace('Z', '+0000');
}

function plainText(document) {
  if (!document) return '';
  if (typeof document === 'string') return document;
  const parts = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'text') parts.push(node.text || '');
    if (node.content) walk(node.content);
  };
  walk(document);
  return parts.join(' ');
}

function groupBy(items, getter) {
  return items.reduce((acc, item) => {
    const key = getter(item);
    acc[key] ||= [];
    acc[key].push(item);
    return acc;
  }, {});
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

export const handler = resolver.getDefinitions();
