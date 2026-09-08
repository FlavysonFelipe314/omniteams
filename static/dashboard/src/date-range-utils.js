const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function utcDate(iso) {
  return new Date(`${iso}T12:00:00Z`);
}

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function isValidIsoDate(value) {
  if (!ISO_DATE.test(value || '')) return false;
  return toIso(utcDate(value)) === value;
}

export function parseDateInput(value) {
  const text = String(value || '').trim();
  if (isValidIsoDate(text)) return text;
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return '';
  const iso = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : '';
}

export function formatDateInput(value) {
  if (!isValidIsoDate(value)) return '';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

export function addDays(value, amount) {
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return toIso(date);
}

export function datePreset(kind, today = localToday()) {
  const current = utcDate(today);
  const day = current.getUTCDay();
  const mondayOffset = (day + 6) % 7;
  if (kind === 'last7') return { startDate: addDays(today, -6), endDate: today };
  if (kind === 'last31') return { startDate: addDays(today, -30), endDate: today };
  if (kind === 'currentWeek') {
    const startDate = addDays(today, -mondayOffset);
    return { startDate, endDate: addDays(startDate, 6) };
  }
  if (kind === 'previousWeek') {
    const endDate = addDays(today, -mondayOffset - 1);
    return { startDate: addDays(endDate, -6), endDate };
  }
  if (kind === 'currentMonth') {
    const year = current.getUTCFullYear();
    const month = current.getUTCMonth();
    return {
      startDate: toIso(new Date(Date.UTC(year, month, 1, 12))),
      endDate: toIso(new Date(Date.UTC(year, month + 1, 0, 12)))
    };
  }
  return { startDate: today, endDate: today };
}

export function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month, 1, 12));
  const firstCell = new Date(first);
  firstCell.setUTCDate(1 - first.getUTCDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(firstCell);
    date.setUTCDate(firstCell.getUTCDate() + index);
    return { date: toIso(date), day: date.getUTCDate(), outside: date.getUTCMonth() !== month };
  });
}
