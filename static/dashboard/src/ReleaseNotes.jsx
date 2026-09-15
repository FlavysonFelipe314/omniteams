import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke, router } from '@forge/bridge';
import DateRangePicker from './DateRangePicker.jsx';
import { dateRangeChunks, isRetryableInvocationError, statusClass } from './report-utils.js';
import { buildXlsxArchive } from './xlsx-utils.js';
import { buildReleaseNoteRows, releaseCardEpic, releaseCardEpicId, releaseNoteText } from '../../../src/shared/release-notes.mjs';

const FILTERS_STORAGE_KEY = 'teamReportsReleaseNotesFiltersV1';
const CHECKS_STORAGE_KEY = 'teamReportsReleaseNotesChecksV1';
const GROUP_ORDER = ['FRONT', 'BACK', 'FRONT/BACK', 'NÃO INFORMADO'];
const RELEASE_EXPORT_FIELDS = [
  { key: 'key', label: 'Número do Card', value: (row) => row.key },
  { key: 'layer', label: 'Front/Back', value: (row) => row.layer },
  { key: 'type', label: 'Tipo', value: (row) => row.releaseType },
  { key: 'epic', label: 'Epic do Card', value: releaseCardEpic },
  { key: 'homologationDate', label: 'Data de Homologação', value: (row) => formatDate(row.homologationDate) },
  { key: 'summary', label: 'Resumo do Card', value: (row) => row.summary || '' },
  { key: 'releaseText', label: 'Texto para copiar', value: (row) => row.releaseText }
];

function localIso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function defaultFilters() {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return { startDate: localIso(monday), endDate: localIso(today), projectKeys: [], sortOrder: 'homologation' };
}

function storedFilters() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(FILTERS_STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return defaultFilters();
    const { projectKey, ...rest } = saved;
    const projectKeys = Array.isArray(saved.projectKeys)
      ? saved.projectKeys
      : projectKey
        ? [projectKey]
        : [];
    return { ...defaultFilters(), ...rest, projectKeys };
  } catch {
    return defaultFilters();
  }
}

function storedChecks() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(CHECKS_STORAGE_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

async function requestChunk(filters, chunk) {
  try {
    return [await invoke('getReleaseNotesData', { ...filters, ...chunk })];
  } catch (error) {
    const days = Math.round((new Date(chunk.endDate) - new Date(chunk.startDate)) / 86_400_000) + 1;
    if (!isRetryableInvocationError(error) || days <= 1) throw error;
    const smaller = dateRangeChunks(chunk.startDate, chunk.endDate, Math.ceil(days / 2));
    const results = [];
    for (const item of smaller) results.push(...await requestChunk(filters, item));
    return results;
  }
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function formatDate(value) {
  if (!value) return 'Não informada';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('pt-BR');
}

function fileSlug(value) {
  return String(value || 'todas').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function downloadXlsx(rows, name) {
  const archive = buildXlsxArchive(rows, RELEASE_EXPORT_FIELDS);
  const blob = new Blob([archive], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `release-notes-${fileSlug(name)}-${localIso(new Date())}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ProjectMultiSelect({ projects, values, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleProjects = projects
    .filter((project) => `${project.name} ${project.key}`.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
  const selectedNames = projects.filter((project) => values.includes(project.key)).map((project) => project.name);
  const summary = !values.length
    ? 'Todos os projetos'
    : values.length === 1
      ? selectedNames[0] || values[0]
      : `${values.length} projetos selecionados`;

  useEffect(() => {
    if (!open) return undefined;
    function closeOutside(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function closeEscape(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [open]);

  function toggle(key) {
    onChange(values.includes(key) ? values.filter((item) => item !== key) : [...values, key]);
  }

  function selectVisible() {
    onChange([...new Set([...values, ...visibleProjects.map((project) => project.key)])]);
  }

  return <div className="release-project-filter" ref={rootRef}>
    <span>Projetos</span>
    <button type="button" className={`release-project-trigger ${open ? 'open' : ''}`} onClick={() => setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open}>
      <span title={selectedNames.join(', ') || summary}>{summary}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <div className="release-project-menu">
      <input type="search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nome ou chave" aria-label="Buscar projeto" />
      <div className="release-project-menu-actions">
        <button type="button" className="ghost compact-button" onClick={() => onChange([])}>Todos</button>
        <button type="button" className="ghost compact-button" onClick={selectVisible} disabled={!visibleProjects.length}>Selecionar resultados</button>
      </div>
      <div className="release-project-options" role="listbox" aria-label="Projetos" aria-multiselectable="true">
        {visibleProjects.map((project) => <label key={project.key} className="release-project-option" role="option" aria-selected={values.includes(project.key)}>
          <input type="checkbox" checked={values.includes(project.key)} onChange={() => toggle(project.key)} />
          <span title={`${project.name} (${project.key})`}>{project.name}<small>{project.key}</small></span>
        </label>)}
        {!visibleProjects.length && <span className="empty-day">Nenhum projeto encontrado.</span>}
      </div>
      <button type="button" className="primary release-project-done" onClick={() => setOpen(false)}>Concluir</button>
    </div>}
  </div>;
}

export default function ReleaseNotes({ projects }) {
  const [filters, setFilters] = useState(storedFilters);
  const [issues, setIssues] = useState([]);
  const [checkedKeys, setCheckedKeys] = useState(storedChecks);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState([]);
  const [epicFilter, setEpicFilter] = useState('');
  const [groupBy, setGroupBy] = useState('layer');
  const rows = useMemo(() => buildReleaseNoteRows(issues, filters.sortOrder), [issues, filters.sortOrder]);
  const epicOptions = useMemo(() => [...new Map(rows.map((row) => [releaseCardEpicId(row), {
    value: releaseCardEpicId(row),
    label: releaseCardEpic(row),
    key: row.parentKey || ''
  }])).values()].sort((left, right) => left.label.localeCompare(right.label, 'pt-BR', { sensitivity: 'base' })), [rows]);
  const visibleRows = useMemo(() => epicFilter ? rows.filter((row) => releaseCardEpicId(row) === epicFilter) : rows, [rows, epicFilter]);
  const groups = useMemo(() => {
    if (groupBy === 'epic') {
      const byEpic = new Map();
      visibleRows.forEach((row) => {
        const key = releaseCardEpicId(row);
        if (!byEpic.has(key)) byEpic.set(key, { key, label: releaseCardEpic(row), rows: [] });
        byEpic.get(key).rows.push(row);
      });
      return [...byEpic.values()]
        .sort((left, right) => left.label.localeCompare(right.label, 'pt-BR', { sensitivity: 'base' }))
        .map((group) => ({ ...group, rows: group.rows.map((row, index) => ({ ...row, releaseText: releaseNoteText(row, index + 1) })) }));
    }
    return GROUP_ORDER.map((label) => ({
      key: label,
      label,
      rows: visibleRows.filter((row) => row.layer === label).map((row, index) => ({ ...row, releaseText: releaseNoteText(row, index + 1) }))
    })).filter((group) => group.rows.length);
  }, [visibleRows, groupBy]);
  const visibleKeys = visibleRows.map((row) => row.key);
  const checkedVisible = visibleKeys.filter((key) => checkedKeys.includes(key)).length;

  useEffect(() => {
    window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
  }, [filters]);

  useEffect(() => {
    window.localStorage.setItem(CHECKS_STORAGE_KEY, JSON.stringify(checkedKeys));
  }, [checkedKeys]);

  useEffect(() => {
    if (epicFilter && !epicOptions.some((option) => option.value === epicFilter)) setEpicFilter('');
  }, [epicFilter, epicOptions]);

  async function load(nextFilters = filters) {
    if (!nextFilters.startDate || !nextFilters.endDate || nextFilters.startDate > nextFilters.endDate) {
      setError('A data final deve ser igual ou posterior à data inicial.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const chunks = dateRangeChunks(nextFilters.startDate, nextFilters.endDate, 14);
      const responses = [];
      for (let index = 0; index < chunks.length; index += 2) {
        const batch = await Promise.all(chunks.slice(index, index + 2).map((chunk) => requestChunk(nextFilters, chunk)));
        responses.push(...batch.flat());
      }
      const uniqueIssues = [...new Map(responses.flatMap((response) => response.issues || []).map((issue) => [issue.key, issue])).values()];
      setIssues(uniqueIssues);
    } catch (loadError) {
      console.error(loadError);
      setIssues([]);
      setError(loadError.message || 'Não foi possível carregar os cards das Release Notes.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(filters);
  }, []);

  function toggleChecked(key) {
    setCheckedKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  function clearVisibleChecks() {
    setCheckedKeys((current) => current.filter((key) => !visibleKeys.includes(key)));
  }

  function toggleGroupChecks(groupRows) {
    const groupKeys = groupRows.map((row) => row.key);
    const groupChecked = groupKeys.every((key) => checkedKeys.includes(key));
    setCheckedKeys((current) => groupChecked
      ? current.filter((key) => !groupKeys.includes(key))
      : [...new Set([...current, ...groupKeys])]);
  }

  function toggleGroup(label) {
    setCollapsedGroups((current) => current.includes(label) ? current.filter((item) => item !== label) : [...current, label]);
  }

  async function copy(text, successMessage) {
    try {
      await copyToClipboard(text);
      setCopyStatus(successMessage);
      window.setTimeout(() => setCopyStatus(''), 2200);
    } catch (copyError) {
      console.error(copyError);
      setCopyStatus('Não foi possível copiar.');
    }
  }

  function exportRows(exportRowsList, name) {
    try {
      downloadXlsx(exportRowsList, name);
      setCopyStatus(`Arquivo ${name} gerado!`);
      window.setTimeout(() => setCopyStatus(''), 2200);
    } catch (exportError) {
      console.error(exportError);
      setCopyStatus('Não foi possível exportar o arquivo.');
    }
  }

  const allGroupedRows = groups.flatMap((group) => group.rows);
  const allReleaseText = groups.map((group) => `${group.label}\n${group.rows.map((row) => row.releaseText).join('\n')}`).join('\n\n');

  return <div className="release-notes-stack">
    <section className="panel release-notes-filters">
      <div className="panel-title">
        <div>
          <div className="title-with-count"><h2>Release Notes</h2><span>{rows.length} card(s)</span></div>
          <p className="muted-text">Filtre a homologação por período e projeto para preparar as publicações de terça e quinta.</p>
        </div>
      </div>
      <div className="release-filter-grid">
        <DateRangePicker
          startDate={filters.startDate}
          endDate={filters.endDate}
          onChange={(startDate, endDate) => setFilters((current) => ({ ...current, startDate, endDate }))}
        />
        <ProjectMultiSelect projects={projects} values={filters.projectKeys || []} onChange={(projectKeys) => setFilters((current) => ({ ...current, projectKeys }))} />
        <label>
          Ordenação
          <select value={filters.sortOrder} onChange={(event) => setFilters((current) => ({ ...current, sortOrder: event.target.value }))}>
            <option value="homologation">Data de homologação</option>
            <option value="summary-asc">Resumo: A → Z</option>
            <option value="summary-desc">Resumo: Z → A</option>
          </select>
        </label>
        <button type="button" className="filter-apply release-filter-apply" onClick={() => load(filters)} disabled={loading}>
          {loading ? 'Buscando...' : 'Buscar cards'}
        </button>
      </div>
      {error && <p className="export-error" role="alert">{error}</p>}
    </section>

    <section className="panel release-notes-panel">
      <div className="release-notes-toolbar">
        <div>
          <strong>{checkedVisible} de {visibleRows.length} visíveis validados</strong>
          <span>As marcações ficam salvas neste navegador.</span>
        </div>
        <div className="release-grid-filters" aria-label="Filtros da grid de Release Notes">
          <label>
            Filtrar por Epic
            <select value={epicFilter} onChange={(event) => setEpicFilter(event.target.value)}>
              <option value="">Todos os Epics</option>
              {epicOptions.map((option) => <option key={option.value} value={option.value}>{option.label}{option.key && option.key !== option.label ? ` (${option.key})` : ''}</option>)}
            </select>
          </label>
          <label>
            Agrupar por
            <select value={groupBy} onChange={(event) => setGroupBy(event.target.value)}>
              <option value="layer">Front/Back</option>
              <option value="epic">Epic</option>
            </select>
          </label>
        </div>
        <div>
          <button type="button" className="ghost compact-button" onClick={clearVisibleChecks} disabled={!checkedVisible}>Limpar validações</button>
          <button type="button" className="ghost compact-button" onClick={() => exportRows(allGroupedRows, 'todas')} disabled={!visibleRows.length}>Exportar tudo</button>
          <button type="button" className="primary" onClick={() => copy(allReleaseText, 'Release Notes copiadas!')} disabled={!visibleRows.length}>Copiar Release Notes</button>
        </div>
      </div>
      {copyStatus && <p className="release-copy-status" role="status">{copyStatus}</p>}
      <div className="release-groups">
        {groups.map((group) => {
          const expanded = !collapsedGroups.includes(group.key);
          const groupChecked = group.rows.every((row) => checkedKeys.includes(row.key));
          return <section className="release-group" key={group.key}>
            <header className="release-group-head">
              <button type="button" className="release-group-toggle" onClick={() => toggleGroup(group.key)} aria-expanded={expanded}>
                <span className={expanded ? 'release-chevron expanded' : 'release-chevron'}>›</span>
                <span className={groupBy === 'epic' ? 'release-epic-group-label' : `release-layer release-layer-${group.label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{group.label}</span>
                <strong>{group.rows.length} card(s)</strong>
              </button>
              <div>
                <button type="button" className="ghost compact-button" onClick={() => copy(group.rows.map((row) => row.releaseText).join('\n'), `${group.label} copiado!`)}>Copiar {group.label}</button>
                <button type="button" className="ghost compact-button" onClick={() => exportRows(group.rows, group.label)}>Exportar {group.label}</button>
              </div>
            </header>
            {expanded && <div className="release-notes-table-scroll">
              <table className="release-notes-table">
                <thead><tr>
                  <th className="release-check-cell"><input type="checkbox" checked={groupChecked} onChange={() => toggleGroupChecks(group.rows)} aria-label={`Marcar todos os cards ${group.label} como validados`} /></th>
                  <th>Número do Card</th><th>Epic do Card</th><th>Front/Back</th><th>Tipo</th><th>Status</th><th>Data de Homologação</th><th>Resumo do Card</th><th>Texto para copiar</th>
                </tr></thead>
                <tbody>{group.rows.map((row) => <tr key={row.key} className={checkedKeys.includes(row.key) ? 'release-row-checked' : ''}>
                  <td className="release-check-cell"><input type="checkbox" checked={checkedKeys.includes(row.key)} onChange={() => toggleChecked(row.key)} aria-label={`Marcar ${row.key} como validado`} /></td>
                  <td><button type="button" className="issue-link" onClick={() => router.open(`/browse/${encodeURIComponent(row.key)}`)}>{row.key}</button></td>
                  <td className="release-epic" title={row.parent || releaseCardEpic(row)}><strong>{releaseCardEpic(row)}</strong>{row.parentSummary && row.parentKey && <small>{row.parentKey}</small>}</td>
                  <td><span className={`release-layer release-layer-${row.layer.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{row.layer}</span></td>
                  <td><span className={`release-type release-type-${row.releaseType.toLowerCase()}`}>{row.releaseType}</span></td>
                  <td><span className={`badge ${statusClass(row.status)}`}>{row.status || 'Concluído'}</span></td>
                  <td>{formatDate(row.homologationDate)}</td>
                  <td className="release-summary" title={row.summary || ''}><span>{row.summary || '-'}</span></td>
                  <td><div className="release-copy-cell"><span>{row.releaseText}</span><button type="button" className="ghost compact-button" onClick={() => copy(row.releaseText, `${row.key} copiado!`)}>Copiar</button></div></td>
                </tr>)}</tbody>
              </table>
            </div>}
          </section>;
        })}
        {!visibleRows.length && !loading && !error && <div className="profile-table-empty">{rows.length ? 'Nenhum card corresponde ao filtro de Epic da grid.' : 'Nenhum card homologado no período e projeto selecionados.'}</div>}
        {loading && <div className="profile-table-empty">Carregando cards homologados...</div>}
      </div>
    </section>
  </div>;
}
