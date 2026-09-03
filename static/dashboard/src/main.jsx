import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { invoke } from '@forge/bridge';
import './styles.css';

const today = new Date();
const iso = (date) => date.toISOString().slice(0, 10);
const startOfMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
const EXPORT_FIELDS = [
  { key: 'key', label: 'Chave', value: (row) => row.card },
  { key: 'summary', label: 'Resumo', value: (row) => row.summary },
  { key: 'status', label: 'Status', value: (row) => row.status },
  { key: 'categories', label: 'Categorias', value: (row) => row.categories },
  { key: 'assignee', label: 'Responsavel', value: (row) => row.assignee },
  { key: 'rejection', label: 'Reprovacao', value: (row) => row.rejection },
  { key: 'qa', label: 'QA', value: (row) => row.qa },
  { key: 'project', label: 'Projeto', value: (row) => row.project },
  { key: 'sprint', label: 'Sprint', value: (row) => row.sprint },
  { key: 'name', label: 'Nome', value: (row) => row.name },
  { key: 'hours', label: 'Horas no periodo', value: (row) => row.hours },
  { key: 'dev', label: 'Dev', value: (row) => row.dev },
  { key: 'reviewResult', label: 'Resultado QA', value: (row) => row.reviewResult },
  { key: 'storyPoints', label: 'Story points', value: (row) => row.storyPoints },
  { key: 'updated', label: 'Atualizado em', value: (row) => row.updated }
];
const DEFAULT_EXPORT_FIELDS = ['key', 'summary', 'status', 'categories', 'assignee', 'rejection', 'qa', 'project', 'sprint'];

function App() {
  const [theme, setTheme] = useState(() => window.localStorage.getItem('teamReportsTheme') || 'light');
  const [filters, setFilters] = useState({
    boardId: '',
    sprintId: '',
    sprintQuery: '',
    status: '',
    jql: 'updated >= -30d ORDER BY updated DESC',
    startDate: startOfMonth,
    endDate: iso(today),
    accountIds: []
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [peopleExpanded, setPeopleExpanded] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  const [advancedFilters, setAdvancedFilters] = useState(false);
  const [extraPeople, setExtraPeople] = useState([]);
  const [userSearch, setUserSearch] = useState({ open: false, query: '', loading: false, results: [] });
  const [activeTab, setActiveTab] = useState('indicators');
  const [exportFields, setExportFields] = useState(DEFAULT_EXPORT_FIELDS);

  async function load(nextFilters = filters) {
    setLoading(true);
    setError('');
    try {
      const result = await invoke('getDashboardData', nextFilters);
      const accountIds = nextFilters.accountIds.length
        ? nextFilters.accountIds
        : result.collaborators.slice(0, 1).map((person) => person.accountId);
      const mergedFilters = { ...nextFilters, accountIds };
      setFilters(mergedFilters);
      setData(result);
    } catch (err) {
      setError(err.message || 'Erro ao carregar dados do Jira.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('teamReportsTheme', theme);
  }, [theme]);

  const selectedReports = useMemo(() => {
    if (!data) return [];
    const selected = filters.accountIds.length
      ? filters.accountIds
      : data.collaborators.slice(0, 1).map((person) => person.accountId);
    return selected
      .map((accountId) => data.reports.find((report) => report.accountId === accountId))
      .filter(Boolean);
  }, [data, filters.accountIds]);

  const primaryReport = selectedReports[0];
  const boardOptions = (data?.boards || []).filter((board) => board.source !== 'project');
  const projectOptions = (data?.boards || []).filter((board) => board.source === 'project');
  const sprintOptions = data?.sprints || [];
  const activeSprints = sprintOptions.filter((sprint) => sprint.state === 'active');
  const futureSprints = sprintOptions.filter((sprint) => sprint.state === 'future');
  const closedSprints = sprintOptions.filter((sprint) => !['active', 'future'].includes(sprint.state));
  const ranking = [...selectedReports].sort((a, b) => {
    if (b.metrics.storyPoints !== a.metrics.storyPoints) return b.metrics.storyPoints - a.metrics.storyPoints;
    return b.metrics.hours - a.metrics.hours;
  });
  const allCollaborators = mergePeople(data?.collaborators || [], extraPeople);

  function updateFilter(name, value) {
    setFilters((current) => ({
      ...current,
      [name]: value,
      ...(name === 'boardId' ? { sprintId: '', sprintQuery: '' } : {}),
      ...(name === 'sprintQuery' ? { sprintId: '' } : {})
    }));
  }

  function togglePerson(accountId) {
    setFilters((current) => {
      const exists = current.accountIds.includes(accountId);
      const nextFilters = {
        ...current,
        accountIds: exists
          ? current.accountIds.filter((value) => value !== accountId)
          : [...current.accountIds, accountId]
      };
      load(nextFilters);
      return nextFilters;
    });
  }

  function applyAndSet(name, value) {
    const nextFilters = {
      ...filters,
      [name]: value,
      ...(name === 'boardId' ? { sprintId: '', sprintQuery: '' } : {}),
      ...(name === 'sprintId' ? { sprintQuery: '' } : {})
    };
    setFilters(nextFilters);
    load(nextFilters);
  }

  async function saveWorklog(values) {
    setError('');
    try {
      if (values.worklogId) {
        await invoke('updateWorklog', values);
      } else {
        await invoke('createWorklog', values);
      }
      setModal(null);
      await load(filters);
    } catch (err) {
      setError(err.message || 'Nao foi possivel salvar o apontamento.');
    }
  }

  async function deleteWorklog(values) {
    setError('');
    try {
      await invoke('deleteWorklog', values);
      setModal(null);
      await load(filters);
    } catch (err) {
      setError(err.message || 'Nao foi possivel excluir o apontamento.');
    }
  }

  async function searchUsers(query) {
    setUserSearch((current) => ({ ...current, query, loading: true }));
    try {
      const results = await invoke('searchUsers', { query });
      setUserSearch((current) => ({ ...current, results, loading: false }));
    } catch (err) {
      setError(err.message || 'Nao foi possivel pesquisar usuarios.');
      setUserSearch((current) => ({ ...current, loading: false }));
    }
  }

  function addPerson(person) {
    setExtraPeople((current) => mergePeople(current, [person]));
    if (!filters.accountIds.includes(person.accountId)) {
      const nextFilters = { ...filters, accountIds: [...filters.accountIds, person.accountId] };
      setFilters(nextFilters);
      load(nextFilters);
    }
    setPeopleExpanded(true);
  }

  function openUserSearch() {
    setUserSearch({ open: true, query: '', loading: true, results: [] });
    searchUsers('');
  }

  return (
    <main className="app">
      {loading && <LoadingOverlay />}
      <header className="page-header">
        <div className="brand-block">
          <div className="logo-mark" aria-hidden="true">OT</div>
          <div>
            <h1>Omni Team Reports</h1>
            <p>Cards, horas, status e story points do Jira em uma visão operacional.</p>
          </div>
        </div>
        <div className="header-actions">
          <button className="icon-button primary" onClick={() => load(filters)} disabled={loading} title="Atualizar" aria-label="Atualizar">
            <RefreshIcon />
          </button>
          <button className="icon-button ghost" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} title={theme === 'light' ? 'Tema escuro' : 'Tema claro'} aria-label={theme === 'light' ? 'Tema escuro' : 'Tema claro'}>
            {theme === 'light' ? <MoonIcon /> : <SunIcon />}
          </button>
        </div>
      </header>

      {error && <div className="alert">{error}</div>}

      <div className={`dashboard-shell ${activeTab === 'management' ? 'management-mode' : ''}`}>
        <aside className="sidebar-filter">
          {activeTab !== 'management' && <section className={`people ${peopleExpanded ? 'expanded' : ''}`}>
            <div className="side-title">
              <div className='icon-title-people'>
                <UsersIcon />
                <h2>Colaboradores</h2>
              </div>
              <button className="icon-button primary" onClick={openUserSearch} title="Adicionar colaborador" aria-label="Adicionar colaborador"><PlusIcon /></button>
            </div>
            <div className="people-grid">
              {allCollaborators.slice(0, peopleExpanded ? allCollaborators.length : 2).map((person) => (
                <label key={person.accountId} className="person-check">
                  <input
                    type="checkbox"
                    checked={filters.accountIds.includes(person.accountId)}
                    onChange={() => togglePerson(person.accountId)}
                  />
                  <Avatar person={person} />
                  <span>{person.name}</span>
                </label>
              ))}
            </div>
            <div className="people-actions">
              {allCollaborators.length > 2 && (
                <button className="ghost compact-button" onClick={() => setPeopleExpanded((value) => !value)}>
                  {peopleExpanded ? 'Recolher' : `Ver ${allCollaborators.length - 2} mais`}
                </button>
              )}
            </div>
          </section>}

          {activeTab === 'management' && <div className="management-scope-note"><GaugeIcon /><div><strong>Visao gerencial</strong><span>Todos os colaboradores do escopo sao incluidos automaticamente.</span></div></div>}

          <section className="filters">
            <div className="side-title">
              <div className='side-title-card'>
                <FilterIcon />
                <h2>Filtros</h2>
              </div>
              <button className="collapse-button" onClick={() => setFiltersExpanded((value) => !value)} aria-expanded={filtersExpanded}>
                {filtersExpanded ? 'Recolher' : 'Expandir'} <ChevronIcon down={!filtersExpanded} />
              </button>
            </div>

            {filtersExpanded && <div className='filters-body'>
              <label>
                Quadro ou espaco
                <select value={filters.boardId} onChange={(event) => applyAndSet('boardId', event.target.value)}>
                  <option value="">Todos pelo JQL</option>
                  <optgroup label="Quadros">
                    {boardOptions.map((board) => (
                      <option key={board.id} value={board.id}>{board.name} ({board.type || 'board'})</option>
                    ))}
                  </optgroup>
                  <optgroup label="Espacos">
                    {projectOptions.map((board) => (
                      <option key={board.id} value={board.id}>{board.name} (espaco)</option>
                    ))}
                  </optgroup>
                </select>
              </label>
              <label>
                Sprint
                <select value={filters.sprintId} onChange={(event) => applyAndSet('sprintId', event.target.value)} disabled={!sprintOptions.length}>
                  <option value="">{sprintOptions.length ? 'Todas as sprints' : 'Nenhuma sprint encontrada'}</option>
                  {activeSprints.length > 0 && (
                    <optgroup label="Ativas">
                      {activeSprints.map((sprint) => (
                        <option key={sprintOptionKey(sprint)} value={sprintValue(sprint)}>{sprintLabel(sprint)}</option>
                      ))}
                    </optgroup>
                  )}
                  {futureSprints.length > 0 && (
                    <optgroup label="Futuras">
                      {futureSprints.map((sprint) => (
                        <option key={sprintOptionKey(sprint)} value={sprintValue(sprint)}>{sprintLabel(sprint)}</option>
                      ))}
                    </optgroup>
                  )}
                  {closedSprints.length > 0 && (
                    <optgroup label="Fechadas e descobertas">
                      {closedSprints.map((sprint) => (
                        <option key={sprintOptionKey(sprint)} value={sprintValue(sprint)}>{sprintLabel(sprint)}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <small className="field-help">{sprintOptions.length ? `${sprintOptions.length} sprint(s) disponiveis neste escopo` : 'Selecione um quadro Scrum ou use a busca avancada por nome/ID.'}</small>
              </label>
              <label>
                Status
                <select value={filters.status} onChange={(event) => applyAndSet('status', event.target.value)}>
                  <option value="">Todos</option>
                  {statusOptions(data).map((status) => (
                    <option key={status} value={status}>{status}</option>
                  ))}
                </select>
              </label>
              <div className="date-row">
                <label>
                  Inicio
                  <input type="date" value={filters.startDate} onChange={(event) => updateFilter('startDate', event.target.value)} />
                </label>
                <label>
                  Fim
                  <input type="date" value={filters.endDate} onChange={(event) => updateFilter('endDate', event.target.value)} />
                </label>
              </div>
              <button className="advanced-toggle" onClick={() => setAdvancedFilters((value) => !value)} aria-expanded={advancedFilters}>
                Filtros avancados <ChevronIcon down={!advancedFilters} />
              </button>
              {advancedFilters && <div className="advanced-fields">
                <label>
                  Sprint por nome ou ID
                  <input value={filters.sprintQuery} onChange={(event) => updateFilter('sprintQuery', event.target.value)} placeholder="Ex.: Sprint 2 ou 123" />
                </label>
                <label className="jql">
                  JQL
                  <textarea rows="3" value={filters.jql} onChange={(event) => updateFilter('jql', event.target.value)} />
                </label>
              </div>}
            </div>}
            {filtersExpanded && <button className="filter-apply" onClick={() => load(filters)}>
              <FilterIcon />
              <span>Aplicar</span>
            </button>}
          </section>
        </aside>

        <section className="content-stack">
          {primaryReport && (
            <>
              <div className="tabs" role="tablist" aria-label="Visualizacoes do relatorio">
                <button className={activeTab === 'indicators' ? 'tab active' : 'tab'} onClick={() => setActiveTab('indicators')} role="tab" aria-selected={activeTab === 'indicators'}>
                  <ChartIcon />
                  <span>Indicadores</span>
                </button>
                <button className={activeTab === 'management' ? 'tab active' : 'tab'} onClick={() => setActiveTab('management')} role="tab" aria-selected={activeTab === 'management'}>
                  <GaugeIcon />
                  <span>Gestao</span>
                </button>
                <button className={activeTab === 'export' ? 'tab active' : 'tab'} onClick={() => setActiveTab('export')} role="tab" aria-selected={activeTab === 'export'}>
                  <SpreadsheetIcon />
                  <span>Exportar Excel</span>
                </button>
              </div>

              {activeTab === 'indicators' ? (
                <>
                  <MetricsCards report={primaryReport} />
                  <Ranking ranking={ranking} primary={primaryReport} />
                  <Calendar
                    weeks={primaryReport.calendarWeeks}
                    issues={data.issueOptions || []}
                    onAdd={(day) => setModal({ mode: 'add', day, issues: data.issueOptions || [] })}
                    onEdit={(entry) => setModal({ mode: 'edit', entry })}
                  />
                  <CardsByUser reports={selectedReports} statusFilter={filters.status} />
                </>
              ) : activeTab === 'management' ? (
                <ManagementDashboard reports={data.managementReports || data.reports || []} issueOptions={data.issueOptions || []} />
              ) : (
                <ExportPanel
                  reports={selectedReports}
                  issueOptions={data.issueOptions || []}
                  statusFilter={filters.status}
                  fields={exportFields}
                  onFieldsChange={setExportFields}
                />
              )}
            </>
          )}
        </section>
      </div>

      {modal && (
        <WorklogModal
          modal={modal}
          onClose={() => setModal(null)}
          onSave={saveWorklog}
          onDelete={deleteWorklog}
        />
      )}
      {userSearch.open && (
        <UserSearchModal
          state={userSearch}
          onSearch={searchUsers}
          onAdd={addPerson}
          onClose={() => setUserSearch({ open: false, query: '', loading: false, results: [] })}
        />
      )}
    </main>
  );
}

function mergePeople(a, b) {
  const map = new Map();
  [...a, ...b].forEach((person) => {
    if (person?.accountId) map.set(person.accountId, person);
  });
  return [...map.values()].sort((x, y) => x.name.localeCompare(y.name));
}

function statusOptions(data) {
  const values = new Set();
  data?.reports?.forEach((report) => {
    report.issues.forEach((issue) => values.add(issue.status));
  });
  data?.issueOptions?.forEach((issue) => values.add(issue.status));
  return [...values].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function sprintValue(sprint) {
  return sprint.id || sprint.name;
}

function sprintOptionKey(sprint) {
  return `${sprint.id || sprint.name}-${sprint.boardId || sprint.boardName || 'sprint'}`;
}

function sprintLabel(sprint) {
  const details = [
    sprint.state || 'sprint',
    sprint.boardName ? `quadro: ${sprint.boardName}` : '',
    sprint.startDate ? sprint.startDate.slice(0, 10) : ''
  ].filter(Boolean);
  return `${sprint.name || sprint.id} (${details.join(' - ')})`;
}

function LoadingOverlay() {
  return (
    <div className="loading-overlay">
      <div className="loader-card">
        <div className="spinner" />
        <div>
          <strong>Consultando Jira</strong>
          <span>Buscando cards, sprints e apontamentos em tempo real.</span>
        </div>
      </div>
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5" /><path d="M18.4 9A7 7 0 0 0 6.6 6.1L4 8.5M5.6 15A7 7 0 0 0 17.4 17.9L20 15.5" /></svg>
  );
}

function MoonIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 14.5A8.5 8.5 0 0 1 9.5 3a7 7 0 1 0 11.5 11.5Z" /></svg>;
}

function SunIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
}

function FilterIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18M7 12h10M10 19h4" /></svg>;
}

function UsersIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function ChartIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-7" /></svg>;
}

function SpreadsheetIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4Z" /><path d="M4 10h16M4 15h16M10 4v16M15 4v16" /></svg>;
}

function DownloadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>;
}

function EditIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
}

function ChevronIcon({ down = false }) {
  return <svg className={down ? '' : 'chevron-up'} viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;
}

function CalendarIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></svg>;
}

function GaugeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14a8 8 0 1 1 16 0" /><path d="m12 14 4-4" /><path d="M5 19h14" /></svg>;
}

function MetricsCards({ report }) {
  const metrics = report.metrics;
  return (
    <section className="metrics">
      <Metric title="Cards" value={metrics.totalCards} />
      <Metric title="Cards no periodo" value={metrics.workedCards} />
      <Metric title="Story points" value={metrics.storyPoints} />
      <Metric title="SP no periodo" value={metrics.workedStoryPoints} />
      <Metric title="Horas" value={metrics.hours} />
      <Metric title="Aprovados" value={metrics.approved} />
      <Metric title="Reprovados" value={metrics.reproved} />
      <Metric title="Impedidos" value={metrics.blocked} />
    </section>
  );
}

function Metric({ title, value }) {
  return <div className="metric"><span>{title}</span><strong>{value}</strong></div>;
}

function Ranking({ ranking, primary }) {
  const generalTotal = ranking.reduce((acc, report) => ({
    cards: acc.cards + report.metrics.totalCards,
    storyPoints: acc.storyPoints + report.metrics.storyPoints,
    hours: acc.hours + report.metrics.hours,
    approved: acc.approved + report.metrics.approved,
    reproved: acc.reproved + report.metrics.reproved
  }), { cards: 0, storyPoints: 0, hours: 0, approved: 0, reproved: 0 });

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Ranking e totais</h2>
        {ranking[0] && <span>1o: {ranking[0].name}</span>}
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th><th>Colaborador</th><th>Cards</th><th>SP</th><th>Horas</th><th>Aprovados</th><th>Reprovados</th>
          </tr>
        </thead>
        <tbody>
          {ranking.map((report, index) => (
            <tr key={report.accountId} className={report.accountId === primary.accountId ? 'selected-row' : ''}>
              <td>{index + 1}</td>
              <td><UserLabel person={report} /></td>
              <td>{report.metrics.totalCards}</td>
              <td>{report.metrics.storyPoints}</td>
              <td>{report.metrics.hours}</td>
              <td>{report.metrics.approved}</td>
              <td>{report.metrics.reproved}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><th colSpan="2">Meu total</th><th>{primary.metrics.totalCards}</th><th>{primary.metrics.storyPoints}</th><th>{primary.metrics.hours}</th><th>{primary.metrics.approved}</th><th>{primary.metrics.reproved}</th></tr>
          <tr><th colSpan="2">Total geral</th><th>{generalTotal.cards}</th><th>{generalTotal.storyPoints}</th><th>{Math.round(generalTotal.hours * 100) / 100}</th><th>{generalTotal.approved}</th><th>{generalTotal.reproved}</th></tr>
        </tfoot>
      </table>
    </section>
  );
}

function UserLabel({ person }) {
  return <span className="user-label"><Avatar person={person} /><span>{person.name}</span></span>;
}

function Avatar({ person }) {
  const initials = initialsFor(person.name);
  if (person.avatarUrl) {
    return <img className="avatar" src={person.avatarUrl} alt="" />;
  }
  return <span className="avatar avatar-fallback">{initials}</span>;
}

function initialsFor(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}

function ReviewLists({ report }) {
  return (
    <section className="review-grid">
      <IssueList title="Aprovados" issues={report.approvedIssues} tone="success" />
      <IssueList title="Reprovados" issues={report.reprovedIssues} tone="danger" />
    </section>
  );
}

function IssueList({ title, issues, tone }) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      <table>
        <thead><tr><th>Key</th><th>Resumo</th><th>Status</th><th>SP</th></tr></thead>
        <tbody>
          {issues.length ? issues.map((issue) => (
            <tr key={issue.key}>
              <td>{issue.key}</td><td>{issue.summary}</td><td><span className={`badge ${tone}`}>{issue.status}</span></td><td>{issue.storyPoints}</td>
            </tr>
          )) : <tr><td colSpan="4">Nenhum card.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Calendar({ weeks, issues, onAdd, onEdit }) {
  const [detailDay, setDetailDay] = useState(null);
  const [weekOpen, setWeekOpen] = useState(false);
  const days = weeks.flat();
  const productiveDays = days.filter((day) => day.inPeriod);
  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>Calendario de trabalho</h2>
          <p className="muted-text">Dias em lista vertical para bater o olho no que foi feito e nas horas do dia.</p>
        </div>
        <button className="ghost calendar-open" onClick={() => setWeekOpen(true)}><CalendarIcon /> Visualizar por semana</button>
      </div>
      <div className="workday-list" aria-label="Calendario em colunas por dia">
        {productiveDays.map((day) => (
          <article className={`workday ${day.hours > 0 ? 'has-work' : ''}`} key={day.date}>
            <div className="workday-date">
              <strong>{day.label}</strong>
              <span>{weekdayName(day.date)}</span>
            </div>
            <div className="workday-body">
              <div className="workday-total">
                <span>{day.hours} h</span>
                {issues.length > 0 && <button className="icon-button primary" onClick={() => onAdd(day)} title="Adicionar horas" aria-label="Adicionar horas"><PlusIcon /></button>}
              </div>
              <div className="workday-entries">
                {day.entries.length ? day.entries.map((entry) => (
                  <div className={`entry ${statusClass(entry.status)}`} key={entry.id}>
                    <div className="entry-main">
                      <strong>{entry.issue}</strong>
                      <span>{entry.hours}h</span>
                    </div>
                    <small>{entry.summary}</small>
                    <div className="entry-actions">
                      <span className={`badge ${statusClass(entry.status)}`}>{entry.status}</span>
                      <button className="icon-button ghost" onClick={() => onEdit(entry)} title="Editar" aria-label="Editar"><EditIcon /></button>
                    </div>
                  </div>
                )) : (
                  <div className="empty-day">Nenhum apontamento registrado.</div>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
      {detailDay && (
        createPortal(<DayDetailsModal day={detailDay} onClose={() => setDetailDay(null)} onEdit={onEdit} />, document.body)
      )}
      {weekOpen && createPortal(<WeekCalendarModal weeks={weeks} issues={issues} onClose={() => setWeekOpen(false)} onAdd={onAdd} onEdit={onEdit} />, document.body)}
    </section>
  );
}

function WeekCalendarModal({ weeks, issues, onClose, onAdd, onEdit }) {
  const firstUsefulWeek = Math.max(0, weeks.findIndex((week) => week.some((day) => day.inPeriod)));
  const [weekIndex, setWeekIndex] = useState(firstUsefulWeek);
  const week = weeks[weekIndex] || [];
  const total = roundNumber(week.reduce((sum, day) => sum + Number(day.hours || 0), 0));
  const range = week.length ? `${week[0].label} a ${week[week.length - 1].label}` : '';

  return (
    <div className="modal-backdrop">
      <div className="modal week-modal" role="dialog" aria-modal="true" aria-label="Calendario semanal">
        <div className="modal-head">
          <div><h2>Semana de trabalho</h2><p>{range} · {total} h registradas</p></div>
          <button className="icon-button ghost" onClick={onClose} aria-label="Fechar">×</button>
        </div>
        <div className="week-nav">
          <button className="ghost" disabled={weekIndex === 0} onClick={() => setWeekIndex((value) => value - 1)}>← Anterior</button>
          <strong>Semana {weekIndex + 1} de {weeks.length}</strong>
          <button className="ghost" disabled={weekIndex >= weeks.length - 1} onClick={() => setWeekIndex((value) => value + 1)}>Proxima →</button>
        </div>
        <div className="week-grid">
          {week.map((day) => (
            <article className={`week-day ${!day.inPeriod ? 'outside-period' : ''}`} key={day.date}>
              <header><div><strong>{weekdayName(day.date)}</strong><span>{day.label}</span></div><b>{day.hours}h</b></header>
              <div className="week-day-entries">
                {day.entries.map((entry) => (
                  <button type="button" className={`week-entry ${statusClass(entry.status)}`} key={entry.id} onClick={() => onEdit(entry)}>
                    <span><strong>{entry.issue}</strong><b>{entry.hours}h</b></span>
                    <small>{entry.summary}</small>
                  </button>
                ))}
                {!day.entries.length && <span className="empty-week-day">Sem horas</span>}
              </div>
              {day.inPeriod && issues.length > 0 && <button className="add-day ghost" onClick={() => onAdd(day)}><PlusIcon /> Apontar</button>}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

function DayDetailsModal({ day, onClose, onEdit }) {
  return (
    <div className="modal-backdrop">
      <div className="modal day-modal">
        <div className="modal-head">
          <div>
            <h2>{day.label}</h2>
            <p>{day.hours} h registradas</p>
          </div>
          <button className="icon-button ghost" onClick={onClose} aria-label="Fechar">×</button>
        </div>
        <div className="day-detail-list">
          {day.entries.map((entry) => (
            <div className={`entry ${statusClass(entry.status)}`} key={entry.id}>
              <div className="entry-main"><strong>{entry.issue}</strong><span>{entry.hours}h</span></div>
              <small>{entry.summary}</small>
              <div className="entry-actions">
                <span className={`badge ${statusClass(entry.status)}`}>{entry.status}</span>
                <button className="icon-button ghost" onClick={() => onEdit(entry)} title="Editar"><EditIcon /></button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function UserSearchModal({ state, onSearch, onAdd, onClose }) {
  return (
    <div className="modal-backdrop">
      <div className="modal user-search-modal">
        <div className="modal-head">
          <div>
            <h2>Adicionar colaborador</h2>
            <p>Pesquise pelo nome para incluir na comparação.</p>
          </div>
          <button className="icon-button ghost" onClick={onClose} aria-label="Fechar">×</button>
        </div>
        <input
          autoFocus
          placeholder="Digite um nome"
          value={state.query}
          onChange={(event) => onSearch(event.target.value)}
        />
        <div className="user-results">
          {state.loading && <div className="empty-day">Pesquisando...</div>}
          {!state.loading && state.results.map((person) => (
            <button className="user-result" key={person.accountId} onClick={() => onAdd(person)}>
              <UserLabel person={person} />
              <PlusIcon />
            </button>
          ))}
          {!state.loading && state.query && !state.results.length && <div className="empty-day">Nenhum usuario encontrado.</div>}
        </div>
      </div>
    </div>
  );
}

function weekdayName(date) {
  return new Date(`${date}T00:00:00`).toLocaleDateString('pt-BR', { weekday: 'short' });
}

function statusClass(status = '') {
  const value = status.toLowerCase();
  if (value.includes('concl') || value.includes('done') || value.includes('aprov') || value.includes('approved')) return 'status-done';
  if (value.includes('reprov') || value.includes('reject') || value.includes('recus')) return 'status-rejected';
  if (value.includes('imped') || value.includes('block')) return 'status-blocked';
  if (value.includes('andamento') || value.includes('progress')) return 'status-progress';
  return 'status-neutral';
}

function CardsByUser({ reports, statusFilter }) {
  const [groupBy, setGroupBy] = useState('person');
  const visibleIssues = reports.flatMap((report) => filteredIssues(report.issues, statusFilter).map((issue) => ({ ...issue, owner: report })));
  const statusGroups = Object.entries(visibleIssues.reduce((groups, issue) => {
    const key = issue.status || 'Sem status';
    (groups[key] ||= []).push(issue);
    return groups;
  }, {})).sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="panel">
      <div className="panel-title cards-title">
        <div><h2>Cards por status e colaborador</h2><p className="muted-text">Expanda somente os grupos que deseja analisar.</p></div>
        <div className="segmented">
          <button className={groupBy === 'person' ? 'active' : ''} onClick={() => setGroupBy('person')}>Colaborador</button>
          <button className={groupBy === 'status' ? 'active' : ''} onClick={() => setGroupBy('status')}>Status</button>
        </div>
      </div>
      {groupBy === 'person' ? reports.map((report, index) => (
        <details key={report.accountId} open={index === 0}>
          <summary>
            <UserLabel person={report} />
            <span>{filteredIssues(report.issues, statusFilter).length} cards - {report.metrics.storyPoints} SP - {report.metrics.hours} h</span>
          </summary>
          <div className="cards-table-scroll"><table className="cards-table">
            <thead><tr><th>Status</th><th>Resultado</th><th>Key</th><th>Sprint</th><th>Resumo</th><th>SP</th><th>Horas</th></tr></thead>
            <tbody>
              {filteredIssues(report.issues, statusFilter).map((issue) => (
                <tr key={issue.key}>
                  <td className="status-cell"><span className={`badge ${statusClass(issue.status)}`}>{issue.status}</span></td>
                  <td className="result-cell">{issue.reviewResult ? <span className={`badge ${issue.reviewResult === 'Aprovado' ? 'success' : 'danger'}`}>{issue.reviewResult}</span> : '-'}</td>
                  <td className="issue-key">{issue.key}</td>
                  <td className="sprint-cell" title={issue.sprint || ''}>{issue.sprint || '-'}</td>
                  <td className="summary-cell" title={issue.summary}>{issue.summary}</td>
                  <td className="sp-cell">{issue.storyPoints}</td>
                  <td className="hours-cell">{issueHours(report.worklogs, issue.key)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </details>
      )) : statusGroups.map(([status, issues], index) => (
        <details key={status} open={index === 0}>
          <summary>
            <span className={`badge ${statusClass(status)}`}>{status}</span>
            <span>{issues.length} cards · {roundNumber(issues.reduce((sum, issue) => sum + Number(issue.storyPoints || 0), 0))} SP</span>
          </summary>
          <div className="cards-table-scroll"><table className="cards-table status-group-table">
            <thead><tr><th>Colaborador</th><th>Key</th><th>Sprint</th><th>Resumo</th><th>SP</th><th>Horas</th></tr></thead>
            <tbody>{issues.map((issue) => (
              <tr key={`${issue.owner.accountId}-${issue.key}`}>
                <td><UserLabel person={issue.owner} /></td><td className="issue-key">{issue.key}</td><td className="sprint-cell" title={issue.sprint || ''}>{issue.sprint || '-'}</td><td className="summary-cell" title={issue.summary}>{issue.summary}</td><td>{issue.storyPoints}</td><td>{issueHours(issue.owner.worklogs, issue.key)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </details>
      ))}
    </section>
  );
}

function ManagementDashboard({ reports, issueOptions }) {
  const [filters, setFilters] = useState({ person: '', status: '', project: '', sprint: '', category: '', search: '' });
  const allRows = useMemo(() => buildExportRows(reports, issueOptions, ''), [reports, issueOptions]);
  const options = (key) => [...new Set(allRows.map((row) => row[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
  const rows = allRows.filter((row) => {
    const text = `${row.card} ${row.summary}`.toLowerCase();
    return (!filters.person || row.name === filters.person)
      && (!filters.status || row.status === filters.status)
      && (!filters.project || row.project === filters.project)
      && (!filters.sprint || row.sprint === filters.sprint)
      && (!filters.category || row.categories === filters.category)
      && (!filters.search || text.includes(filters.search.toLowerCase()));
  });
  const totals = rows.reduce((value, row) => ({ cards: value.cards + 1, sp: value.sp + Number(row.storyPoints || 0), hours: value.hours + Number(row.hours || 0), done: value.done + (statusClass(row.status) === 'status-done' ? 1 : 0) }), { cards: 0, sp: 0, hours: 0, done: 0 });
  const byPerson = aggregateRows(rows, 'name');
  const byStatus = aggregateRows(rows, 'status');
  const maxHours = Math.max(1, ...byPerson.map((item) => item.hours));
  const maxCards = Math.max(1, ...byStatus.map((item) => item.cards));

  function set(name, value) {
    setFilters((current) => ({ ...current, [name]: value }));
  }

  return (
    <div className="management-stack">
      <section className="panel management-filters">
        <div className="panel-title"><div><div className="title-with-count"><h2>Indicadores de gestao</h2><span>{reports.length} colaboradores</span></div><p className="muted-text">A visao inclui todos do escopo, independentemente da selecao lateral.</p></div><button className="ghost compact-button" onClick={() => setFilters({ person: '', status: '', project: '', sprint: '', category: '', search: '' })}>Limpar filtros</button></div>
        <div className="management-filter-grid">
          <label>Colaborador<select value={filters.person} onChange={(event) => set('person', event.target.value)}><option value="">Todos</option>{options('name').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Status<select value={filters.status} onChange={(event) => set('status', event.target.value)}><option value="">Todos</option>{options('status').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Projeto<select value={filters.project} onChange={(event) => set('project', event.target.value)}><option value="">Todos</option>{options('project').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Sprint<select value={filters.sprint} onChange={(event) => set('sprint', event.target.value)}><option value="">Todas</option>{options('sprint').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Categoria<select value={filters.category} onChange={(event) => set('category', event.target.value)}><option value="">Todas</option>{options('categories').map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="management-search">Card especifico<input value={filters.search} onChange={(event) => set('search', event.target.value)} placeholder="Key ou resumo" /></label>
        </div>
      </section>
      <section className="metrics management-metrics">
        <Metric title="Cards filtrados" value={totals.cards} />
        <Metric title="Story points" value={roundNumber(totals.sp)} />
        <Metric title="Horas apontadas" value={roundNumber(totals.hours)} />
        <Metric title="Taxa de conclusao" value={`${totals.cards ? Math.round((totals.done / totals.cards) * 100) : 0}%`} />
        <Metric title="Horas por card" value={totals.cards ? roundNumber(totals.hours / totals.cards) : 0} />
        <Metric title="SP por pessoa" value={byPerson.length ? roundNumber(totals.sp / byPerson.length) : 0} />
      </section>
      <section className="chart-grid">
        <BarChart title="Horas por colaborador" items={byPerson} valueKey="hours" max={maxHours} suffix="h" />
        <BarChart title="Cards por status" items={byStatus} valueKey="cards" max={maxCards} />
      </section>
      <section className="panel comparison-table">
        <div className="panel-title"><h2>Comparativo por colaborador</h2><button className="primary export-button" onClick={() => exportManagementCsv(rows)} disabled={!rows.length}><DownloadIcon /> Exportar CSV</button></div>
        <table><thead><tr><th>Colaborador</th><th>Cards</th><th>SP</th><th>Horas</th><th>Horas/card</th></tr></thead>
          <tbody>{byPerson.map((item) => <tr key={item.label}><td>{item.label}</td><td>{item.cards}</td><td>{item.sp}</td><td>{item.hours}</td><td>{item.cards ? roundNumber(item.hours / item.cards) : 0}</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  );
}

function aggregateRows(rows, key) {
  const values = new Map();
  rows.forEach((row) => {
    const label = row[key] || 'Nao informado';
    const current = values.get(label) || { label, cards: 0, sp: 0, hours: 0 };
    current.cards += 1;
    current.sp = roundNumber(current.sp + Number(row.storyPoints || 0));
    current.hours = roundNumber(current.hours + Number(row.hours || 0));
    values.set(label, current);
  });
  return [...values.values()].sort((a, b) => b.hours - a.hours || b.cards - a.cards);
}

function BarChart({ title, items, valueKey, max, suffix = '' }) {
  return <section className="panel bar-chart"><h2>{title}</h2><div className="bar-list">
    {items.length ? items.slice(0, 12).map((item) => <div className="bar-row" key={item.label}><span title={item.label}>{item.label}</span><div className="bar-track"><i style={{ width: `${Math.max(3, (item[valueKey] / max) * 100)}%` }} /></div><strong>{item[valueKey]}{suffix}</strong></div>) : <div className="empty-day">Nenhum dado para os filtros escolhidos.</div>}
  </div></section>;
}

function exportManagementCsv(rows) {
  const columns = EXPORT_FIELDS.map((field) => ({ ...field, label: field.label }));
  const cells = [columns.map((column) => column.label), ...rows.map((row) => columns.map((column) => column.value(row)))];
  const csv = cells.map((line) => line.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `indicadores-team-reports-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function issueHours(worklogs = [], issueKey) {
  return roundNumber(worklogs
    .filter((worklog) => worklog.issue === issueKey)
    .reduce((total, worklog) => total + Number(worklog.hours || 0), 0));
}

function ExportPanel({ reports, issueOptions, statusFilter, fields, onFieldsChange }) {
  const rows = useMemo(() => buildExportRows(reports, issueOptions, statusFilter), [reports, issueOptions, statusFilter]);
  const selectedFields = EXPORT_FIELDS.filter((field) => fields.includes(field.key));
  const previewRows = rows.slice(0, 8);

  function toggleField(fieldKey) {
    onFieldsChange((current) => current.includes(fieldKey)
      ? current.filter((key) => key !== fieldKey)
      : [...current, fieldKey]);
  }

  function download() {
    exportExcel(rows, selectedFields);
  }

  return (
    <section className="panel export-panel">
      <div className="export-head">
        <div className="export-title">
          <h2>Relatorio para gerencia</h2>
          <span>{rows.length} linhas</span>
          <span>{selectedFields.length} colunas</span>
        </div>
        <div className="export-actions">
          <div className="field-picker-actions">
            <button className="ghost compact-button" onClick={() => onFieldsChange(EXPORT_FIELDS.map((field) => field.key))}>Todos</button>
            <button className="ghost compact-button" onClick={() => onFieldsChange(DEFAULT_EXPORT_FIELDS)}>Modelo</button>
            <button className="ghost compact-button" onClick={() => onFieldsChange([])}>Limpar</button>
          </div>
          <button className="primary export-button" onClick={download} disabled={!rows.length || !selectedFields.length} title="Baixar Excel">
            <DownloadIcon />
            <span>Baixar Excel</span>
          </button>
        </div>
      </div>

      <div className="field-grid">
        {EXPORT_FIELDS.map((field) => (
          <label className="field-check" key={field.key}>
            <input type="checkbox" checked={fields.includes(field.key)} onChange={() => toggleField(field.key)} />
            <span>{field.label}</span>
          </label>
        ))}
      </div>

      <div className="export-preview">
        <table>
          <thead>
            <tr>{selectedFields.map((field) => <th key={field.key}>{field.label}</th>)}</tr>
          </thead>
          <tbody>
            {previewRows.length ? previewRows.map((row) => (
              <tr key={`${row.name}-${row.card}`}>
                {selectedFields.map((field) => <td key={field.key}>{field.value(row) || '-'}</td>)}
              </tr>
            )) : (
              <tr><td colSpan={Math.max(selectedFields.length, 1)}>Nenhum card encontrado para exportar.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function buildExportRows(reports, issueOptions, statusFilter) {
  const issuesByKey = new Map(issueOptions.map((issue) => [issue.key, issue]));
  return reports.flatMap((report) => {
    const worklogHours = groupWorklogHours(report.worklogs || []);
    const reportIssues = new Map();
    (report.issues || []).forEach((issue) => reportIssues.set(issue.key, issue));
    Object.keys(worklogHours).forEach((key) => {
      reportIssues.set(key, reportIssues.get(key) || issuesByKey.get(key) || { key });
    });

    return [...reportIssues.values()]
      .filter((issue) => !statusFilter || issue.status === statusFilter)
      .map((issue) => ({
        name: report.name,
        card: issue.key,
        summary: issue.summary || '',
        hours: roundNumber(worklogHours[issue.key] || 0),
        dev: issue.dev || issue.assignee || '',
        qa: issue.qa || '',
        categories: issue.categories || '',
        status: issue.status || '',
        reviewResult: issue.reviewResult || '',
        rejection: issue.rejection || '',
        assignee: issue.assignee || '',
        project: issue.project || '',
        sprint: issue.sprint || '',
        storyPoints: issue.storyPoints || 0,
        updated: formatDateTime(issue.updated)
      }));
  }).sort((a, b) => a.name.localeCompare(b.name) || a.card.localeCompare(b.card));
}

function groupWorklogHours(worklogs) {
  return worklogs.reduce((acc, worklog) => {
    acc[worklog.issue] = (acc[worklog.issue] || 0) + Number(worklog.hours || 0);
    return acc;
  }, {});
}

function exportExcel(rows, fields) {
  const tableRows = [
    fields.map((field) => `<th>${escapeHtml(field.label)}</th>`).join(''),
    ...rows.map((row) => fields.map((field) => `<td>${escapeHtml(field.value(row))}</td>`).join(''))
  ];
  const html = `<!doctype html><html><head><meta charset="utf-8" /></head><body><table>${tableRows.map((row) => `<tr>${row}</tr>`).join('')}</table></body></html>`;
  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `team-reports-${new Date().toISOString().slice(0, 10)}.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('pt-BR');
}

function roundNumber(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function filteredIssues(issues, statusFilter) {
  if (!statusFilter) return issues;
  return issues.filter((issue) => issue.status === statusFilter);
}

function WorklogModal({ modal, onClose, onSave, onDelete }) {
  const isEdit = modal.mode === 'edit';
  const entry = modal.entry || {};
  const [issueQuery, setIssueQuery] = useState('');
  const [pickerExpanded, setPickerExpanded] = useState(true);
  const [values, setValues] = useState({
    issueKey: entry.issue || modal.issues?.[0]?.key || '',
    worklogId: entry.id || '',
    started: entry.startedRaw || `${modal.day?.date}T09:00`,
    hours: entry.hours || 1,
    comment: entry.comment || ''
  });

  function set(name, value) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  const filteredIssues = (modal.issues || []).filter((issue) => {
    const text = `${issue.key} ${issue.summary} ${issue.status}`.toLowerCase();
    return text.includes(issueQuery.toLowerCase());
  });
  const selectedIssue = (modal.issues || []).find((issue) => issue.key === values.issueKey);
  const issueGroups = Object.entries(filteredIssues.reduce((groups, issue) => {
    (groups[issue.status || 'Sem status'] ||= []).push(issue);
    return groups;
  }, {})).sort(([a], [b]) => a.localeCompare(b));

  function submit(event) {
    event.preventDefault();
    onSave({
      ...values,
      startedUtc: new Date(values.started).toISOString()
    });
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h2>{isEdit ? `Editar ${values.issueKey}` : 'Adicionar horas'}</h2>
        {!isEdit && (
          <div className="issue-picker">
            <button type="button" className="issue-picker-head" onClick={() => setPickerExpanded((value) => !value)} aria-expanded={pickerExpanded}>
              <span><small>Card selecionado</small><strong>{selectedIssue ? `${selectedIssue.key} · ${selectedIssue.summary}` : 'Selecione um card'}</strong></span><ChevronIcon down={!pickerExpanded} />
            </button>
            {pickerExpanded && <div className="issue-picker-body">
              <input autoFocus placeholder="Buscar por key, resumo ou status" value={issueQuery} onChange={(event) => setIssueQuery(event.target.value)} />
              <div className="issue-groups">
                {issueGroups.map(([status, issues]) => <details key={status} open={issueGroups.length <= 4}>
                  <summary><span className={`badge ${statusClass(status)}`}>{status}</span><span>{issues.length}</span></summary>
                  <div className="issue-options">{issues.map((issue) => <button type="button" className={values.issueKey === issue.key ? 'issue-option selected' : 'issue-option'} key={issue.key} onClick={() => { set('issueKey', issue.key); setPickerExpanded(false); }}>
                    <strong>{issue.key}</strong><span>{issue.summary}</span><small>{issue.storyPoints || 0} SP</small>
                  </button>)}</div>
                </details>)}
                {!filteredIssues.length && <div className="empty-day">Nenhum card encontrado.</div>}
              </div>
            </div>}
          </div>
        )}
        <label>Data e hora
          <input type="datetime-local" value={values.started} onChange={(event) => set('started', event.target.value)} required />
        </label>
        <label>Horas
          <input type="number" min="0.1" step="0.1" value={values.hours} onChange={(event) => set('hours', Number(event.target.value))} required />
        </label>
        <label>Comentario
          <textarea value={values.comment} onChange={(event) => set('comment', event.target.value)} />
        </label>
        <div className="modal-actions">
          {isEdit && <button type="button" className="danger-button" onClick={() => onDelete(values)}>Excluir</button>}
          <button type="button" onClick={onClose}>Cancelar</button>
          <button className="primary" type="submit" disabled={!values.issueKey || !values.started || Number(values.hours) <= 0}>Salvar</button>
        </div>
      </form>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
