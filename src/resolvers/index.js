import Resolver from '@forge/resolver';
import api, { assumeTrustedRoute } from '@forge/api';

const resolver = new Resolver();

const DONE_CATEGORIES = new Set(['done']);
const BLOCKED_STATUS = new Set(['blocked', 'bloqueado', 'impedido', 'impedida']);
const APPROVED_STATUS = new Set(['aprovado', 'approved', 'aceito', 'accepted']);
const REPROVED_STATUS = new Set(['reprovado', 'reprovada', 'rejected', 'recusado', 'recusada']);
const STORY_POINTS_FIELDS = ['customfield_10016', 'customfield_10020', 'customfield_10026'];
const BASE_ISSUE_FIELDS = ['summary', 'status', 'assignee', 'project', 'issuetype', 'priority', 'updated', 'labels', 'components', ...STORY_POINTS_FIELDS];
const DEFAULT_JQL = 'updated >= -30d ORDER BY updated DESC';

define('getDashboardData', async ({ payload }) => {
  const filters = normalizeFilters(payload);
  const peopleFields = await getPeopleFields();
  const boardData = await getBoardData();
  const boards = boardData.options;
  const scope = boardScope(filters.boardId);
  const sprintsFromBoards = await getSprintsForScope(scope, boardData.boards);
  const sprintsForScope = scope.type === 'project'
    ? mergeSprints(sprintsFromBoards, await discoverProjectSprints(scope.key, peopleFields))
    : sprintsFromBoards;
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
  const worklogsByIssue = await loadWorklogs(issues);
  const collaborators = getCollaborators(issues, worklogsByIssue);
  const accountIds = filters.accountIds.length
    ? filters.accountIds
    : collaborators.slice(0, 1).map((person) => person.accountId);
  const reports = accountIds.map((accountId) => buildReport({
    accountId,
    name: collaborators.find((person) => person.accountId === accountId)?.name || accountId,
    avatarUrl: collaborators.find((person) => person.accountId === accountId)?.avatarUrl || '',
    issues,
    worklogsByIssue,
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
    peopleFields,
    startDate: filters.startDate,
    endDate: filters.endDate
  }));
  const discoveredSprints = getIssueSprints(issues, peopleFields);
  const sprints = mergeSprints(sprintsForScope, discoveredSprints);

  return { boards, sprints, collaborators, reports, managementReports, issueOptions: issues.map((issue) => normalizeIssue(issue, peopleFields)) };
});

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

define('searchUsers', async ({ payload }) => {
  const rawQuery = String(payload?.query || '').trim();
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

  return getSprintsForBoards(allBoards);
}

async function getSprintsForBoards(boards) {
  const sprintLists = await Promise.all(
    boards.map(async (board) => addBoardNames(await getSprints(board.id), board))
  );
  return mergeSprints(...sprintLists);
}

async function discoverProjectSprints(projectKey, peopleFields) {
  if (!projectKey) return [];
  const issues = [];
  let nextPageToken = '';
  try {
    for (let page = 0; page < 5; page += 1) {
      const body = {
        jql: `project = ${jqlLiteral(projectKey)} AND sprint is not EMPTY ORDER BY updated DESC`,
        maxResults: 100,
        fields: unique([...(peopleFields.sprint || []), 'summary'])
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const data = await jira('/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify(body),
        asUser: true
      });
      issues.push(...(data.issues || []));
      nextPageToken = data.nextPageToken || '';
      if (!nextPageToken || !data.issues?.length) break;
    }
  } catch (error) {
    console.warn(`Nao foi possivel descobrir sprints pelo projeto ${projectKey}: ${error.message}`);
  }
  return getIssueSprints(issues, peopleFields);
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
      category: matchingFieldIds(fields, ['categoria', 'categorias', 'category']),
      project: matchingFieldIds(fields, ['projeto', 'project']),
      sprint: matchingFieldIds(fields, ['sprint'])
    };
  } catch (error) {
    console.warn(`Nao foi possivel listar campos customizados: ${error.message}`);
    return { dev: [], qa: [], category: [], project: [], sprint: [] };
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

async function loadWorklogs(issues) {
  const entries = await Promise.all(issues.map(async (issue) => [issue.key, await getWorklogs(issue.key)]));
  return Object.fromEntries(entries);
}

async function getWorklogs(issueKey) {
  const worklogs = [];
  let startAt = 0;
  while (true) {
    const data = await jira(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog?startAt=${startAt}&maxResults=100`, { asUser: true });
    worklogs.push(...(data.worklogs || []));
    startAt += data.worklogs?.length || 0;
    if (!data.worklogs?.length || startAt >= (data.total || 0)) break;
  }
  return worklogs;
}

function buildReport({ accountId, name, avatarUrl, issues, worklogsByIssue, peopleFields, startDate, endDate }) {
  const userIssues = issues.filter((issue) => assigneeId(issue) === accountId);
  const worklogs = [];
  const touched = new Set();

  for (const issue of issues) {
    for (const worklog of worklogsByIssue[issue.key] || []) {
      if (worklog.author?.accountId !== accountId) continue;
      if (!inPeriod(worklog.started, startDate, endDate)) continue;
      touched.add(issue.key);
      worklogs.push(normalizeWorklog(issue, worklog));
    }
  }

  const touchedIssues = issues.filter((issue) => touched.has(issue.key));
  const normalizedIssues = userIssues.map((issue) => normalizeIssue(issue, peopleFields));
  const approvedIssues = normalizedIssues.filter((issue) => issue.reviewResult === 'Aprovado');
  const reprovedIssues = normalizedIssues.filter((issue) => issue.reviewResult === 'Reprovado');

  return {
    accountId,
    name,
    avatarUrl,
    metrics: {
      totalCards: userIssues.length,
      workedCards: touched.size,
      storyPoints: sum(userIssues.map(storyPoints)),
      workedStoryPoints: sum(touchedIssues.map(storyPoints)),
      hours: round(sum(worklogs.map((row) => row.seconds)) / 3600),
      done: userIssues.filter(isDone).length,
      inProgress: userIssues.filter(isInProgress).length,
      blocked: userIssues.filter(isBlocked).length,
      approved: approvedIssues.length,
      reproved: reprovedIssues.length
    },
    issues: normalizedIssues,
    approvedIssues,
    reprovedIssues,
    worklogs,
    calendarWeeks: buildCalendar(worklogs, startDate, endDate)
  };
}

function getCollaborators(issues, worklogsByIssue) {
  const people = new Map();
  for (const issue of issues) {
    if (assigneeId(issue)) {
      people.set(assigneeId(issue), {
        accountId: assigneeId(issue),
        name: assigneeName(issue) || assigneeId(issue),
        avatarUrl: issue.fields?.assignee?.avatarUrls?.['32x32'] || issue.fields?.assignee?.avatarUrls?.['48x48'] || ''
      });
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
  const result = reviewResult(issue);
  return {
    key: issue.key,
    summary: issue.fields?.summary || '',
    status: statusName(issue),
    reviewResult: result,
    rejection: result === 'Reprovado' ? 1 : '',
    assignee: assigneeName(issue) || 'Sem responsavel',
    dev,
    qa,
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
  const start = payload.startDate || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  return {
    boardId: payload.boardId || '',
    sprintId: payload.sprintId || '',
    sprintQuery: String(payload.sprintQuery || '').trim(),
    jql: payload.jql || DEFAULT_JQL,
    startDate: start,
    endDate: payload.endDate || today.toISOString().slice(0, 10),
    accountIds: Array.isArray(payload.accountIds) ? payload.accountIds : []
  };
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
  return customFieldText(issue, fieldIds);
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

function reviewResult(issue) {
  const name = statusName(issue).trim().toLowerCase();
  if (APPROVED_STATUS.has(name)) return 'Aprovado';
  if (REPROVED_STATUS.has(name)) return 'Reprovado';
  return '';
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
