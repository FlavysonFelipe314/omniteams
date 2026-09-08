import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@forge/bridge';
import { dateRangeChunks, roundNumber } from './report-utils.js';
import { buildTimesheet } from '../../../src/shared/timesheet.mjs';

export default function ManagementTimesheet({ scope, reports, people, filters, setFilters, onPeople, onIssues }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const query = JSON.stringify({ boardId: scope.boardId, sprintId: scope.sprintId, sprintQuery: scope.sprintQuery, jql: scope.jql, startDate: scope.startDate, endDate: scope.endDate });
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(''); setData(null);
    async function requestChunk(base, chunk) {
      try { return [await invoke('getTimesheetData', { ...base, ...chunk })]; }
      catch (error) {
        const days = Math.round((new Date(chunk.endDate) - new Date(chunk.startDate)) / 86400000) + 1;
        if (days <= 1 || !/payload size|timed out|timeout/i.test(error.message || '')) throw error;
        const results = [];
        for (const part of dateRangeChunks(chunk.startDate, chunk.endDate, Math.ceil(days / 2))) {
          if (cancelled) return [];
          results.push(...await requestChunk(base, part));
        }
        return results;
      }
    }
    async function load() {
      try {
        const base = JSON.parse(query);
        if (!base.startDate || !base.endDate || base.startDate > base.endDate) throw new Error('Selecione um período válido.');
        const chunks = dateRangeChunks(base.startDate, base.endDate, 14);
        const responses = [];
        for (let index = 0; index < chunks.length; index += 3) {
          if (cancelled) return;
          responses.push(...(await Promise.all(chunks.slice(index, index + 3).map((chunk) => requestChunk(base, chunk)))).flat());
        }
        if (cancelled) return;
        const combined = { entries: responses.flatMap((r) => r.entries), issues: responses.flatMap((r) => r.issues) };
        onPeople([...new Map(responses.flatMap((r) => r.collaborators).map((person) => [person.accountId, person])).values()]);
        onIssues(combined.issues);
        setData(combined);
      } catch (error) { if (!cancelled) setError(error.message || 'Não foi possível carregar as horas.'); }
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [query, reports, retry, onPeople, onIssues]);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const matrix = useMemo(() => buildTimesheet({ people, entries: data?.entries, issues: data?.issues, startDate: scope.startDate, endDate: scope.endDate, filters, today, weekdaysOnly: filters.weekdaysOnly !== false }), [people, data, scope.startDate, scope.endDate, filters, today]);
  const hours = (seconds) => `${roundNumber(seconds / 3600).toLocaleString('pt-BR')} h`;
  const missing = matrix.rows.filter((row) => matrix.days.some((day) => !day.future && day.date < today && !day.weekend && !row.byDate[day.date])).length;
  return <section className="panel timesheet-panel" aria-label="Horas por Pessoa e Dia">
    <div className="panel-title"><div><h2>Horas por Pessoa e Dia</h2><p className="muted-text">Apontamentos no período e escopo selecionados. Total inclui todos os dias, inclusive fins de semana.</p></div>
      <label className="timesheet-weekdays"><input type="checkbox" checked={filters.weekdaysOnly !== false} onChange={(event) => setFilters((current) => ({ ...current, weekdaysOnly: event.target.checked }))} />Somente Dias Úteis</label>
    </div>
    {loading ? <p role="status">Carregando apontamentos…</p> : error ? <div role="alert"><p>{error}</p><button className="ghost" onClick={() => setRetry((value) => value + 1)}>Tentar Novamente</button></div> : <>
      <p className="muted-text">{missing} pessoa(s) com dias úteis passados sem apontamento neste filtro. Não considera férias, feriados ou jornada individual.</p>
      <div className="timesheet-scroll" tabIndex={0} role="region" aria-label="Grade de horas com rolagem horizontal">
        <table className="timesheet-table">
          <thead><tr><th scope="col">Colaborador</th><th scope="col">Total</th>{matrix.days.map((day) => <th scope="col" key={day.date} className={day.weekend ? 'timesheet-weekend' : ''}><span>{new Date(`${day.date}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short' })}</span><br />{new Date(`${day.date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</th>)}</tr></thead>
          <tbody>{matrix.rows.map((row) => <tr key={row.accountId}>
            <th scope="row" title={row.name}>{row.name}</th><td className="timesheet-total">{hours(row.seconds)}</td>
            {matrix.days.map((day) => {
              const seconds = row.byDate[day.date] || 0;
              const empty = !seconds && !day.future && !day.weekend && day.date < today;
              return <td key={day.date} className={seconds ? 'timesheet-logged' : empty ? 'timesheet-missing' : 'timesheet-neutral'} title={`${row.name} — ${day.date}: ${seconds ? hours(seconds) : day.future ? 'Data futura' : day.weekend ? 'Fim de semana sem apontamento' : 'Sem apontamento'}`}>{seconds ? hours(seconds) : day.future || day.weekend ? '—' : '0 h'}</td>;
            })}
          </tr>)}</tbody>
          <tfoot><tr><th scope="row">Total Geral</th><td>{hours(matrix.rows.reduce((sum, row) => sum + row.seconds, 0))}</td>{matrix.days.map((day) => <td key={day.date}>{hours(matrix.rows.reduce((sum, row) => sum + (row.byDate[day.date] || 0), 0))}</td>)}</tr></tfoot>
        </table>
      </div>
      {!matrix.rows.length && <p>Nenhum colaborador selecionado ou disponível. Use “Buscar Colaborador” para incluir pessoas, mesmo sem apontamentos.</p>}
    </>}
  </section>;
}

export function TimesheetPeopleSearch({ onSelect }) {
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState([]);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let cancelled = false;
    setPeople([]);
    if (query.trim().length < 2) { setMessage(''); return; }
    setMessage('Buscando…');
    const timer = setTimeout(async () => {
      try {
        const result = await invoke('searchUsers', { query: query.trim() });
        if (!cancelled) { setPeople(result); setMessage(result.length ? '' : 'Nenhum colaborador encontrado.'); }
      } catch { if (!cancelled) setMessage('Não foi possível pesquisar. Tente novamente.'); }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);
  return <details className="timesheet-people-search"><summary>Buscar Colaborador</summary>
    <label>Nome do Colaborador<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Inclua pessoas mesmo sem horas no período" /></label>
    {message && <p role="status">{message}</p>}
    <div>{people.map((person) => <button key={person.accountId} className="ghost" onClick={() => { onSelect(person); setQuery(''); }}>{person.name}</button>)}</div>
  </details>;
}
