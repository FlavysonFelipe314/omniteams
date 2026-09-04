import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSelectedReports, dateRangeChunks, emptyCalendarWeeks, filterReportByStatus, mergeDashboardResults, mergeReportsByAccount, totalIssueHours } from '../src/report-utils.js';

function report(accountId, issue, worklog) {
  return {
    accountId,
    name: accountId,
    avatarUrl: '',
    metrics: {
      totalCards: 1,
      workedCards: 1,
      storyPoints: issue.storyPoints,
      workedStoryPoints: issue.storyPoints,
      hours: worklog.hours,
      done: issue.status === 'Concluido' ? 1 : 0,
      inProgress: issue.status === 'Em andamento' ? 1 : 0,
      blocked: 0,
      approved: issue.approved ? 1 : 0,
      reproved: Number(issue.rejection || 0),
      qaCards: 0,
      qaStoryPoints: 0,
      reportedCards: 0
    },
    issues: [issue],
    qaIssues: [],
    reportedIssues: [],
    approvedIssues: [],
    reprovedIssues: [],
    worklogs: [worklog],
    calendarWeeks: [[{
      date: '2026-09-02',
      label: '02/09',
      inPeriod: true,
      hours: worklog.hours,
      entries: [{ ...worklog, id: `${accountId}-worklog`, seconds: worklog.hours * 3600 }]
    }]]
  };
}

test('gera uma semana completa e respeita a data final', () => {
  const weeks = emptyCalendarWeeks('2026-09-01', '2026-09-03');
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0][0].date, '2026-08-31');
  assert.equal(weeks[0][6].date, '2026-09-06');
  assert.equal(weeks[0].filter((day) => day.inPeriod).length, 3);
});

test('consolida indicadores e calendario de varios colaboradores', () => {
  const first = report('ana', { key: 'APP-1', status: 'Concluido', storyPoints: 3, reviewResult: 'Aprovado' }, { issue: 'APP-1', status: 'Concluido', hours: 2 });
  const second = report('bia', { key: 'APP-2', status: 'Em andamento', storyPoints: 5, reviewResult: '' }, { issue: 'APP-2', status: 'Em andamento', hours: 1.5 });
  const result = aggregateSelectedReports([first, second]);

  assert.equal(result.metrics.totalCards, 2);
  assert.equal(result.metrics.storyPoints, 8);
  assert.equal(result.metrics.hours, 3.5);
  assert.equal(result.calendarWeeks[0][0].entries.length, 2);
  assert.equal(result.calendarWeeks[0][0].hours, 3.5);
});

test('aplica status aos cards, totais e calendario ao mesmo tempo', () => {
  const base = report('ana', { key: 'APP-1', status: 'Concluido', storyPoints: 3, reviewResult: 'Aprovado' }, { issue: 'APP-1', status: 'Concluido', hours: 2 });
  base.issues.push({ key: 'APP-2', status: 'Em andamento', storyPoints: 5, reviewResult: '' });
  const result = filterReportByStatus(base, 'Em andamento');

  assert.deepEqual(result.issues.map((issue) => issue.key), ['APP-2']);
  assert.equal(result.metrics.totalCards, 1);
  assert.equal(result.metrics.storyPoints, 5);
  assert.equal(result.metrics.hours, 0);
  assert.equal(result.calendarWeeks[0][0].entries.length, 0);
});

test('relatorio selecionado prevalece sobre a versao gerencial do mesmo usuario', () => {
  const reports = mergeReportsByAccount([{ accountId: 'ana', name: 'antigo' }], [{ accountId: 'ana', name: 'atual' }]);
  assert.equal(reports.get('ana').name, 'atual');
});

test('soma pontos de QA e preserva a quantidade de reprovações', () => {
  const first = report('ana', { key: 'APP-1', status: 'Concluido', storyPoints: 3, approved: true, rejection: 2 }, { issue: 'APP-1', status: 'Concluido', hours: 1 });
  first.qaIssues = [{ key: 'APP-8', status: 'Concluido', storyPoints: 8, approved: true, rejection: 1 }];
  first.metrics = { ...first.metrics, totalCards: 2, storyPoints: 11, approved: 2, reproved: 3, qaCards: 1, qaStoryPoints: 8 };
  first.approvedIssues = first.issues;
  first.reprovedIssues = first.issues;
  const second = report('bia', { key: 'APP-2', status: 'Concluido', storyPoints: 5, approved: true, rejection: 1 }, { issue: 'APP-2', status: 'Concluido', hours: 1 });
  second.qaIssues = [{ key: 'APP-9', status: 'Reprovado', storyPoints: 5, approved: false, rejection: 1 }];
  second.metrics = { ...second.metrics, totalCards: 2, storyPoints: 10, reproved: 2, qaCards: 1, qaStoryPoints: 5 };

  const result = aggregateSelectedReports([first, second]);
  assert.equal(result.metrics.qaCards, 2);
  assert.equal(result.metrics.qaStoryPoints, 13);
  assert.equal(result.metrics.approved, 3);
  assert.equal(result.metrics.reproved, 5);
});

test('filtro contabiliza cards, SP e reprovações do QA no total unico', () => {
  const base = report('ana', { key: 'APP-1', status: 'Concluido', storyPoints: 3, approved: true, rejection: 0 }, { issue: 'APP-1', status: 'Concluido', hours: 1 });
  base.qaIssues = [{ key: 'APP-2', status: 'Concluido', storyPoints: 8, approved: true, rejection: 2 }];

  const result = filterReportByStatus(base, 'Concluido');
  assert.equal(result.metrics.totalCards, 2);
  assert.equal(result.metrics.storyPoints, 11);
  assert.equal(result.metrics.approved, 2);
  assert.equal(result.metrics.reproved, 2);
});

test('filtra e agrega cards relatados por colaborador sem alterar os cards de responsabilidade', () => {
  const first = report('ana', { key: 'APP-1', status: 'Concluido', storyPoints: 3 }, { issue: 'APP-1', status: 'Concluido', hours: 1 });
  first.reportedIssues = [
    { key: 'APP-8', status: 'Concluido', storyPoints: 8 },
    { key: 'APP-9', status: 'Em andamento', storyPoints: 5 }
  ];
  first.metrics.reportedCards = 2;
  const second = report('bia', { key: 'APP-2', status: 'Concluido', storyPoints: 2 }, { issue: 'APP-2', status: 'Concluido', hours: 1 });
  second.reportedIssues = [{ key: 'APP-10', status: 'Concluido', storyPoints: 1 }];
  second.metrics.reportedCards = 1;

  const filtered = filterReportByStatus(first, 'Concluido');
  assert.equal(filtered.metrics.reportedCards, 1);
  assert.deepEqual(filtered.reportedIssues.map((issue) => issue.key), ['APP-8']);
  assert.equal(filtered.metrics.totalCards, 1);

  const aggregate = aggregateSelectedReports([first, second]);
  assert.equal(aggregate.metrics.reportedCards, 3);
  assert.equal(aggregate.reportedIssues.length, 3);
});

test('usa o total de horas do card mesmo quando o apontamento esta fora do periodo', () => {
  const issue = { key: 'APP-1', totalHours: 3.5 };
  const periodWorklogs = [{ issue: 'APP-1', hours: 1 }];

  assert.equal(totalIssueHours(issue, periodWorklogs), 3.5);
  assert.equal(totalIssueHours({ key: 'APP-2' }, [{ issue: 'APP-2', hours: 1.25 }]), 1.25);
});

test('divide periodos longos em intervalos contiguos de no maximo 31 dias', () => {
  assert.deepEqual(dateRangeChunks('2026-07-19', '2026-09-04'), [
    { startDate: '2026-07-19', endDate: '2026-08-18' },
    { startDate: '2026-08-19', endDate: '2026-09-04' }
  ]);
});

test('reune respostas particionadas sem perder indicadores ou metadados', () => {
  const firstReport = report('ana', { key: 'APP-1', status: 'Concluido', storyPoints: 3 }, { issue: 'APP-1', status: 'Concluido', hours: 2 });
  const secondReport = report('ana', { key: 'APP-2', status: 'Em andamento', storyPoints: 5 }, { issue: 'APP-2', status: 'Em andamento', hours: 1 });
  const base = {
    boards: [{ id: '1', name: 'Projeto' }],
    sprints: [{ id: '10', boardId: '1', name: 'Sprint 1' }],
    collaborators: [{ accountId: 'ana', name: 'Ana' }],
    scopeCollaboratorIds: ['ana'],
    currentUser: { accountId: 'ana', name: 'Ana' }
  };
  const merged = mergeDashboardResults([
    { ...base, reports: [firstReport], managementReports: [firstReport], issueOptions: firstReport.issues },
    { ...base, boards: [], sprints: [], reports: [secondReport], managementReports: [secondReport], issueOptions: secondReport.issues }
  ]);

  assert.equal(merged.boards.length, 1);
  assert.equal(merged.managementReports.length, 1);
  assert.equal(merged.managementReports[0].metrics.totalCards, 2);
  assert.equal(merged.managementReports[0].metrics.hours, 3);
  assert.deepEqual(merged.issueOptions.map((issue) => issue.key), ['APP-1', 'APP-2']);
  assert.equal(merged.currentUserReport.accountId, 'ana');
});
