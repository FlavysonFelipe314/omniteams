export function jqlLiteral(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function boardScope(value) {
  const raw = String(value || '').trim();
  if (!raw) return { type: 'all' };
  if (raw.startsWith('board:')) return { type: 'board', id: raw.slice('board:'.length) };
  if (raw.startsWith('project:')) return { type: 'project', key: raw.slice('project:'.length) };
  if (/^\d+$/.test(raw)) return { type: 'board', id: raw };
  return { type: 'project', key: raw };
}
