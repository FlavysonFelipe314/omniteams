import React, { useEffect, useMemo, useRef, useState } from 'react';
import { datePreset, formatDateInput, monthGrid, parseDateInput } from './date-range-utils.js';

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const PRESETS = [
  ['last7', 'Últimos 7 dias'],
  ['last31', 'Últimos 31 dias'],
  ['currentWeek', 'Semana Atual'],
  ['previousWeek', 'Semana Anterior'],
  ['currentMonth', 'Mês Atual']
];

function monthAnchor(value) {
  const date = parseDateInput(value) ? new Date(`${value}T12:00:00Z`) : new Date();
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}

function moveMonth(anchor, amount) {
  const date = new Date(Date.UTC(anchor.year, anchor.month + amount, 1, 12));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}

function monthLabel(year, month) {
  return new Date(Date.UTC(year, month, 1, 12)).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function CalendarMonth({ anchor, startDate, endDate, onSelect }) {
  return <section className="range-calendar-month" aria-label={monthLabel(anchor.year, anchor.month)}>
    <strong>{monthLabel(anchor.year, anchor.month)}</strong>
    <div className="range-calendar-weekdays">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div>
    <div className="range-calendar-days">{monthGrid(anchor.year, anchor.month).map((day) => {
      const selected = day.date === startDate || day.date === endDate;
      const inRange = Boolean(startDate && endDate && day.date > startDate && day.date < endDate);
      return <button
        type="button"
        key={day.date}
        className={`${day.outside ? 'outside' : ''} ${inRange ? 'in-range' : ''} ${selected ? 'selected' : ''}`}
        onClick={() => onSelect(day.date)}
        aria-pressed={selected}
      >{day.day}</button>;
    })}</div>
  </section>;
}

export default function DateRangePicker({ startDate, endDate, onChange }) {
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [startText, setStartText] = useState(formatDateInput(startDate));
  const [endText, setEndText] = useState(formatDateInput(endDate));
  const [draftStart, setDraftStart] = useState(startDate);
  const [draftEnd, setDraftEnd] = useState(endDate);
  const [anchor, setAnchor] = useState(monthAnchor(startDate));
  const [error, setError] = useState('');
  const nextAnchor = useMemo(() => moveMonth(anchor, 1), [anchor]);

  useEffect(() => {
    setStartText(formatDateInput(startDate));
    setEndText(formatDateInput(endDate));
    if (!open) { setDraftStart(startDate); setDraftEnd(endDate); }
  }, [startDate, endDate, open]);

  useEffect(() => {
    if (!open) return undefined;
    function closeOutside(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function closeEscape(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [open]);

  function showCalendar() {
    setDraftStart(startDate);
    setDraftEnd(endDate);
    setAnchor(monthAnchor(startDate));
    setError('');
    setOpen(true);
  }

  function commitTyped() {
    const parsedStart = parseDateInput(startText);
    const parsedEnd = parseDateInput(endText);
    if (!parsedStart || !parsedEnd) {
      setError('Use o formato dd/mm/aaaa.');
      return;
    }
    if (parsedStart > parsedEnd) {
      setError('A data inicial deve ser anterior à data final.');
      return;
    }
    setError('');
    setDraftStart(parsedStart);
    setDraftEnd(parsedEnd);
    onChange(parsedStart, parsedEnd);
  }

  function selectDate(date) {
    setError('');
    if (!draftStart || draftEnd) {
      setDraftStart(date);
      setDraftEnd('');
      return;
    }
    if (date < draftStart) {
      setDraftEnd(draftStart);
      setDraftStart(date);
    } else {
      setDraftEnd(date);
    }
  }

  function choosePreset(kind) {
    const range = datePreset(kind);
    setDraftStart(range.startDate);
    setDraftEnd(range.endDate);
    setAnchor(monthAnchor(range.startDate));
    setError('');
  }

  function apply() {
    if (!draftStart || !draftEnd) {
      setError('Selecione o início e o fim do período.');
      return;
    }
    setStartText(formatDateInput(draftStart));
    setEndText(formatDateInput(draftEnd));
    onChange(draftStart, draftEnd);
    setOpen(false);
  }

  return <div className="date-range-picker" ref={rootRef}>
    <span className="date-range-label">Período</span>
    <div className="date-range-inputs">
      <label><span>Início</span><input value={startText} inputMode="numeric" placeholder="dd/mm/aaaa" onFocus={showCalendar} onChange={(event) => setStartText(event.target.value)} onBlur={commitTyped} onKeyDown={(event) => event.key === 'Enter' && commitTyped()} /></label>
      <span className="date-range-arrow" aria-hidden="true">→</span>
      <label><span>Fim</span><input value={endText} inputMode="numeric" placeholder="dd/mm/aaaa" onFocus={showCalendar} onChange={(event) => setEndText(event.target.value)} onBlur={commitTyped} onKeyDown={(event) => event.key === 'Enter' && commitTyped()} /></label>
      <button type="button" className="date-range-trigger" onMouseDown={(event) => event.preventDefault()} onClick={showCalendar} aria-label="Abrir calendário" aria-expanded={open}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>
      </button>
    </div>
    {error && <small className="date-range-error" role="alert">{error}</small>}
    {open && <div className="date-range-popover">
      <div className="date-range-calendar-head">
        <button type="button" className="ghost" onClick={() => setAnchor((current) => moveMonth(current, -1))} aria-label="Meses anteriores">←</button>
        <span>Selecione o início e depois o fim</span>
        <button type="button" className="ghost" onClick={() => setAnchor((current) => moveMonth(current, 1))} aria-label="Próximos meses">→</button>
      </div>
      <div className="date-range-popover-body">
        <div className="date-range-calendars">
          <CalendarMonth anchor={anchor} startDate={draftStart} endDate={draftEnd} onSelect={selectDate} />
          <CalendarMonth anchor={nextAnchor} startDate={draftStart} endDate={draftEnd} onSelect={selectDate} />
        </div>
        <nav className="date-range-presets" aria-label="Períodos rápidos">
          {PRESETS.map(([key, label]) => <button type="button" key={key} onClick={() => choosePreset(key)}>{label}</button>)}
        </nav>
      </div>
      <div className="date-range-actions">
        <span>{draftStart ? formatDateInput(draftStart) : 'Início'} → {draftEnd ? formatDateInput(draftEnd) : 'Fim'}</span>
        <div><button type="button" className="ghost" onClick={() => setOpen(false)}>Cancelar</button><button type="button" onClick={apply}>Aplicar Período</button></div>
      </div>
    </div>}
  </div>;
}
