function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function roundNumber(value) {
  return Math.round(Number(value || 0) * 100) / 100;
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
