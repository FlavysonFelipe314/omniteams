export function parentIssue(fields = {}, epicFields = []) {
  const parent = fields.parent;
  const legacy = epicFields.map((id) => fields[id]).find(Boolean);
  const value = parent?.key ? parent : legacy;
  const key = typeof value === 'string' ? value : value?.key || '';
  const summary = typeof value === 'object' ? value?.fields?.summary || value?.summary || '' : '';
  return { parentKey: key, parentSummary: summary, parent: key ? [key, summary].filter(Boolean).join(' · ') : 'Sem Épico/Pai' };
}
