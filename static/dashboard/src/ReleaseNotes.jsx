import React, { useEffect, useMemo, useState } from 'react';
import { invoke, router } from '@forge/bridge';
import DateRangePicker from './DateRangePicker.jsx';
import { dateRangeChunks, isRetryableInvocationError } from './report-utils.js';
import { buildReleaseNoteRows } from '../../../src/shared/release-notes.mjs';

const FILTERS_STORAGE_KEY = 'teamReportsReleaseNotesFiltersV1';
const CHECKS_STORAGE_KEY = 'teamReportsReleaseNotesChecksV1';

function localIso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function defaultFilters() {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return { startDate: localIso(monday), endDate: localIso(today), projectKey: '' };
}

function storedFilters() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(FILTERS_STORAGE_KEY) || 'null');
    return saved && typeof saved === 'object' ? { ...defaultFilters(), ...saved } : defaultFilters();
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

export default function ReleaseNotes({ projects }) {
  const [filters, setFilters] = useState(storedFilters);
  const [issues, setIssues] = useState([]);
  const [checkedKeys, setCheckedKeys] = useState(storedChecks);
  const [dateSource, setDateSource] = useState('homologation');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const rows = useMemo(() => buildReleaseNoteRows(issues), [issues]);
  const visibleKeys = rows.map((row) => row.key);
  const checkedVisible = visibleKeys.filter((key) => checkedKeys.includes(key)).length;
  const allChecked = rows.length > 0 && checkedVisible === rows.length;

  useEffect(() => {
    window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
  }, [filters]);

  useEffect(() => {
    window.localStorage.setItem(CHECKS_STORAGE_KEY, JSON.stringify(checkedKeys));
  }, [checkedKeys]);

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
      setDateSource(responses.some((response) => response.dateSource === 'homologation') ? 'homologation' : 'resolution');
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

  function toggleAll() {
    setCheckedKeys((current) => allChecked
      ? current.filter((key) => !visibleKeys.includes(key))
      : [...new Set([...current, ...visibleKeys])]);
  }

  function clearVisibleChecks() {
    setCheckedKeys((current) => current.filter((key) => !visibleKeys.includes(key)));
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
        <label>
          Projeto
          <select value={filters.projectKey} onChange={(event) => setFilters((current) => ({ ...current, projectKey: event.target.value }))}>
            <option value="">Todos os projetos</option>
            {projects.map((project) => <option key={project.key} value={project.key}>{project.name} ({project.key})</option>)}
          </select>
        </label>
        <button type="button" className="filter-apply release-filter-apply" onClick={() => load(filters)} disabled={loading}>
          {loading ? 'Buscando...' : 'Buscar cards'}
        </button>
      </div>
      {dateSource === 'resolution' && !loading && <p className="release-source-warning">O campo “Data de Homologação” não foi encontrado. A listagem está usando a data de resolução do Jira.</p>}
      {error && <p className="export-error" role="alert">{error}</p>}
    </section>

    <section className="panel release-notes-panel">
      <div className="release-notes-toolbar">
        <div>
          <strong>{checkedVisible} de {rows.length} validados</strong>
          <span>As marcações ficam salvas neste navegador.</span>
        </div>
        <div>
          <button type="button" className="ghost compact-button" onClick={clearVisibleChecks} disabled={!checkedVisible}>Limpar validações</button>
          <button type="button" className="primary" onClick={() => copy(rows.map((row) => row.releaseText).join('\n'), 'Release Notes copiadas!')} disabled={!rows.length}>Copiar Release Notes</button>
        </div>
      </div>
      {copyStatus && <p className="release-copy-status" role="status">{copyStatus}</p>}
      <div className="release-notes-table-scroll">
        <table className="release-notes-table">
          <thead><tr>
            <th className="release-check-cell"><input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Marcar todos os cards como validados" /></th>
            <th>Número do Card</th><th>Front/Back</th><th>Tipo</th><th>Epic</th><th>Data de Homologação</th><th>Resumo do Card</th><th>Texto para copiar</th>
          </tr></thead>
          <tbody>
            {rows.map((row) => <tr key={row.key} className={checkedKeys.includes(row.key) ? 'release-row-checked' : ''}>
              <td className="release-check-cell"><input type="checkbox" checked={checkedKeys.includes(row.key)} onChange={() => toggleChecked(row.key)} aria-label={`Marcar ${row.key} como validado`} /></td>
              <td><button type="button" className="issue-link" onClick={() => router.open(`/browse/${encodeURIComponent(row.key)}`)}>{row.key}</button></td>
              <td><span className={`release-layer release-layer-${row.layer.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{row.layer}</span></td>
              <td><span className={`release-type release-type-${row.releaseType.toLowerCase()}`}>{row.releaseType}</span></td>
              <td className="release-epic" title={row.parent || ''}>{row.parent || 'Sem Epic'}</td>
              <td>{formatDate(row.homologationDate)}</td>
              <td className="release-summary" title={row.summary || ''}>{row.summary || '-'}</td>
              <td><div className="release-copy-cell"><span>{row.releaseText}</span><button type="button" className="ghost compact-button" onClick={() => copy(row.releaseText, `${row.key} copiado!`)}>Copiar</button></div></td>
            </tr>)}
            {!rows.length && !loading && !error && <tr><td colSpan="8" className="profile-table-empty">Nenhum card homologado no período e projeto selecionados.</td></tr>}
            {loading && <tr><td colSpan="8" className="profile-table-empty">Carregando cards homologados...</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  </div>;
}
