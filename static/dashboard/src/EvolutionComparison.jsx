import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@forge/bridge';
import DateRangePicker from './DateRangePicker.jsx';
import { dateRangeChunks, isRetryableInvocationError, roundNumber } from './report-utils.js';

const STORAGE_KEY = 'teamReportsEvolutionPeriodsV1';
const MIN_PERIODS = 3;
const MAX_PERIODS = 6;

function addDays(value, amount) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  return Math.max(1, Math.round((new Date(`${endDate}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`)) / 86_400_000) + 1);
}

function periodId(index = 0) {
  return `period-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
}

function defaultPeriods(startDate, endDate) {
  const safeEnd = endDate || new Date().toISOString().slice(0, 10);
  const safeStart = startDate && startDate <= safeEnd ? startDate : addDays(safeEnd, -6);
  const length = daysBetween(safeStart, safeEnd);
  return Array.from({ length: MIN_PERIODS }, (_, index) => {
    const distance = MIN_PERIODS - index - 1;
    return {
      id: periodId(index),
      startDate: addDays(safeStart, -(length * distance)),
      endDate: addDays(safeEnd, -(length * distance))
    };
  });
}

function storedPeriods(startDate, endDate) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (!Array.isArray(saved) || saved.length < MIN_PERIODS || saved.length > MAX_PERIODS) return defaultPeriods(startDate, endDate);
    const valid = saved.every((period) => period?.startDate && period?.endDate && period.startDate <= period.endDate);
    return valid ? saved.map((period, index) => ({ ...period, id: period.id || periodId(index) })) : defaultPeriods(startDate, endDate);
  } catch {
    return defaultPeriods(startDate, endDate);
  }
}

function mergeResponses(responses, accountIds) {
  const totals = Object.fromEntries(accountIds.map((accountId) => [accountId, 0]));
  responses.forEach((response) => {
    Object.entries(response.completedStoryPoints || {}).forEach(([accountId, value]) => {
      if (accountId in totals) totals[accountId] = roundNumber(totals[accountId] + Number(value || 0));
    });
  });
  return totals;
}

async function requestPeriod(scopeFilters, period, accountIds) {
  try {
    return [await invoke('getEvolutionData', {
      ...scopeFilters,
      accountIds,
      startDate: period.startDate,
      endDate: period.endDate
    })];
  } catch (error) {
    const days = daysBetween(period.startDate, period.endDate);
    if (!isRetryableInvocationError(error) || days <= 1) throw error;
    const chunks = dateRangeChunks(period.startDate, period.endDate, Math.ceil(days / 2));
    const responses = [];
    for (const chunk of chunks) responses.push(...await requestPeriod(scopeFilters, chunk, accountIds));
    return responses;
  }
}

async function loadInBatches(periods, scopeFilters, accountIds) {
  const results = [];
  for (let index = 0; index < periods.length; index += 2) {
    const batch = await Promise.all(periods.slice(index, index + 2).map(async (period) => ({
      period,
      totals: mergeResponses(await requestPeriod(scopeFilters, period, accountIds), accountIds)
    })));
    results.push(...batch);
  }
  return results;
}

function formatDate(value) {
  const [year, month, day] = String(value || '').split('-');
  return day && month && year ? `${day}/${month}/${year}` : value;
}

function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || '-';
  return `${parts[0]} ${parts.at(-1).slice(0, 1)}.`;
}

export default function EvolutionComparison({ scopeFilters, people }) {
  const [periods, setPeriods] = useState(() => storedPeriods(scopeFilters.startDate, scopeFilters.endDate));
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(true);
  const accountIds = useMemo(() => people.map((person) => person.accountId), [people]);
  const scopeSignature = JSON.stringify([
    scopeFilters.boardId,
    scopeFilters.sprintId,
    scopeFilters.sprintQuery,
    scopeFilters.jql,
    accountIds
  ]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(periods));
  }, [periods]);

  useEffect(() => {
    setResults([]);
    setEditing(true);
  }, [scopeSignature]);

  const chartPeriods = useMemo(() => results.map(({ period, totals }) => {
    const values = people.map((person) => ({
      accountId: person.accountId,
      name: person.name,
      value: Number(totals[person.accountId] || 0)
    }));
    const average = values.length ? roundNumber(values.reduce((sum, item) => sum + item.value, 0) / values.length) : 0;
    return { period, values, average, total: roundNumber(values.reduce((sum, item) => sum + item.value, 0)) };
  }), [results, people]);
  const maximum = Math.max(1, ...chartPeriods.flatMap((period) => [...period.values.map((item) => item.value), period.average]));

  function updatePeriod(id, startDate, endDate) {
    setPeriods((current) => current.map((period) => period.id === id ? { ...period, startDate, endDate } : period));
  }

  function addPeriod() {
    setPeriods((current) => {
      if (current.length >= MAX_PERIODS) return current;
      const previous = current.at(-1);
      const length = daysBetween(previous.startDate, previous.endDate);
      const startDate = addDays(previous.endDate, 1);
      return [...current, { id: periodId(current.length), startDate, endDate: addDays(startDate, length - 1) }];
    });
  }

  function removePeriod(id) {
    setPeriods((current) => current.length > MIN_PERIODS ? current.filter((period) => period.id !== id) : current);
  }

  async function generate() {
    if (periods.length < MIN_PERIODS || periods.length > MAX_PERIODS) {
      setError(`Selecione entre ${MIN_PERIODS} e ${MAX_PERIODS} períodos.`);
      return;
    }
    if (periods.some((period) => !period.startDate || !period.endDate || period.startDate > period.endDate)) {
      setError('Revise as datas: todo período precisa ter início e fim válidos.');
      return;
    }
    if (!accountIds.length) {
      setError('Selecione ao menos um colaborador para gerar a comparação.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      setResults(await loadInBatches(periods, scopeFilters, accountIds));
      setEditing(false);
    } catch (loadError) {
      console.error(loadError);
      setResults([]);
      setError(loadError.message || 'Não foi possível gerar a evolução dos períodos.');
    } finally {
      setLoading(false);
    }
  }

  return <section className="panel evolution-panel">
    <div className="panel-title evolution-title">
      <div>
        <div className="title-with-count"><h2>Evolução de Story Points Concluídos</h2><span>{periods.length} períodos</span></div>
        <p className="muted-text">Compare de 3 a 6 intervalos usando os colaboradores e o escopo selecionados.</p>
      </div>
      <button type="button" className="ghost compact-button" onClick={() => setEditing((current) => !current)}>
        {editing ? 'Ocultar períodos' : 'Editar períodos'}
      </button>
    </div>

    {editing && <div className="evolution-editor">
      <div className="evolution-periods">
        {periods.map((period, index) => <div className="evolution-period" key={period.id}>
          <div className="evolution-period-head">
            <strong>Período {index + 1}</strong>
            <button type="button" className="ghost" onClick={() => removePeriod(period.id)} disabled={periods.length <= MIN_PERIODS} aria-label={`Remover período ${index + 1}`}>Remover</button>
          </div>
          <DateRangePicker startDate={period.startDate} endDate={period.endDate} onChange={(startDate, endDate) => updatePeriod(period.id, startDate, endDate)} />
        </div>)}
      </div>
      <div className="evolution-actions">
        <button type="button" className="ghost" onClick={addPeriod} disabled={periods.length >= MAX_PERIODS}>Adicionar período</button>
        <button type="button" className="primary" onClick={generate} disabled={loading}>{loading ? 'Gerando comparação...' : 'Gerar gráfico'}</button>
      </div>
    </div>}

    {error && <p className="export-error" role="alert">{error}</p>}
    {!results.length && !editing && !loading && <p className="muted-text evolution-empty">Edite os períodos e gere o gráfico para visualizar a evolução.</p>}
    {chartPeriods.length > 0 && <div className="evolution-chart-scroll">
      <div className="evolution-chart" style={{ minWidth: `${Math.max(720, chartPeriods.length * (people.length + 1) * 64)}px` }}>
        {chartPeriods.map((period, periodIndex) => <div className="evolution-chart-group" key={period.period.id}>
          <div className="evolution-bars">
            {[...period.values, { accountId: 'average', name: 'Média', value: period.average, average: true }].map((item) => <div className="evolution-bar-item" key={`${period.period.id}-${item.accountId}`} title={`${item.name}: ${item.value} SP concluídos`}>
              <strong>{item.value}</strong>
              <div className="evolution-bar-track"><i className={item.average ? 'average' : ''} style={{ height: `${(item.value / maximum) * 100}%` }} /></div>
              <span>{item.average ? 'Média' : shortName(item.name)}</span>
            </div>)}
          </div>
          <div className="evolution-period-label">
            <strong>Período {periodIndex + 1}</strong>
            <span>{formatDate(period.period.startDate)} – {formatDate(period.period.endDate)}</span>
            <small>{period.total} SP concluídos</small>
          </div>
        </div>)}
      </div>
    </div>}
  </section>;
}
