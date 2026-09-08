import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { invoke, router } from '@forge/bridge';
import './styles.css';
import { aggregateSelectedReports, dateRangeChunks, emptyCalendarWeeks, filterReportByStatus, hydrateDashboardResult, mergeDashboardResults, mergeReportsByAccount, roundNumber, statusClass, totalIssueHours } from './report-utils.js';
import { buildXlsxArchive } from './xlsx-utils.js';
import dashboardPackage from '../package.json';
import SavedReports from './SavedReports.jsx';

const today = new Date();
const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const currentMonday = new Date(today);
currentMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
const currentFriday = new Date(currentMonday);
currentFriday.setDate(currentMonday.getDate() + 4);
const FILTER_STORAGE_KEY = 'teamReportsFiltersV3';
const EXPORT_FIELDS_STORAGE_KEY = 'teamReportsExportFieldsV2';
const MANAGEMENT_FILTER_STORAGE_KEY = 'teamReportsManagementFiltersV2';
const PROFILE_FILTER_STORAGE_KEY = 'teamReportsProfileFiltersV1';
const HIDDEN_PEOPLE_STORAGE_KEY = 'teamReportsHiddenPeopleV1';
const EXPORT_FIELDS = [
  { key: 'key', label: 'Chave', value: (row) => row.card },
  { key: 'summary', label: 'Resumo', value: (row) => row.summary },
  { key: 'status', label: 'Status', value: (row) => row.status },
  { key: 'categories', label: 'Categorias', value: (row) => row.categories },
  { key: 'assignee', label: 'Responsável', value: (row) => row.assignee },
  { key: 'rejection', label: 'Reprovação', value: (row) => row.rejection },
  { key: 'qa', label: 'QA', value: (row) => row.qa },
  { key: 'project', label: 'Projeto', value: (row) => row.project },
  { key: 'sprint', label: 'Sprint', value: (row) => row.sprint },
  { key: 'name', label: 'Nome', value: (row) => row.name },
  { key: 'hours', label: 'Horas no Período', value: (row) => row.hours },
  { key: 'dev', label: 'Dev', value: (row) => row.dev },
  { key: 'reviewResult', label: 'Resultado de QA', value: (row) => row.reviewResult },
  { key: 'storyPoints', label: 'Story Points', value: (row) => row.storyPoints },
  { key: 'updated', label: 'Atualizado em', value: (row) => row.updated }
];
const DEFAULT_EXPORT_FIELDS = ['key', 'summary', 'status', 'categories', 'assignee', 'rejection', 'qa', 'project', 'sprint'];

function inclusiveDays(startDate, endDate) {
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

function isPayloadSizeError(error) {
  return /payload size exceeded|maximum allowed payload size/i.test(String(error?.message || error || ''));
}

async function invokeDashboardChunk(filters, chunk, includeMetadata) {
  try {
    const result = await invoke('getDashboardData', {
      ...filters,
      issueStartDate: chunk.startDate,
      issueEndDate: chunk.endDate,
      includeMetadata
    });
    return hydrateDashboardResult(result, filters.startDate, filters.endDate);
  } catch (error) {
    const days = inclusiveDays(chunk.startDate, chunk.endDate);
    if (!isPayloadSizeError(error) || days <= 1) throw error;
    const smallerChunks = dateRangeChunks(chunk.startDate, chunk.endDate, Math.ceil(days / 2));
    const results = await Promise.all(smallerChunks.map((smallerChunk, index) => (
      invokeDashboardChunk(filters, smallerChunk, includeMetadata && index === 0)
    )));
    return mergeDashboardResults(results);
  }
}

async function mapInBatches(items, batchSize, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    results.push(...await Promise.all(items.slice(index, index + batchSize).map((item, offset) => mapper(item, index + offset))));
  }
  return results;
}

function defaultFilters() {
  return {
    boardId: '',
    sprintId: '',
    sprintQuery: '',
    status: '',
    jql: 'updated >= -30d ORDER BY updated DESC',
    startDate: iso(currentMonday),
    endDate: iso(currentFriday),
    accountIds: []
  };
}

function storedFilters() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(FILTER_STORAGE_KEY) || 'null');
    return saved && typeof saved === 'object'
      ? { ...defaultFilters(), ...saved, accountIds: Array.isArray(saved.accountIds) ? saved.accountIds : [] }
      : defaultFilters();
  } catch {
    return defaultFilters();
  }
}

function storedExportFields() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(EXPORT_FIELDS_STORAGE_KEY) || 'null');
    const valid = Array.isArray(saved) ? saved.filter((key) => EXPORT_FIELDS.some((field) => field.key === key)) : [];
    return valid.length ? [...new Set(valid)] : DEFAULT_EXPORT_FIELDS;
  } catch {
    return DEFAULT_EXPORT_FIELDS;
  }
}

function defaultManagementFilters() {
  return { persons: [], status: '', project: '', sprint: '', category: '', search: '' };
}

function storedManagementFilters() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(MANAGEMENT_FILTER_STORAGE_KEY) || 'null');
    return saved && typeof saved === 'object'
      ? { ...defaultManagementFilters(), ...saved, persons: Array.isArray(saved.persons) ? saved.persons : [] }
      : defaultManagementFilters();
  } catch {
    return defaultManagementFilters();
  }
}

function defaultProfileFilters() {
  return { role: '', status: '', project: '', sprint: '', category: '', search: '', onlyWorked: false };
}

function storedProfileFilters() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PROFILE_FILTER_STORAGE_KEY) || 'null');
    return saved && typeof saved === 'object' ? { ...defaultProfileFilters(), ...saved } : defaultProfileFilters();
  } catch {
    return defaultProfileFilters();
  }
}

function storedHiddenPeople() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(HIDDEN_PEOPLE_STORAGE_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function App() {
  const [theme, setTheme] = useState(() => window.localStorage.getItem('teamReportsTheme') || 'light');
  const [filters, setFilters] = useState(storedFilters);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [peopleExpanded, setPeopleExpanded] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  const [advancedFilters, setAdvancedFilters] = useState(false);
  const [extraPeople, setExtraPeople] = useState([]);
  const [hiddenPeopleIds, setHiddenPeopleIds] = useState(storedHiddenPeople);
  const [userSearch, setUserSearch] = useState({ open: false, query: '', projectKey: '', loading: false, results: [] });
  const [activeTab, setActiveTab] = useState('indicators');
  const [exportFields, setExportFields] = useState(storedExportFields);
  const [managementFilters, setManagementFilters] = useState(storedManagementFilters);
  const [profileFilters, setProfileFilters] = useState(storedProfileFilters);
  const [cardGroupBy, setCardGroupBy] = useState('person');
  const loadRequestRef = useRef(0);
  const userSearchRequestRef = useRef(0);
  const userSearchTimerRef = useRef(null);

  async function load(nextFilters = filters, { selectScopedPeople = false, preserveSelection = false } = {}) {
    const requestId = ++loadRequestRef.current;
    if (nextFilters.startDate && nextFilters.endDate && nextFilters.startDate > nextFilters.endDate) {
      setError('A data final deve ser igual ou posterior a data inicial.');
      setLoading(false);
      return false;
    }
    setLoading(true);
    setError('');
    try {
      const chunks = dateRangeChunks(nextFilters.startDate, nextFilters.endDate);
      const responses = await mapInBatches(chunks, 4, (chunk, index) => (
        invokeDashboardChunk(nextFilters, chunk, index === 0)
      ));
      const result = mergeDashboardResults(responses);
      if (requestId !== loadRequestRef.current) return;
      const defaultAccountIds = result.currentUser?.accountId
        ? [result.currentUser.accountId]
        : result.collaborators.slice(0, 1).map((person) => person.accountId);
      setFilters((current) => {
        if (preserveSelection) return current;
        if (selectScopedPeople) {
          return { ...current, accountIds: (result.scopeCollaboratorIds || []).filter((accountId) => !hiddenPeopleIds.includes(accountId)) };
        }
        return current.accountIds.length ? current : { ...current, accountIds: defaultAccountIds };
      });
      setData(result);
      return true;
    } catch (err) {
      if (requestId !== loadRequestRef.current) return;
      setError(err.message || 'Erro ao carregar dados do Jira.');
      return false;
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('teamReportsTheme', theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
  }, [filters]);

  useEffect(() => {
    window.localStorage.setItem(EXPORT_FIELDS_STORAGE_KEY, JSON.stringify(exportFields));
  }, [exportFields]);

  useEffect(() => {
    window.localStorage.setItem(MANAGEMENT_FILTER_STORAGE_KEY, JSON.stringify(managementFilters));
  }, [managementFilters]);

  useEffect(() => {
    window.localStorage.setItem(PROFILE_FILTER_STORAGE_KEY, JSON.stringify(profileFilters));
  }, [profileFilters]);

  useEffect(() => {
    window.localStorage.setItem(HIDDEN_PEOPLE_STORAGE_KEY, JSON.stringify(hiddenPeopleIds));
  }, [hiddenPeopleIds]);

  useEffect(() => () => window.clearTimeout(userSearchTimerRef.current), []);

  const allCollaborators = useMemo(() => {
    const scopeIds = new Set(data?.scopeCollaboratorIds || []);
    const scopedPeople = (data?.collaborators || []).filter((person) => scopeIds.has(person.accountId));
    return mergePeople(scopedPeople, extraPeople).filter((person) => !hiddenPeopleIds.includes(person.accountId));
  }, [data?.collaborators, data?.scopeCollaboratorIds, extraPeople, hiddenPeopleIds]);

  async function applySavedReport(config) {
    setFilters(config.filters);
    setActiveTab(config.activeTab);
    setManagementFilters(config.managementFilters);
    setProfileFilters(config.profileFilters);
    setCardGroupBy(config.groupBy);
    setExportFields(config.exportFields.filter((key) => EXPORT_FIELDS.some((field) => field.key === key)));
    setExtraPeople(config.people);
    setHiddenPeopleIds((current) => current.filter((id) => !config.filters.accountIds.includes(id)));
    if (!await load(config.filters, { preserveSelection: true })) {
      throw new Error('Os filtros foram restaurados, mas os dados não puderam ser carregados. Tente reaplicar o relatório.');
    }
  }

  const selectedReports = useMemo(() => {
    if (!data) return [];
    const selected = filters.accountIds;
    const availableReports = mergeReportsByAccount(data.managementReports || [], data.reports || []);
    return selected.map((accountId) => {
      const person = allCollaborators.find((item) => item.accountId === accountId);
      const report = availableReports.get(accountId) || emptyReport(person || { accountId, name: accountId }, filters.startDate, filters.endDate);
      const namedReport = person ? { ...report, name: person.name, avatarUrl: person.avatarUrl || report.avatarUrl } : report;
      return filterReportByStatus(namedReport, filters.status);
    });
  }, [data, filters.accountIds, filters.startDate, filters.endDate, filters.status, allCollaborators]);

  const primaryReport = useMemo(() => aggregateSelectedReports(selectedReports), [selectedReports]);
  const profileReport = data?.currentUserReport || (data?.currentUser?.accountId
    ? (data.managementReports || []).find((report) => report.accountId === data.currentUser.accountId)
    : null);
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
      return {
        ...current,
        accountIds: exists
          ? current.accountIds.filter((value) => value !== accountId)
          : [...current.accountIds, accountId]
      };
    });
  }

  function setAllCollaborators(selected) {
    const accountIds = allCollaborators.map((person) => person.accountId);
    setFilters((current) => ({
      ...current,
      accountIds: selected
        ? [...new Set([...current.accountIds, ...accountIds])]
        : current.accountIds.filter((accountId) => !accountIds.includes(accountId))
    }));
  }

  function applyAndSet(name, value) {
    const nextFilters = {
      ...filters,
      [name]: value,
      ...(name === 'boardId' ? { sprintId: '', sprintQuery: '', accountIds: [] } : {}),
      ...(name === 'sprintId' ? { sprintQuery: '' } : {})
    };
    if (name === 'boardId') setExtraPeople([]);
    setFilters(nextFilters);
    load(nextFilters, { selectScopedPeople: name === 'boardId' });
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
      setError(err.message || 'Não foi possível salvar o apontamento.');
    }
  }

  async function deleteWorklog(values) {
    setError('');
    try {
      await invoke('deleteWorklog', values);
      setModal(null);
      await load(filters);
    } catch (err) {
      setError(err.message || 'Não foi possível excluir o apontamento.');
    }
  }

  async function searchUsers(query, projectKey = userSearch.projectKey) {
    const requestId = ++userSearchRequestRef.current;
    setUserSearch((current) => ({ ...current, query, loading: true }));
    try {
      const results = await invoke('searchUsers', { query, projectKey });
      if (requestId !== userSearchRequestRef.current) return;
      setUserSearch((current) => ({ ...current, results, loading: false }));
    } catch (err) {
      if (requestId !== userSearchRequestRef.current) return;
      setError(err.message || 'Não foi possível pesquisar usuários.');
      setUserSearch((current) => ({ ...current, loading: false }));
    }
  }

  function queueUserSearch(query, projectKey = userSearch.projectKey) {
    window.clearTimeout(userSearchTimerRef.current);
    userSearchRequestRef.current += 1;
    setUserSearch((current) => ({ ...current, query, projectKey, loading: true }));
    userSearchTimerRef.current = window.setTimeout(() => searchUsers(query, projectKey), 250);
  }

  function addPerson(person) {
    setHiddenPeopleIds((current) => current.filter((accountId) => accountId !== person.accountId));
    setExtraPeople((current) => mergePeople(current, [person]));
    setFilters((current) => ({
      ...current,
      accountIds: current.accountIds.includes(person.accountId)
        ? current.accountIds.filter((accountId) => accountId !== person.accountId)
        : [...current.accountIds, person.accountId]
    }));
    setPeopleExpanded(true);
  }

  function setPeopleSelection(people, selected) {
    const accountIds = people.map((person) => person.accountId);
    if (selected) {
      setHiddenPeopleIds((current) => current.filter((accountId) => !accountIds.includes(accountId)));
      setExtraPeople((current) => mergePeople(current, people));
    }
    setFilters((current) => ({
      ...current,
      accountIds: selected
        ? [...new Set([...current.accountIds, ...accountIds])]
        : current.accountIds.filter((accountId) => !accountIds.includes(accountId))
    }));
    setPeopleExpanded(true);
  }

  function removePerson(accountId) {
    const replacement = allCollaborators.find((person) => person.accountId !== accountId)?.accountId || '';
    setHiddenPeopleIds((current) => [...new Set([...current, accountId])]);
    setExtraPeople((current) => current.filter((person) => person.accountId !== accountId));
    setFilters((current) => {
      const accountIds = current.accountIds.filter((value) => value !== accountId);
      return { ...current, accountIds: accountIds.length ? accountIds : replacement ? [replacement] : [] };
    });
  }

  function openUserSearch() {
    const projectKey = filters.boardId.startsWith('project:') ? filters.boardId.slice('project:'.length) : '';
    setUserSearch({ open: true, query: '', projectKey, loading: true, results: [] });
    searchUsers('', projectKey);
  }

  function closeUserSearch() {
    window.clearTimeout(userSearchTimerRef.current);
    userSearchRequestRef.current += 1;
    setUserSearch({ open: false, query: '', projectKey: '', loading: false, results: [] });
  }

  return (
    <main className="app">
      {loading && <LoadingOverlay />}
      <header className="page-header">
        <div className="brand-block">
          <div className="logo-mark" aria-hidden="true">OT</div>
          <div>
            <div className="brand-title">
              <h1>Omni Team Reports</h1>
              <span className="version-badge" title="Versão publicada do aplicativo">v {dashboardPackage.version}</span>
            </div>
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

      <SavedReports
        disabled={loading}
        config={{ filters, activeTab, managementFilters, profileFilters, groupBy: cardGroupBy, exportFields, people: allCollaborators }}
        onApply={applySavedReport}
      />

      {error && <div className="alert">{error}</div>}

      <div className={`dashboard-shell ${activeTab === 'management' ? 'management-mode' : ''}`}>
        <aside className="sidebar-filter">
          {!['management', 'profile'].includes(activeTab) && <section className={`people ${peopleExpanded ? 'expanded' : ''}`}>
            <div className="side-title">
              <div className='icon-title-people'>
                <UsersIcon />
                <h2>Colaboradores</h2>
              </div>
              <button className="icon-button primary" onClick={openUserSearch} title="Buscar Colaboradores" aria-label="Buscar Colaboradores"><SearchIcon /></button>
            </div>
            {allCollaborators.length > 0 && <label className="select-all-people">
              <input
                type="checkbox"
                checked={allCollaborators.every((person) => filters.accountIds.includes(person.accountId))}
                onChange={(event) => setAllCollaborators(event.target.checked)}
              />
              <span>Selecionar Todos</span>
              <small>{filters.accountIds.filter((accountId) => allCollaborators.some((person) => person.accountId === accountId)).length}/{allCollaborators.length}</small>
            </label>}
            <div className="people-grid">
              {allCollaborators.slice(0, peopleExpanded ? allCollaborators.length : 2).map((person) => (
                <div className="person-row" key={person.accountId}>
                  <label className="person-check">
                    <input
                      type="checkbox"
                      checked={filters.accountIds.includes(person.accountId)}
                      onChange={() => togglePerson(person.accountId)}
                    />
                    <Avatar person={person} />
                    <span>{person.name}</span>
                  </label>
                  <button className="remove-person" onClick={() => removePerson(person.accountId)} title={`Remover ${person.name} da lista`} aria-label={`Remover ${person.name} da lista`}>X</button>
                </div>
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

          {activeTab === 'management' && <div className="management-scope-note"><GaugeIcon /><div><strong>Visão Gerencial</strong><span>Todos os colaboradores do escopo são incluídos automaticamente.</span></div></div>}
          {activeTab === 'profile' && <div className="management-scope-note profile-scope-note"><UserProfileIcon /><div><strong>Meu Perfil</strong><span>Os filtros abaixo controlam o período e o escopo da sua análise pessoal.</span></div></div>}

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
                Quadro ou Espaço
                <select value={filters.boardId} onChange={(event) => applyAndSet('boardId', event.target.value)}>
                  <option value="">Todos pelo JQL</option>
                  <optgroup label="Quadros">
                    {boardOptions.map((board) => (
                      <option key={board.id} value={board.id}>{board.name} ({board.type || 'board'})</option>
                    ))}
                  </optgroup>
                  <optgroup label="Espaços">
                    {projectOptions.map((board) => (
                      <option key={board.id} value={board.id}>{board.name} (espaço)</option>
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
                <small className="field-help">{sprintOptions.length ? `${sprintOptions.length} sprint(s) disponíveis neste escopo` : 'Selecione um quadro Scrum ou use a busca avançada por nome/ID.'}</small>
              </label>
              <label>
                Status
                <select value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
                  <option value="">Todos</option>
                  {statusOptions(data).map((status) => (
                    <option key={status} value={status}>{status}</option>
                  ))}
                </select>
              </label>
              <div className="date-row">
                <label>
                  Início
                  <input type="date" value={filters.startDate} max={filters.endDate || undefined} onClick={showDatePicker} onChange={(event) => updateFilter('startDate', event.target.value)} />
                </label>
                <label>
                  Fim
                  <input type="date" value={filters.endDate} min={filters.startDate || undefined} onClick={showDatePicker} onChange={(event) => updateFilter('endDate', event.target.value)} />
                </label>
              </div>
              <button className="advanced-toggle" onClick={() => setAdvancedFilters((value) => !value)} aria-expanded={advancedFilters}>
                Filtros Avançados <ChevronIcon down={!advancedFilters} />
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
          {data && (
            <>
              <div className="tabs" role="tablist" aria-label="Visualizações do Relatório">
                <button className={activeTab === 'indicators' ? 'tab active' : 'tab'} onClick={() => setActiveTab('indicators')} role="tab" aria-selected={activeTab === 'indicators'}>
                  <ChartIcon />
                  <span>Indicadores</span>
                </button>
                <button className={activeTab === 'management' ? 'tab active' : 'tab'} onClick={() => setActiveTab('management')} role="tab" aria-selected={activeTab === 'management'}>
                  <GaugeIcon />
                  <span>Gestão</span>
                </button>
                <button className={activeTab === 'export' ? 'tab active' : 'tab'} onClick={() => setActiveTab('export')} role="tab" aria-selected={activeTab === 'export'}>
                  <SpreadsheetIcon />
                  <span>Exportar Excel</span>
                </button>
                <button className={activeTab === 'profile' ? 'tab active' : 'tab'} onClick={() => setActiveTab('profile')} role="tab" aria-selected={activeTab === 'profile'}>
                  <UserProfileIcon />
                  <span>Meu Perfil</span>
                </button>
              </div>

              {activeTab === 'indicators' ? (
                primaryReport ? <>
                  <MetricsCards report={primaryReport} />
                  <Ranking ranking={ranking} />
                  <Calendar
                    weeks={primaryReport.calendarWeeks}
                    issues={data.issueOptions || []}
                    onAdd={(day) => setModal({ mode: 'add', day, issues: data.issueOptions || [] })}
                    onEdit={(entry) => setModal({ mode: 'edit', entry })}
                  />
                  <CardsByUser reports={selectedReports} statusFilter={filters.status} groupBy={cardGroupBy} setGroupBy={setCardGroupBy} />
                </> : <section className="panel profile-empty"><UserProfileIcon /><h2>Nenhum colaborador selecionado</h2><p className="muted-text">Use a lista lateral ou o botão de adicionar para montar a comparação.</p></section>
              ) : activeTab === 'management' ? (
                <ManagementDashboard reports={data.managementReports || data.reports || []} issueOptions={data.issueOptions || []} filters={managementFilters} setFilters={setManagementFilters} />
              ) : activeTab === 'export' ? (
                <ExportPanel
                  reports={selectedReports}
                  issueOptions={data.issueOptions || []}
                  statusFilter={filters.status}
                  fields={exportFields}
                  onFieldsChange={setExportFields}
                />
              ) : (
                <ProfileDashboard
                  filters={profileFilters}
                  setFilters={setProfileFilters}
                  report={profileReport}
                  issueOptions={data.issueOptions || []}
                  startDate={filters.startDate}
                  endDate={filters.endDate}
                  onEditWorklog={(entry) => setModal({ mode: 'edit', entry })}
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
          onSearch={queueUserSearch}
          onAdd={addPerson}
          onSetSelection={setPeopleSelection}
          selectedIds={filters.accountIds}
          selectedPeople={allCollaborators.filter((person) => filters.accountIds.includes(person.accountId))}
          projects={projectOptions}
          onClose={closeUserSearch}
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

function emptyReport(person, startDate, endDate) {
  return {
    accountId: person.accountId,
    name: person.name || person.accountId,
    avatarUrl: person.avatarUrl || '',
    metrics: { totalCards: 0, workedCards: 0, storyPoints: 0, workedStoryPoints: 0, hours: 0, done: 0, inProgress: 0, blocked: 0, approved: 0, reproved: 0, qaCards: 0, qaStoryPoints: 0, reportedCards: 0 },
    issues: [],
    qaIssues: [],
    reportedIssues: [],
    approvedIssues: [],
    reprovedIssues: [],
    worklogs: [],
    calendarWeeks: emptyCalendarWeeks(startDate, endDate)
  };
}

function showDatePicker(event) {
  try {
    event.currentTarget.showPicker?.();
  } catch {
    // Alguns navegadores abrem o seletor nativo automaticamente.
  }
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

function UserProfileIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>;
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

function GripIcon() {
  return <svg viewBox="0 0 16 20" aria-hidden="true"><circle cx="5" cy="5" r="1.35" /><circle cx="11" cy="5" r="1.35" /><circle cx="5" cy="10" r="1.35" /><circle cx="11" cy="10" r="1.35" /><circle cx="5" cy="15" r="1.35" /><circle cx="11" cy="15" r="1.35" /></svg>;
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
      <Metric title="Cards no Período" value={metrics.workedCards} />
      <Metric title="Relatados" value={metrics.reportedCards || 0} />
      <Metric title="Story Points" value={metrics.storyPoints} />
      <Metric title="SP no Período" value={metrics.workedStoryPoints} />
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

function Ranking({ ranking }) {
  const generalTotal = ranking.reduce((acc, report) => ({
    cards: acc.cards + report.metrics.totalCards,
    storyPoints: acc.storyPoints + report.metrics.storyPoints,
    hours: acc.hours + report.metrics.hours,
    approved: acc.approved + report.metrics.approved,
    reproved: acc.reproved + report.metrics.reproved,
    reported: acc.reported + Number(report.metrics.reportedCards || 0)
  }), { cards: 0, storyPoints: 0, hours: 0, approved: 0, reproved: 0, reported: 0 });

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Ranking e Totais</h2>
        {ranking[0] && <span>1º: {ranking[0].name}</span>}
      </div>
      <div className="ranking-table-scroll"><table>
        <thead>
          <tr>
            <th>#</th><th>Colaborador</th><th>Cards</th><th>Relatados</th><th>SP</th><th>Horas</th><th>Aprovados</th><th>Reprovados</th>
          </tr>
        </thead>
        <tbody>
          {ranking.map((report, index) => (
            <tr key={report.accountId} className={ranking.length === 1 ? 'selected-row' : ''}>
              <td>{index + 1}</td>
              <td><UserLabel person={report} /></td>
              <td>{report.metrics.totalCards}</td>
              <td>{report.metrics.reportedCards || 0}</td>
              <td>{report.metrics.storyPoints}</td>
              <td>{report.metrics.hours}</td>
              <td>{report.metrics.approved}</td>
              <td>{report.metrics.reproved}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><th colSpan="2">Total Geral</th><th>{generalTotal.cards}</th><th>{generalTotal.reported}</th><th>{generalTotal.storyPoints}</th><th>{Math.round(generalTotal.hours * 100) / 100}</th><th>{generalTotal.approved}</th><th>{generalTotal.reproved}</th></tr>
        </tfoot>
      </table></div>
    </section>
  );
}

function UserLabel({ person }) {
  return <span className="user-label"><Avatar person={person} /><span>{person.name}</span></span>;
}

function IssueLink({ issueKey }) {
  if (!issueKey) return '-';
  return <button
    type="button"
    className="issue-link"
    title={`Abrir ${issueKey} no Jira`}
    aria-label={`Abrir card ${issueKey} no Jira em uma nova aba`}
    onClick={(event) => {
      event.stopPropagation();
      router.open(`/browse/${encodeURIComponent(issueKey)}`);
    }}
  >{issueKey}</button>;
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
        <thead><tr><th>Chave</th><th>Resumo</th><th>Status</th><th>SP</th></tr></thead>
        <tbody>
          {issues.length ? issues.map((issue) => (
            <tr key={issue.key}>
              <td><IssueLink issueKey={issue.key} /></td><td>{issue.summary}</td><td><span className={`badge ${tone}`}>{issue.status}</span></td><td>{issue.storyPoints}</td>
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
          <h2>Calendário de Trabalho</h2>
          <p className="muted-text">Resumo compacto da semana. Use "Ver" para abrir os detalhes do dia.</p>
        </div>
        <button className="ghost calendar-open" onClick={() => setWeekOpen(true)}><CalendarIcon /> Visualizar por Semana</button>
      </div>
      <div className="workday-list" aria-label="Calendário em Colunas por Dia">
        {productiveDays.map((day) => (
          <article className={`workday ${day.hours > 0 ? 'has-work' : ''}`} key={day.date}>
            <div className="workday-date">
              <strong>{day.label}</strong>
              <span>{weekdayName(day.date)}</span>
            </div>
            <div className="workday-body">
              <div className="workday-total">
                <span>{day.hours} h</span>
                <div className="workday-quick-actions">
                  {day.entries.length > 0 && <button className="day-detail-button ghost" onClick={() => setDetailDay(day)}>Ver</button>}
                  {issues.length > 0 && <button className="icon-button primary" onClick={() => onAdd(day)} title="Adicionar Horas" aria-label="Adicionar Horas"><PlusIcon /></button>}
                </div>
              </div>
              <div className="workday-entries">
                {day.entries.length ? day.entries.map((entry) => (
                  <div className={`entry ${statusClass(entry.status)}`} key={entry.id}>
                    <div className="entry-main">
                      <IssueLink issueKey={entry.issue} />
                      <span>{entry.hours}h</span>
                    </div>
                    <small title={entry.summary}>{entry.summary}</small>
                    <div className="entry-actions">
                      <span className={`badge ${statusClass(entry.status)}`} title={entry.status}>{entry.status}</span>
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
      <div className="modal week-modal" role="dialog" aria-modal="true" aria-label="Calendário Semanal">
        <div className="modal-head">
          <div><h2>Semana de Trabalho</h2><p>{range} · {total} h registradas</p></div>
          <button className="icon-button ghost" onClick={onClose} aria-label="Fechar">×</button>
        </div>
        <div className="week-nav">
          <button className="ghost" disabled={weekIndex === 0} onClick={() => setWeekIndex((value) => value - 1)}>← Anterior</button>
          <strong>Semana {weekIndex + 1} de {weeks.length}</strong>
          <button className="ghost" disabled={weekIndex >= weeks.length - 1} onClick={() => setWeekIndex((value) => value + 1)}>Próxima →</button>
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
              <div className="entry-main"><IssueLink issueKey={entry.issue} /><span>{entry.hours}h</span></div>
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

function UserSearchModal({ state, onSearch, onAdd, onSetSelection, onClose, selectedIds, selectedPeople, projects }) {
  const [activeTab, setActiveTab] = useState('search');
  const resultIds = state.results.map((person) => person.accountId);
  const allResultsSelected = resultIds.length > 0 && resultIds.every((accountId) => selectedIds.includes(accountId));

  function changeProject(projectKey) {
    onSearch('', projectKey);
  }

  return (
    <div className="modal-backdrop">
      <div className="modal user-search-modal">
        <div className="modal-head">
          <div>
            <h2>Buscar Colaboradores</h2>
            <p>Filtre por projeto e selecione pessoas individualmente ou em grupo.</p>
          </div>
          <button className="icon-button ghost" onClick={onClose} aria-label="Fechar">×</button>
        </div>
        <div className="user-modal-tabs" role="tablist" aria-label="Colaboradores">
          <button className={activeTab === 'search' ? 'active' : ''} onClick={() => setActiveTab('search')} role="tab" aria-selected={activeTab === 'search'}>Buscar</button>
          <button className={activeTab === 'selected' ? 'active' : ''} onClick={() => setActiveTab('selected')} role="tab" aria-selected={activeTab === 'selected'}>
            Selecionados <span>{selectedIds.length}</span>
          </button>
        </div>
        {activeTab === 'search' ? (
          <>
            <div className="user-search-filters">
              <label>Projeto
                <select value={state.projectKey} onChange={(event) => changeProject(event.target.value)}>
                  <option value="">Todos os projetos</option>
                  {projects.map((project) => <option key={project.id} value={project.key}>{project.name}</option>)}
                </select>
              </label>
              <label>Colaborador
                <span className="search-input-wrap"><SearchIcon /><input
                  autoFocus
                  placeholder="Digite um nome"
                  value={state.query}
                  onChange={(event) => onSearch(event.target.value, state.projectKey)}
                /></span>
              </label>
            </div>
            <div className="user-results-actions">
              <span>{state.loading ? 'Buscando...' : `${state.results.length} colaborador(es) encontrado(s)`}</span>
              <button
                type="button"
                className="ghost compact-button"
                disabled={state.loading || !state.results.length}
                onClick={() => onSetSelection(state.results, !allResultsSelected)}
              >
                {allResultsSelected ? 'Desmarcar Todos' : 'Selecionar Todos'}
              </button>
            </div>
            <div className="user-results">
              {state.loading && <div className="empty-day user-results-empty">Pesquisando...</div>}
              {!state.loading && state.results.map((person) => {
                const selected = selectedIds.includes(person.accountId);
                return (
                  <button className={`user-result ${selected ? 'selected' : ''}`} key={person.accountId} onClick={() => onAdd(person)} aria-pressed={selected}>
                    <UserLabel person={person} />
                    <span className="user-result-action">{selected ? 'Remover' : 'Adicionar'}</span>
                  </button>
                );
              })}
              {!state.loading && state.query && !state.results.length && <div className="empty-day user-results-empty">Nenhum usuário encontrado.</div>}
            </div>
          </>
        ) : (
          <div className="user-results selected-user-results" role="tabpanel">
            {selectedPeople.length ? selectedPeople.map((person) => (
              <button className="user-result selected" key={person.accountId} onClick={() => onAdd(person)}>
                <UserLabel person={person} />
                <span className="user-result-action remove">Remover</span>
              </button>
            )) : <div className="empty-day user-results-empty">Nenhum colaborador selecionado. Volte para Buscar para adicionar.</div>}
          </div>
        )}
        <div className="modal-actions">
          <span className="muted-text">{selectedIds.length} colaborador(es) selecionado(s)</span>
          <button className="primary" onClick={onClose}>Concluir</button>
        </div>
      </div>
    </div>
  );
}

function weekdayName(date) {
  return new Date(`${date}T00:00:00`).toLocaleDateString('pt-BR', { weekday: 'short' });
}

function CardsByUser({ reports, statusFilter, groupBy, setGroupBy }) {
  const visibleIssues = reports.flatMap((report) => reportIssuesByRole(report, statusFilter).map((issue) => ({ ...issue, owner: report })));
  const statusGroups = Object.entries(visibleIssues.reduce((groups, issue) => {
    const key = issue.status || 'Sem status';
    (groups[key] ||= []).push(issue);
    return groups;
  }, {})).sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="panel">
      <div className="panel-title cards-title">
        <div><h2>Cards por Status e Colaborador</h2><p className="muted-text">Expanda somente os grupos que deseja analisar.</p></div>
        <div className="segmented">
          <button className={groupBy === 'person' ? 'active' : ''} onClick={() => setGroupBy('person')}>Colaborador</button>
          <button className={groupBy === 'status' ? 'active' : ''} onClick={() => setGroupBy('status')}>Status</button>
        </div>
      </div>
      {groupBy === 'person' ? reports.map((report, index) => (
        <details key={report.accountId} open={index === 0}>
          <summary>
            <UserLabel person={report} />
            <span>{report.metrics.totalCards} cards - {report.metrics.reportedCards || 0} relatados - {report.metrics.storyPoints} SP - {report.metrics.hours} h</span>
          </summary>
          <div className="cards-table-scroll"><table className="cards-table">
            <thead><tr><th>Status</th><th>Resultado</th><th>Papel</th><th>Chave</th><th>Sprint</th><th>Resumo</th><th>SP</th><th title="Total registrado no card, independentemente do período selecionado">Horas Totais</th></tr></thead>
            <tbody>
              {reportIssuesByRole(report, statusFilter).map((issue) => (
                <tr key={issue.key}>
                  <td className="status-cell"><span className={`badge ${statusClass(issue.status)}`}>{issue.status}</span></td>
                  <td className="result-cell"><ReviewResult issue={issue} /></td>
                  <td><span className="role-badge">{issue.role}</span></td>
                  <td className="issue-key"><IssueLink issueKey={issue.key} /></td>
                  <td className="sprint-cell" title={issue.sprint || ''}>{issue.sprint || '-'}</td>
                  <td className="summary-cell" title={issue.summary}>{issue.summary}</td>
                  <td className="sp-cell">{issue.storyPoints}</td>
                  <td className="hours-cell">{totalIssueHours(issue, report.worklogs)}</td>
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
            <thead><tr><th>Colaborador</th><th>Papel</th><th>Chave</th><th>Sprint</th><th>Resumo</th><th>SP</th><th title="Total registrado no card, independentemente do período selecionado">Horas Totais</th></tr></thead>
            <tbody>{issues.map((issue) => (
              <tr key={`${issue.owner.accountId}-${issue.key}`}>
                <td><UserLabel person={issue.owner} /></td><td><span className="role-badge">{issue.role}</span></td><td className="issue-key"><IssueLink issueKey={issue.key} /></td><td className="sprint-cell" title={issue.sprint || ''}>{issue.sprint || '-'}</td><td className="summary-cell" title={issue.summary}>{issue.summary}</td><td>{issue.storyPoints}</td><td>{totalIssueHours(issue, issue.owner.worklogs)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </details>
      ))}
    </section>
  );
}

function ProfileDashboard({ report, issueOptions, startDate, endDate, onEditWorklog, filters, setFilters }) {
  const allIssues = useMemo(() => buildProfileIssues(report, issueOptions), [report, issueOptions]);
  const allWorklogs = report?.worklogs || [];
  const workedIssueKeys = useMemo(() => new Set(allWorklogs.map((worklog) => worklog.issue)), [allWorklogs]);
  const statusOptions = profileFilterOptions(allIssues, 'status');
  const projectOptions = profileFilterOptions(allIssues, 'project');
  const sprintOptions = profileFilterOptions(allIssues, 'sprint', true);
  const categoryOptions = profileFilterOptions(allIssues, 'categories', true);
  const filteredIssues = allIssues.filter((issue) => {
    const text = `${issue.key} ${issue.summary} ${issue.status} ${issue.project} ${issue.sprint} ${issue.categories}`.toLowerCase();
    return profileRoleMatches(issue.role, filters.role)
      && matchesManagementFilter(issue.status, filters.status)
      && matchesManagementFilter(issue.project, filters.project)
      && matchesManagementFilter(issue.sprint, filters.sprint, true)
      && matchesManagementFilter(issue.categories, filters.category, true)
      && (!filters.search || text.includes(filters.search.trim().toLowerCase()))
      && (!filters.onlyWorked || workedIssueKeys.has(issue.key));
  });
  const filteredIssueKeys = new Set(filteredIssues.map((issue) => issue.key));
  const filteredWorklogs = allWorklogs.filter((worklog) => filteredIssueKeys.has(worklog.issue));
  const approved = filteredIssues.filter((issue) => issue.approved || issue.reviewResult === 'Aprovado').length;
  const reproved = filteredIssues.reduce((total, issue) => total + (Number(issue.rejection || 0) || (issue.reviewResult === 'Reprovado' ? 1 : 0)), 0);
  const done = filteredIssues.filter((issue) => statusClass(issue.status) === 'status-done').length;
  const blocked = filteredIssues.filter((issue) => statusClass(issue.status) === 'status-blocked').length;
  const storyPoints = roundNumber(filteredIssues.reduce((total, issue) => total + Number(issue.storyPoints || 0), 0));
  const hours = roundNumber(filteredWorklogs.reduce((total, worklog) => total + Number(worklog.hours || 0), 0));
  const qaCards = filteredIssues.filter((issue) => issue.role.includes('QA')).length;
  const reportedCards = filteredIssues.filter((issue) => issue.role.includes('Relator')).length;
  const activeDays = new Set(filteredWorklogs.map((worklog) => worklog.date).filter(Boolean)).size;
  const completionRate = filteredIssues.length ? Math.round((done / filteredIssues.length) * 100) : 0;
  const approvalBase = approved + reproved;
  const approvalRate = approvalBase ? Math.round((approved / approvalBase) * 100) : 0;
  const statusItems = aggregateProfileIssues(filteredIssues, 'status', filteredWorklogs, 'cards');
  const projectItems = aggregateProfileIssues(filteredIssues, 'project', filteredWorklogs, 'sp');
  const dailyItems = profileDailyItems(report?.calendarWeeks || [], filteredWorklogs);
  const sortedWorklogs = [...filteredWorklogs].sort((a, b) => String(b.started || '').localeCompare(String(a.started || '')));

  function set(name, value) {
    setFilters((current) => ({ ...current, [name]: value }));
  }

  if (!report) {
    return <section className="panel profile-empty"><UserProfileIcon /><h2>Não foi possível identificar seu perfil</h2><p className="muted-text">Atualize o relatório. Se o problema continuar, confirme se seu usuário possui acesso aos cards deste escopo.</p></section>;
  }

  return (
    <div className="profile-stack">
      <section className="panel profile-hero">
        <div className="profile-identity">
          <span className="profile-avatar"><Avatar person={report} /></span>
          <div><span className="profile-eyebrow">Visão Individual</span><h2>{report.name}</h2><p>Seu desempenho no período de {formatShortDate(startDate)} a {formatShortDate(endDate)}</p></div>
        </div>
        <div className="profile-highlights">
          <div><span>Conclusão</span><strong>{completionRate}%</strong></div>
          <div><span>Média SP/card</span><strong>{filteredIssues.length ? roundNumber(storyPoints / filteredIssues.length) : 0}</strong></div>
          <div><span>Horas/dia ativo</span><strong>{activeDays ? roundNumber(hours / activeDays) : 0} h</strong></div>
          <div><span>Aprovação</span><strong>{approvalRate}%</strong></div>
        </div>
      </section>

      <section className="panel profile-filters">
        <div className="panel-title"><div><h2>Filtrar Minha Visão</h2><p className="muted-text">Os filtros abaixo afetam os indicadores, gráficos, cards e apontamentos desta aba.</p></div><button className="ghost compact-button" onClick={() => setFilters(defaultProfileFilters())}>Limpar Filtros</button></div>
        <div className="profile-filter-grid">
          <SelectFilter label="Papel" value={filters.role} options={['Responsável', 'QA', 'Relator', 'Apenas apontamento']} allLabel="Todos" onChange={(value) => set('role', value)} />
          <SelectFilter label="Status" value={filters.status} options={statusOptions} allLabel="Todos" onChange={(value) => set('status', value)} />
          <SelectFilter label="Projeto" value={filters.project} options={projectOptions} allLabel="Todos" onChange={(value) => set('project', value)} />
          <SelectFilter label="Sprint" value={filters.sprint} options={sprintOptions} allLabel="Todas" onChange={(value) => set('sprint', value)} />
          <SelectFilter label="Categoria" value={filters.category} options={categoryOptions} allLabel="Todas" onChange={(value) => set('category', value)} />
          <label className="management-search">Card Específico<input value={filters.search} onChange={(event) => set('search', event.target.value)} placeholder="Chave, resumo ou projeto" /></label>
        </div>
        <label className="profile-worked-toggle"><input type="checkbox" checked={filters.onlyWorked} onChange={(event) => set('onlyWorked', event.target.checked)} /><span>Mostrar somente cards com apontamento no período</span></label>
      </section>

      <section className="metrics profile-metrics">
        <Metric title="Meus Cards" value={filteredIssues.length} />
        <Metric title="Story Points" value={storyPoints} />
        <Metric title="Horas Apontadas" value={hours} />
        <Metric title="Cards com Horas" value={new Set(filteredWorklogs.map((worklog) => worklog.issue)).size} />
        <Metric title="Cards como QA" value={qaCards} />
        <Metric title="Cards Relatados" value={reportedCards} />
        <Metric title="Concluídos" value={done} />
        <Metric title="Aprovados" value={approved} />
        <Metric title="Reprovações" value={reproved} />
        <Metric title="Impedidos" value={blocked} />
      </section>

      <section className="profile-chart-grid">
        <BarChart title="Meus Cards por Status" items={statusItems} valueKey="cards" max={Math.max(1, ...statusItems.map((item) => item.cards))} />
        <BarChart title="Meus Story Points por Projeto" items={projectItems} valueKey="sp" max={Math.max(1, ...projectItems.map((item) => item.sp))} suffix=" SP" />
      </section>

      <ProfileActivityChart items={dailyItems} />

      <section className="panel profile-detail-panel">
        <div className="panel-title"><div><h2>Meus Cards</h2><p className="muted-text">Responsabilidades, relatos, testes de QA e cards nos quais você apontou horas.</p></div><span className="profile-count">{filteredIssues.length} card(s)</span></div>
        <div className="profile-table-scroll"><table className="profile-cards-table">
          <thead><tr><th>Papel</th><th>Chave</th><th>Resumo</th><th>Status</th><th>Projeto</th><th>Sprint</th><th>SP</th><th title="Total registrado no card, independentemente do período selecionado">Horas Totais</th><th>Resultado</th><th>Atualizado</th></tr></thead>
          <tbody>{filteredIssues.length ? filteredIssues.map((issue) => (
            <tr key={issue.key}>
              <td><span className="role-badge">{profileRoleLabel(issue.role)}</span></td><td className="issue-key"><IssueLink issueKey={issue.key} /></td><td className="summary-cell" title={issue.summary}>{issue.summary || '-'}</td><td><span className={`badge ${statusClass(issue.status)}`}>{issue.status}</span></td><td>{issue.project || '-'}</td><td className="sprint-cell" title={issue.sprint || ''}>{issue.sprint || '-'}</td><td>{issue.storyPoints || 0}</td><td>{totalIssueHours(issue, filteredWorklogs)}</td><td><ReviewResult issue={issue} /></td><td>{formatDateTime(issue.updated)}</td>
            </tr>
          )) : <tr><td colSpan="10"><div className="profile-table-empty">Nenhum card encontrado para os filtros escolhidos.</div></td></tr>}</tbody>
        </table></div>
      </section>

      <section className="panel profile-detail-panel">
        <div className="panel-title"><div><h2>Meus Apontamentos</h2><p className="muted-text">Histórico detalhado das horas registradas no período.</p></div><span className="profile-count">{sortedWorklogs.length} registro(s)</span></div>
        <div className="profile-table-scroll"><table className="profile-worklog-table">
          <thead><tr><th>Data</th><th>Card</th><th>Resumo</th><th>Status</th><th>Horas</th><th>Comentário</th><th></th></tr></thead>
          <tbody>{sortedWorklogs.length ? sortedWorklogs.map((worklog) => (
            <tr key={`${worklog.issue}-${worklog.id}`}><td>{formatShortDate(worklog.date)}</td><td className="issue-key"><IssueLink issueKey={worklog.issue} /></td><td className="summary-cell" title={worklog.summary}>{worklog.summary || '-'}</td><td><span className={`badge ${statusClass(worklog.status)}`}>{worklog.status}</span></td><td><strong>{worklog.hours} h</strong></td><td className="worklog-comment" title={worklog.comment}>{worklog.comment || '-'}</td><td><button className="icon-button ghost" onClick={() => onEditWorklog(worklog)} title="Editar apontamento" aria-label={`Editar apontamento de ${worklog.issue}`}><EditIcon /></button></td></tr>
          )) : <tr><td colSpan="7"><div className="profile-table-empty">Nenhum apontamento encontrado para os filtros escolhidos.</div></td></tr>}</tbody>
        </table></div>
      </section>
    </div>
  );
}

function buildProfileIssues(report, issueOptions) {
  if (!report) return [];
  const issues = new Map(reportIssuesByRole(report, '').map((issue) => [issue.key, issue]));
  const optionsByKey = new Map((issueOptions || []).map((issue) => [issue.key, issue]));
  (report.worklogs || []).forEach((worklog) => {
    if (issues.has(worklog.issue)) return;
    const issue = optionsByKey.get(worklog.issue) || {};
    issues.set(worklog.issue, {
      ...issue,
      key: worklog.issue,
      summary: issue.summary || worklog.summary || '',
      status: issue.status || worklog.status || 'Sem status',
      storyPoints: Number(issue.storyPoints || 0),
      role: 'Apontamento'
    });
  });
  return [...issues.values()].sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')) || a.key.localeCompare(b.key));
}

function profileRoleMatches(role, selectedRole) {
  if (!selectedRole) return true;
  if (selectedRole === 'Responsável') return role.includes('Responsavel');
  if (selectedRole === 'QA') return role.includes('QA');
  if (selectedRole === 'Relator') return role.includes('Relator');
  if (selectedRole === 'Apenas apontamento') return role === 'Apontamento';
  return false;
}

function profileRoleLabel(role) {
  return String(role || '').replace(/Responsavel/g, 'Responsável');
}

function profileFilterOptions(issues, key, isMultiple = false) {
  const values = issues.flatMap((issue) => isMultiple ? splitManagementValues(issue[key]) : [issue[key]]).filter(Boolean);
  const uniqueValues = new Map();
  values.forEach((value) => {
    const normalized = normalizeManagementValue(value);
    if (!uniqueValues.has(normalized)) uniqueValues.set(normalized, value);
  });
  return [...uniqueValues.values()].sort((a, b) => String(a).localeCompare(String(b)));
}

function aggregateProfileIssues(issues, key, worklogs, sortKey) {
  const hoursByIssue = groupWorklogHours(worklogs);
  const groups = new Map();
  issues.forEach((issue) => {
    const label = issue[key] || (key === 'project' ? 'Sem projeto' : 'Não informado');
    const groupKey = normalizeManagementValue(label);
    const current = groups.get(groupKey) || { label, cards: 0, sp: 0, hours: 0 };
    current.cards += 1;
    current.sp = roundNumber(current.sp + Number(issue.storyPoints || 0));
    current.hours = roundNumber(current.hours + Number(hoursByIssue[issue.key] || 0));
    groups.set(groupKey, current);
  });
  return [...groups.values()].sort((a, b) => b[sortKey] - a[sortKey] || a.label.localeCompare(b.label));
}

function profileDailyItems(calendarWeeks, worklogs) {
  const hoursByDate = worklogs.reduce((values, worklog) => {
    values[worklog.date] = roundNumber((values[worklog.date] || 0) + Number(worklog.hours || 0));
    return values;
  }, {});
  return calendarWeeks.flat().filter((day) => day.inPeriod).map((day) => ({ ...day, hours: hoursByDate[day.date] || 0 }));
}

function ProfileActivityChart({ items }) {
  const maxHours = Math.max(1, ...items.map((item) => Number(item.hours || 0)));
  const total = roundNumber(items.reduce((sum, item) => sum + Number(item.hours || 0), 0));
  return <section className="panel profile-activity"><div className="panel-title"><div><h2>Horas por Dia</h2><p className="muted-text">Ritmo dos seus apontamentos dentro do período selecionado.</p></div><strong>{total} h no período</strong></div><div className="profile-activity-scroll"><div className="profile-activity-bars">
    {items.map((item) => <div className="profile-activity-day" key={item.date} title={`${item.label}: ${item.hours} h`}><span>{item.hours ? `${item.hours}h` : ''}</span><div><i style={{ height: `${item.hours ? Math.max(8, (item.hours / maxHours) * 100) : 2}%` }} /></div><small>{item.label}</small></div>)}
    {!items.length && <div className="profile-table-empty">Nenhum dia disponível neste período.</div>}
  </div></div></section>;
}

function formatShortDate(value) {
  if (!value) return '-';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('pt-BR');
}

function ManagementDashboard({ reports, issueOptions, filters, setFilters }) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const allRows = useMemo(() => buildExportRows(reports, issueOptions, ''), [reports, issueOptions]);
  const options = (key) => managementFilterOptions(allRows, key);
  const rows = allRows.filter((row) => {
    const text = `${row.card} ${row.summary}`.toLowerCase();
    return (!filters.persons.length || filters.persons.includes(row.name))
      && matchesManagementFilter(row.status, filters.status)
      && (!filters.project || row.project === filters.project)
      && matchesManagementFilter(row.sprint, filters.sprint, true)
      && matchesManagementFilter(row.categories, filters.category, true)
      && (!filters.search || text.includes(filters.search.toLowerCase()));
  });
  const totals = rows.reduce((value, row) => ({ cards: value.cards + 1, sp: value.sp + Number(row.storyPoints || 0), hours: value.hours + Number(row.hours || 0), done: value.done + (statusClass(row.status) === 'status-done' ? 1 : 0) }), { cards: 0, sp: 0, hours: 0, done: 0 });
  const byPerson = aggregateRows(rows, 'name');
  const byStatus = aggregateRows(rows, 'status');
  const reportedByPerson = new Map(reports
    .filter((report) => !filters.persons.length || filters.persons.includes(report.name))
    .map((report) => [report.name, (report.reportedIssues || []).filter((issue) => {
      const text = `${issue.key} ${issue.summary}`.toLowerCase();
      return matchesManagementFilter(issue.status, filters.status)
        && matchesManagementFilter(issue.project, filters.project)
        && matchesManagementFilter(issue.sprint, filters.sprint, true)
        && matchesManagementFilter(issue.categories, filters.category, true)
        && (!filters.search || text.includes(filters.search.toLowerCase()));
    }).length]));
  const comparisonByPerson = [...new Set([...byPerson.map((item) => item.label), ...[...reportedByPerson.entries()].filter(([, count]) => count > 0).map(([name]) => name)])]
    .map((name) => ({
      ...(byPerson.find((item) => item.label === name) || { label: name, cards: 0, sp: 0, hours: 0 }),
      reported: reportedByPerson.get(name) || 0
    }))
    .sort((a, b) => b.hours - a.hours || b.cards - a.cards || b.reported - a.reported);
  const reportedTotal = [...reportedByPerson.values()].reduce((total, count) => total + count, 0);
  const maxHours = Math.max(1, ...byPerson.map((item) => item.hours));
  const maxCards = Math.max(1, ...byStatus.map((item) => item.cards));

  function set(name, value) {
    setFilters((current) => ({ ...current, [name]: value }));
  }

  async function downloadManagementReport() {
    setExporting(true);
    setExportError('');
    try {
      await exportXlsx(rows, EXPORT_FIELDS, `indicadores-team-reports-${dateStamp()}.xlsx`);
    } catch (error) {
      console.error(error);
      setExportError('Não foi possível gerar o arquivo XLSX. Tente novamente.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="management-stack">
      <section className="panel management-filters">
        <div className="panel-title"><div><div className="title-with-count"><h2>Indicadores de Gestão</h2><span>{reports.length} colaboradores</span></div><p className="muted-text">A visão inclui todos do escopo; use a seleção abaixo para comparar grupos específicos.</p></div><button className="ghost compact-button" onClick={() => setFilters(defaultManagementFilters())}>Limpar Filtros</button></div>
        <div className="management-filter-grid">
          <MultiSelect label="Colaborador" values={filters.persons} options={options('name')} onChange={(values) => set('persons', values)} />
          <SelectFilter label="Status" value={filters.status} options={options('status')} allLabel="Todos" onChange={(value) => set('status', value)} />
          <SelectFilter label="Projeto" value={filters.project} options={options('project')} allLabel="Todos" onChange={(value) => set('project', value)} />
          <SelectFilter label="Sprint" value={filters.sprint} options={options('sprint')} allLabel="Todas" onChange={(value) => set('sprint', value)} />
          <SelectFilter label="Categoria" value={filters.category} options={options('categories')} allLabel="Todas" onChange={(value) => set('category', value)} />
          <label className="management-search">Card Específico<input value={filters.search} onChange={(event) => set('search', event.target.value)} placeholder="Chave ou resumo" /></label>
        </div>
      </section>
      <section className="metrics management-metrics">
        <Metric title="Cards Filtrados" value={totals.cards} />
        <Metric title="Cards Relatados" value={reportedTotal} />
        <Metric title="Story Points" value={roundNumber(totals.sp)} />
        <Metric title="Horas Apontadas" value={roundNumber(totals.hours)} />
        <Metric title="Taxa de Conclusão" value={`${totals.cards ? Math.round((totals.done / totals.cards) * 100) : 0}%`} />
        <Metric title="Horas por Card" value={totals.cards ? roundNumber(totals.hours / totals.cards) : 0} />
        <Metric title="SP por Pessoa" value={byPerson.length ? roundNumber(totals.sp / byPerson.length) : 0} />
      </section>
      <section className="chart-grid">
        <BarChart title="Horas por Colaborador" items={byPerson} valueKey="hours" max={maxHours} suffix="h" />
        <BarChart title="Cards por Status" items={byStatus} valueKey="cards" max={maxCards} />
      </section>
      <section className="panel comparison-table">
        <div className="panel-title"><h2>Comparativo por Colaborador</h2><button className="primary export-button" onClick={downloadManagementReport} disabled={!rows.length || exporting}><DownloadIcon /> {exporting ? 'Gerando XLSX...' : 'Exportar XLSX'}</button></div>
        {exportError && <p className="export-error" role="alert">{exportError}</p>}
        <table><thead><tr><th>Colaborador</th><th>Cards</th><th>Relatados</th><th>SP</th><th>Horas</th><th>Horas/card</th></tr></thead>
          <tbody>{comparisonByPerson.map((item) => <tr key={item.label}><td>{item.label}</td><td>{item.cards}</td><td>{item.reported}</td><td>{item.sp}</td><td>{item.hours}</td><td>{item.cards ? roundNumber(item.hours / item.cards) : 0}</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  );
}

function managementFilterOptions(rows, key) {
  const isMultiple = key === 'sprint' || key === 'categories';
  const values = rows.flatMap((row) => isMultiple ? splitManagementValues(row[key]) : [row[key]])
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)));
  const uniqueValues = new Map();
  values.forEach((value) => {
    const normalized = normalizeManagementValue(value);
    if (!uniqueValues.has(normalized)) uniqueValues.set(normalized, value);
  });
  return [...uniqueValues.values()];
}

function matchesManagementFilter(rowValue, selectedValue, isMultiple = false) {
  if (!selectedValue) return true;
  const selected = normalizeManagementValue(selectedValue);
  const values = isMultiple ? splitManagementValues(rowValue) : [rowValue];
  return values.some((value) => normalizeManagementValue(value) === selected);
}

function splitManagementValues(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeManagementValue(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function reportIssuesByRole(report, statusFilter) {
  const issues = new Map();
  const addRole = (issue, role) => {
    const current = issues.get(issue.key);
    const roles = new Set([...(current?.role || '').split(' / ').filter(Boolean), role]);
    issues.set(issue.key, { ...current, ...issue, role: [...roles].join(' / ') });
  };
  (report.issues || []).forEach((issue) => addRole(issue, 'Responsavel'));
  (report.qaIssues || []).forEach((issue) => addRole(issue, 'QA'));
  (report.reportedIssues || []).forEach((issue) => addRole(issue, 'Relator'));
  return filteredIssues([...issues.values()], statusFilter);
}

function ReviewResult({ issue }) {
  if (!issue.approved && !issue.rejection && !issue.reviewResult) return '-';
  return <span className="review-badges">
    {(issue.approved || issue.reviewResult === 'Aprovado') && <span className="badge success">Aprovado</span>}
    {Number(issue.rejection || 0) > 0 && <span className="badge danger">{issue.rejection} reprov.</span>}
    {!issue.approved && !issue.rejection && issue.reviewResult === 'Reprovado' && <span className="badge danger">Reprovado</span>}
  </span>;
}

function MultiSelect({ label, values, options, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef(null);
  const visibleOptions = options.filter((option) => option.toLowerCase().includes(query.trim().toLowerCase()));
  const summary = values.length ? `${values.length} selecionado(s)` : 'Todos';

  function toggle(value) {
    onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  }

  function close() {
    setOpen(false);
    setQuery('');
  }

  return (
    <div className="management-select-control">
      <span>{label}</span>
      <button ref={triggerRef} type="button" className={`select-trigger ${open ? 'open' : ''}`} onClick={() => setOpen((value) => !value)} aria-haspopup="listbox" aria-expanded={open}>
        <span title={summary}>{summary}</span><ChevronIcon down={!open} />
      </button>
      {open && <FloatingDropdown anchorRef={triggerRef} onClose={close} className="multi-select-dropdown">
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar colaborador" />
          <div className="multi-select-actions">
            <button type="button" className="ghost" onClick={() => onChange(options)}>Selecionar Todos</button>
            <button type="button" className="ghost" onClick={() => onChange([])}>Limpar</button>
          </div>
          <div className="multi-select-options">
            {visibleOptions.map((option) => (
              <label className="multi-select-option" key={option}>
                <input type="checkbox" checked={values.includes(option)} onChange={() => toggle(option)} />
                <span>{option}</span>
              </label>
            ))}
            {!visibleOptions.length && <span className="empty-day">Nenhum colaborador encontrado.</span>}
          </div>
      </FloatingDropdown>}
    </div>
  );
}

function SelectFilter({ label, value, options, allLabel, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef(null);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = options.filter((option) => option.toLowerCase().includes(normalizedQuery));
  const selectedLabel = value || allLabel;

  function select(nextValue) {
    onChange(nextValue);
    setOpen(false);
    setQuery('');
  }

  function close() {
    setOpen(false);
    setQuery('');
  }

  return <div className="management-select-control">
    <span>{label}</span>
    <button ref={triggerRef} type="button" className={`select-trigger ${open ? 'open' : ''}`} onClick={() => setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open}>
      <span title={selectedLabel}>{selectedLabel}</span><ChevronIcon down={!open} />
    </button>
    {open && <FloatingDropdown anchorRef={triggerRef} onClose={close} className="single-select-dropdown">
      {options.length > 7 && <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Buscar ${label.toLowerCase()}`} />}
      <div className="select-options" role="listbox" aria-label={label}>
        {!normalizedQuery && <button type="button" className={!value ? 'selected' : ''} onClick={() => select('')} role="option" aria-selected={!value}>{allLabel}</button>}
        {visibleOptions.map((option) => (
          <button type="button" className={value === option ? 'selected' : ''} key={option} onClick={() => select(option)} role="option" aria-selected={value === option} title={option}>{option}</button>
        ))}
        {!visibleOptions.length && normalizedQuery && <span className="empty-day">Nenhuma opção encontrada.</span>}
      </div>
    </FloatingDropdown>}
  </div>;
}

function FloatingDropdown({ anchorRef, onClose, className, children }) {
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ visibility: 'hidden' });

  useEffect(() => {
    function updatePosition() {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewportPadding = 8;
      const maximumWidth = Math.max(200, window.innerWidth - viewportPadding * 2);
      const width = Math.min(maximumWidth, 380, Math.max(260, rect.width));
      const left = Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - width - viewportPadding));
      const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
      const spaceAbove = rect.top - viewportPadding;
      const opensAbove = spaceBelow < 230 && spaceAbove > spaceBelow;
      const availableHeight = Math.max(150, Math.min(340, (opensAbove ? spaceAbove : spaceBelow) - 8));
      setPosition({
        left,
        width,
        maxHeight: availableHeight,
        visibility: 'visible',
        ...(opensAbove ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 })
      });
    }

    function handlePointerDown(event) {
      if (!menuRef.current?.contains(event.target) && !anchorRef.current?.contains(event.target)) onClose();
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorRef, onClose]);

  return createPortal(<div ref={menuRef} className={`floating-dropdown ${className}`} style={position}>{children}</div>, document.body);
}

function aggregateRows(rows, key) {
  const values = new Map();
  rows.forEach((row) => {
    const label = row[key] || 'Não informado';
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

function ExportPanel({ reports, issueOptions, statusFilter, fields, onFieldsChange }) {
  const rows = useMemo(() => buildExportRows(reports, issueOptions, statusFilter), [reports, issueOptions, statusFilter]);
  const [draggedField, setDraggedField] = useState('');
  const [dropIndicator, setDropIndicator] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const fieldsByKey = new Map(EXPORT_FIELDS.map((field) => [field.key, field]));
  const selectedFields = fields.map((key) => fieldsByKey.get(key)).filter(Boolean);
  const orderedFieldChoices = [...selectedFields, ...EXPORT_FIELDS.filter((field) => !fields.includes(field.key))];
  const previewRows = rows.slice(0, 8);

  function toggleField(fieldKey) {
    onFieldsChange((current) => current.includes(fieldKey)
      ? current.filter((key) => key !== fieldKey)
      : [...current, fieldKey]);
  }

  async function download() {
    setExporting(true);
    setExportError('');
    try {
      await exportXlsx(rows, selectedFields, `team-reports-${dateStamp()}.xlsx`);
    } catch (error) {
      console.error(error);
      setExportError('Não foi possível gerar o arquivo XLSX. Tente novamente.');
    } finally {
      setExporting(false);
    }
  }

  function moveField(sourceKey, targetKey, side = 'before') {
    if (!sourceKey || sourceKey === targetKey || !fields.includes(sourceKey) || !fields.includes(targetKey)) return;
    onFieldsChange((current) => {
      const next = current.filter((key) => key !== sourceKey);
      const targetIndex = next.indexOf(targetKey);
      next.splice(targetIndex + (side === 'after' ? 1 : 0), 0, sourceKey);
      return next;
    });
  }

  function updateDropIndicator(event, targetKey) {
    if (!fields.includes(targetKey) || draggedField === targetKey) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const side = event.clientX < bounds.left + (bounds.width / 2) ? 'before' : 'after';
    setDropIndicator((current) => current?.key === targetKey && current?.side === side ? current : { key: targetKey, side });
  }

  return (
    <section className="panel export-panel">
      <div className="export-head">
        <div className="export-title">
          <h2>Relatório para Gerência</h2>
          <span>{rows.length} linhas</span>
          <span>{selectedFields.length} colunas</span>
        </div>
        <div className="export-actions">
          <div className="field-picker-actions">
            <button className="ghost compact-button" onClick={() => onFieldsChange(EXPORT_FIELDS.map((field) => field.key))}>Todos</button>
            <button className="ghost compact-button" onClick={() => onFieldsChange(DEFAULT_EXPORT_FIELDS)}>Modelo</button>
            <button className="ghost compact-button" onClick={() => onFieldsChange([])}>Limpar</button>
          </div>
          <button className="primary export-button" onClick={download} disabled={!rows.length || !selectedFields.length || exporting} title="Baixar XLSX">
            <DownloadIcon />
            <span>{exporting ? 'Gerando XLSX...' : 'Baixar XLSX'}</span>
          </button>
        </div>
      </div>

      <div className="field-grid-help"><GripIcon /><span>Arraste as colunas selecionadas para definir a ordem no arquivo.</span></div>
      <div className="field-grid">
        {orderedFieldChoices.map((field) => {
          const selected = fields.includes(field.key);
          const indicatorClass = dropIndicator?.key === field.key ? `drop-${dropIndicator.side}` : '';
          return (
            <div
              className={`field-check ${selected ? 'selected' : ''} ${draggedField === field.key ? 'dragging' : ''} ${indicatorClass}`}
              key={field.key}
              draggable={selected}
              onDragStart={(event) => {
                setDraggedField(field.key);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', field.key);
              }}
              onDragEnd={() => { setDraggedField(''); setDropIndicator(null); }}
              onDragOver={(event) => updateDropIndicator(event, field.key)}
              onDrop={(event) => {
                event.preventDefault();
                moveField(draggedField, field.key, dropIndicator?.key === field.key ? dropIndicator.side : 'before');
                setDraggedField('');
                setDropIndicator(null);
              }}
            >
              {selected && <span className="drag-handle" title="Arraste para reordenar" aria-hidden="true"><GripIcon /></span>}
              <input type="checkbox" checked={selected} onChange={() => toggleField(field.key)} aria-label={`Incluir coluna ${field.label}`} />
              <span className="field-label">{field.label}</span>
            </div>
          );
        })}
      </div>
      {exportError && <p className="export-error" role="alert">{exportError}</p>}

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

async function exportXlsx(rows, fields, filename) {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  const archive = buildXlsxArchive(rows, fields);
  const blob = new Blob([archive], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('pt-BR');
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
        <div className="modal-head">
          <h2>{isEdit ? `Editar ${values.issueKey}` : 'Adicionar Horas'}</h2>
          <button type="button" className="icon-button ghost" onClick={onClose} title="Fechar" aria-label="Fechar modal">×</button>
        </div>
        {!isEdit && (
          <div className="issue-picker">
            <button type="button" className="issue-picker-head" onClick={() => setPickerExpanded((value) => !value)} aria-expanded={pickerExpanded}>
              <span><small>Card Selecionado</small><strong>{selectedIssue ? `${selectedIssue.key} · ${selectedIssue.summary}` : 'Selecione um card'}</strong></span><ChevronIcon down={!pickerExpanded} />
            </button>
            {pickerExpanded && <div className="issue-picker-body">
              <input autoFocus placeholder="Buscar por chave, resumo ou status" value={issueQuery} onChange={(event) => setIssueQuery(event.target.value)} />
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
        <label>Data e Hora
          <input type="datetime-local" value={values.started} onChange={(event) => set('started', event.target.value)} required />
        </label>
        <label>Horas
          <input type="number" min="0.1" step="0.1" value={values.hours} onChange={(event) => set('hours', Number(event.target.value))} required />
        </label>
        <label>Comentário
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
