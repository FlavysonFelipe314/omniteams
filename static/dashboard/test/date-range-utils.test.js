import test from 'node:test';
import assert from 'node:assert/strict';
import { datePreset, formatDateInput, monthGrid, parseDateInput } from '../src/date-range-utils.js';

test('aceita data digitada em formato brasileiro e ISO', () => {
  assert.equal(parseDateInput('08/09/2026'), '2026-09-08');
  assert.equal(parseDateInput('2026-09-08'), '2026-09-08');
  assert.equal(formatDateInput('2026-09-08'), '08/09/2026');
  assert.equal(parseDateInput('31/02/2026'), '');
});

test('gera atalhos de período inclusivos', () => {
  assert.deepEqual(datePreset('last7', '2026-09-08'), { startDate: '2026-09-02', endDate: '2026-09-08' });
  assert.deepEqual(datePreset('currentWeek', '2026-09-08'), { startDate: '2026-09-07', endDate: '2026-09-13' });
  assert.deepEqual(datePreset('previousWeek', '2026-09-08'), { startDate: '2026-08-31', endDate: '2026-09-06' });
  assert.deepEqual(datePreset('currentMonth', '2026-09-08'), { startDate: '2026-09-01', endDate: '2026-09-30' });
});

test('calendário mensal mantém 6 semanas para navegação estável', () => {
  const days = monthGrid(2026, 8);
  assert.equal(days.length, 42);
  assert.equal(days.find((day) => day.date === '2026-09-01').outside, false);
  assert.equal(days[0].date, '2026-08-30');
});
