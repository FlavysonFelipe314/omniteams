function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function roundNumber(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function collaboratorIssueHours(issue, periodWorklogs = []) {
  return roundNumber(periodWorklogs
    .filter((worklog) => worklog.issue === issue?.key)
    .reduce((total, worklog) => total + Number(worklog.hours || 0), 0));
}

export function isRetryableInvocationError(error) {
  return /payload size exceeded|maximum allowed payload size|task timed out|function timed out|time(?:d)?\s*out/i
    .test(String(error?.message || error || ''));
}

export function dateRangeChunks(startDate, endDate, maxDays = 31) {
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end || maxDays < 1) {
    return [{ startDate, endDate }];
  }

  const chunks = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ startDate: localDate(cursor), endDate: localDate(chunkEnd) });
    cursor.setTime(chunkEnd.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return chunks;
}

function calendarFromWorklogs(startDate, endDate, worklogs) {
  const entriesByDate = new Map();
  worklogs.forEach((worklog) => {
    if (!entriesByDate.has(worklog.date)) entriesByDate.set(worklog.date, []);
    entriesByDate.get(worklog.date).push(worklog);
  });
  return emptyCalendarWeeks(startDate, endDate).map((week) => week.map((day) => {
    const entries = entriesByDate.get(day.date) || [];
    return {
      ...day,
      entries,
      hours: roundNumber(entries.reduce((total, entry) => total + Number(entry.seconds || Number(entry.hours || 0) * 3600), 0) / 3600)
    };
  }));
}

export function hydrateDashboardResult(result, startDate, endDate) {
  if (!result) return result;
  const issuesByKey = new Map((result.issueOptions || []).map((issue) => [issue.key, issue]));
  const hydrateIssues = (keys, legacyIssues) => Array.isArray(keys)
    ? keys.map((key) => issuesByKey.get(key)).filter(Boolean)
    : (legacyIssues || []);
  const hydrateReport = (report) => {
    const worklogs = (report.worklogs || []).map((worklog) => {
      const issue = issuesByKey.get(worklog.issue) || {};
      return {
        ...worklog,
        summary: worklog.summary ?? issue.summary ?? '',
        status: worklog.status ?? issue.status ?? 'Sem status'
      };
    });
    return {
      ...report,
      issues: hydrateIssues(report.issueKeys, report.issues),
      qaIssues: hydrateIssues(report.qaIssueKeys, report.qaIssues),
      reportedIssues: hydrateIssues(report.reportedIssueKeys, report.reportedIssues),
      approvedIssues: hydrateIssues(report.approvedIssueKeys, report.approvedIssues),
      reprovedIssues: hydrateIssues(report.reprovedIssueKeys, report.reprovedIssues),
      worklogs,
      calendarWeeks: calendarFromWorklogs(startDate, endDate, worklogs)
    };
  };
  const reports = (result.reports || []).map(hydrateReport);
  const managementReports = (result.managementReports || []).map(hydrateReport);
  const currentUserReport = result.currentUser?.accountId
    ? managementReports.find((report) => report.accountId === result.currentUser.accountId) || null
    : result.currentUserReport ? hydrateReport(result.currentUserReport) : null;
  return { ...result, reports, managementReports, currentUserReport };
}

function uniqueBy(items, keyFor) {
  return [...new Map(items.filter(Boolean).map((item) => [keyFor(item), item])).values()];
}

export function mergeAccountReports(reports) {
  if (!reports.length) return null;
  if (reports.length === 1) return reports[0];
  const first = reports[0];
  const issues = uniqueBy(reports.flatMap((report) => report.issues || []), (issue) => issue.key);
  const qaIssues = uniqueBy(reports.flatMap((report) => report.qaIssues || []), (issue) => issue.key);
  const reportedIssues = uniqueBy(reports.flatMap((report) => report.reportedIssues || []), (issue) => issue.key);
  const approvedIssues = uniqueBy(reports.flatMap((report) => report.approvedIssues || []), (issue) => issue.key);
  const reprovedIssues = uniqueBy(reports.flatMap((report) => report.reprovedIssues || []), (issue) => issue.key);
  const worklogs = uniqueBy(reports.flatMap((report) => report.worklogs || []), (worklog) => `${worklog.issue}:${worklog.id || `${worklog.date}:${worklog.startedRaw || ''}:${worklog.hours}:${worklog.comment || ''}`}`);
  const creditedIssues = uniqueBy([...issues, ...qaIssues], (issue) => issue.key);
  const knownIssues = new Map(uniqueBy([...creditedIssues, ...reportedIssues, ...approvedIssues, ...reprovedIssues], (issue) => issue.key).map((issue) => [issue.key, issue]));
  const workedKeys = new Set(worklogs.map((worklog) => worklog.issue));
  const workedStoryPoints = [...workedKeys].reduce((sum, key) => {
    const issuePoints = knownIssues.get(key)?.storyPoints;
    const worklogPoints = worklogs.find((worklog) => worklog.issue === key)?.storyPoints;
    return sum + Number(issuePoints ?? worklogPoints ?? 0);
  }, 0);
  const periodDays = (first.calendarWeeks || []).flat().filter((day) => day.inPeriod);
  const calendarWeeks = periodDays.length
    ? calendarFromWorklogs(periodDays[0].date, periodDays[periodDays.length - 1].date, worklogs)
    : first.calendarWeeks || [];
  return {
    ...first,
    issues,
    qaIssues,
    reportedIssues,
    approvedIssues,
    reprovedIssues,
    worklogs,
    calendarWeeks,
    metrics: {
      totalCards: creditedIssues.length,
      workedCards: workedKeys.size,
      storyPoints: roundNumber(creditedIssues.reduce((sum, issue) => sum + Number(issue.storyPoints || 0), 0)),
      workedStoryPoints: roundNumber(workedStoryPoints),
      hours: roundNumber(worklogs.reduce((sum, worklog) => sum + Number(worklog.hours || Number(worklog.seconds || 0) / 3600), 0)),
      done: creditedIssues.filter((issue) => statusClass(issue.status) === 'status-done').length,
      inProgress: creditedIssues.filter((issue) => statusClass(issue.status) === 'status-progress').length,
      blocked: creditedIssues.filter((issue) => statusClass(issue.status) === 'status-blocked').length,
      approved: approvedIssues.length,
      reproved: reprovedIssues.reduce((sum, issue) => sum + Math.max(1, Number(issue.rejection || 0)), 0),
      qaCards: qaIssues.length,
      qaStoryPoints: roundNumber(qaIssues.reduce((sum, issue) => sum + Number(issue.storyPoints || 0), 0)),
      reportedCards: reportedIssues.length
    }
  };
}

function mergeReportCollections(results, field) {
  const grouped = new Map();
  results.flatMap((result) => result?.[field] || []).forEach((report) => {
    if (!grouped.has(report.accountId)) grouped.set(report.accountId, []);
    grouped.get(report.accountId).push(report);
  });

  return [...grouped.values()].map((reports) => {
    const first = reports[0];
    const merged = mergeAccountReports(reports);
    return { ...merged, accountId: first.accountId, name: first.name, avatarUrl: first.avatarUrl };
  });
}

export function mergeDashboardResults(results) {
  const available = results.filter(Boolean);
  if (!available.length) return null;
  if (available.length === 1) return available[0];

  const first = available[0];
  const managementReports = mergeReportCollections(available, 'managementReports');
  const currentUser = available.find((result) => result.currentUser)?.currentUser || null;
  return {
    ...first,
    boards: uniqueBy(available.flatMap((result) => result.boards || []), (board) => String(board.id || board.value || board.key)),
    sprints: uniqueBy(available.flatMap((result) => result.sprints || []), (sprint) => `${sprint.boardId || ''}:${sprint.id || sprint.name}`),
    collaborators: uniqueBy(available.flatMap((result) => result.collaborators || []), (person) => person.accountId),
    scopeCollaboratorIds: [...new Set(available.flatMap((result) => result.scopeCollaboratorIds || []))],
    reports: mergeReportCollections(available, 'reports'),
    managementReports,
    currentUser,
    currentUserReport: currentUser
      ? managementReports.find((report) => report.accountId === currentUser.accountId) || null
      : null,
    issueOptions: uniqueBy(available.flatMap((result) => result.issueOptions || []), (issue) => issue.key)
  };
}

export function statusClass(status = '') {
  const value = status.toLowerCase();
  if (value.includes('concl') || value.includes('done') || value.includes('aprov') || value.includes('approved')) return 'status-done';
  if (value.includes('reprov') || value.includes('reject') || value.includes('recus')) return 'status-rejected';
  if (value.includes('imped') || value.includes('block')) return 'status-blocked';
  if (value.includes('andamento') || value.includes('progress')) return 'status-progress';
  return 'status-neutral';
}

export function mergeReportsByAccount(...groups) {
  const reports = new Map();
  groups.flat().filter(Boolean).forEach((report) => reports.set(report.accountId, report));
  return reports;
}

export function emptyCalendarWeeks(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const cursor = new Date(start);
  cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
  const last = new Date(end);
  last.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7)));
  const days = [];
  while (cursor <= last) {
    days.push({
      date: localDate(cursor),
      label: cursor.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
      inPeriod: cursor >= start && cursor <= end,
      hours: 0,
      entries: []
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  const weeks = [];
  for (let index = 0; index < days.length; index += 7) weeks.push(days.slice(index, index + 7));
  return weeks;
}

export function filterReportByStatus(report, status) {
  if (!status) return report;
  const issues = (report.issues || []).filter((issue) => issue.status === status);
  const qaIssues = (report.qaIssues || []).filter((issue) => issue.status === status);
  const reportedIssues = (report.reportedIssues || []).filter((issue) => issue.status === status);
  const issueByKey = new Map([...issues, ...qaIssues].map((issue) => [issue.key, issue]));
  const worklogs = (report.worklogs || []).filter((worklog) => worklog.status === status || issueByKey.has(worklog.issue));
  const workedIssueKeys = new Set(worklogs.map((worklog) => worklog.issue));
  const creditedIssues = [...issueByKey.values()];
  const approvedIssues = creditedIssues.filter((issue) => issue.approved || issue.reviewResult === 'Aprovado');
  const reprovedIssues = creditedIssues.filter((issue) => Number(issue.rejection || 0) > 0 || issue.reviewResult === 'Reprovado');
  const calendarWeeks = (report.calendarWeeks || []).map((week) => week.map((day) => {
    const entries = (day.entries || []).filter((entry) => entry.status === status || issueByKey.has(entry.issue));
    return {
      ...day,
      entries,
      hours: roundNumber(entries.reduce((total, entry) => total + Number(entry.seconds || Number(entry.hours || 0) * 3600), 0) / 3600)
    };
  }));
  return {
    ...report,
    issues,
    qaIssues,
    approvedIssues,
    reprovedIssues,
    worklogs,
    calendarWeeks,
    metrics: {
      totalCards: issueByKey.size,
      workedCards: workedIssueKeys.size,
      storyPoints: roundNumber(creditedIssues.reduce((total, issue) => total + Number(issue.storyPoints || 0), 0)),
      workedStoryPoints: roundNumber([...workedIssueKeys].reduce((total, key) => total + Number(issueByKey.get(key)?.storyPoints || 0), 0)),
      hours: roundNumber(worklogs.reduce((total, worklog) => total + Number(worklog.hours || 0), 0)),
      done: creditedIssues.filter((issue) => statusClass(issue.status) === 'status-done').length,
      inProgress: creditedIssues.filter((issue) => statusClass(issue.status) === 'status-progress').length,
      blocked: creditedIssues.filter((issue) => statusClass(issue.status) === 'status-blocked').length,
      approved: approvedIssues.length,
      reproved: reprovedIssues.reduce((total, issue) => total + Math.max(1, Number(issue.rejection || 0)), 0),
      qaCards: qaIssues.length,
      qaStoryPoints: roundNumber(qaIssues.reduce((total, issue) => total + Number(issue.storyPoints || 0), 0)),
      reportedCards: reportedIssues.length
    },
    reportedIssues
  };
}

export function aggregateSelectedReports(reports) {
  if (!reports.length) return null;
  if (reports.length === 1) return reports[0];

  const issues = reports.flatMap((report) => report.issues || []);
  const qaIssues = reports.flatMap((report) => report.qaIssues || []);
  const reportedIssues = reports.flatMap((report) => report.reportedIssues || []);
  const worklogs = reports.flatMap((report) => report.worklogs || []);
  const approvedIssues = reports.flatMap((report) => report.approvedIssues || []);
  const reprovedIssues = reports.flatMap((report) => report.reprovedIssues || []);
  const issueByKey = new Map(issues.map((issue) => [issue.key, issue]));
  const calendarDays = new Map();

  reports.forEach((report) => (report.calendarWeeks || []).flat().forEach((day) => {
    const current = calendarDays.get(day.date) || { ...day, hours: 0, entries: [] };
    current.hours = roundNumber(current.hours + Number(day.hours || 0));
    current.entries.push(...(day.entries || []));
    calendarDays.set(day.date, current);
  }));

  const orderedDays = [...calendarDays.values()].sort((a, b) => a.date.localeCompare(b.date));
  const calendarWeeks = [];
  for (let index = 0; index < orderedDays.length; index += 7) calendarWeeks.push(orderedDays.slice(index, index + 7));

  return {
    accountId: '__selected__',
    name: `${reports.length} colaboradores`,
    avatarUrl: '',
    metrics: {
      totalCards: reports.reduce((total, report) => total + Number(report.metrics.totalCards || 0), 0),
      workedCards: reports.reduce((total, report) => total + Number(report.metrics.workedCards || 0), 0),
      storyPoints: roundNumber(reports.reduce((total, report) => total + Number(report.metrics.storyPoints || 0), 0)),
      workedStoryPoints: roundNumber(reports.reduce((total, report) => total + Number(report.metrics.workedStoryPoints || 0), 0)),
      hours: roundNumber(reports.reduce((total, report) => total + Number(report.metrics.hours || 0), 0)),
      done: reports.reduce((total, report) => total + Number(report.metrics.done || 0), 0),
      inProgress: reports.reduce((total, report) => total + Number(report.metrics.inProgress || 0), 0),
      blocked: reports.reduce((total, report) => total + Number(report.metrics.blocked || 0), 0),
      approved: reports.reduce((total, report) => total + Number(report.metrics.approved || 0), 0),
      reproved: reports.reduce((total, report) => total + Number(report.metrics.reproved || 0), 0),
      qaCards: qaIssues.length,
      qaStoryPoints: roundNumber(qaIssues.reduce((total, issue) => total + Number(issue.storyPoints || 0), 0)),
      reportedCards: reports.reduce((total, report) => total + Number(report.metrics.reportedCards || 0), 0)
    },
    issues: [...issueByKey.values()],
    qaIssues,
    reportedIssues,
    approvedIssues,
    reprovedIssues,
    worklogs,
    calendarWeeks
  };
}
