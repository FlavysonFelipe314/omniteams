import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { buildXlsxArchive } from '../src/xlsx-utils.js';

test('gera um XLSX valido com cabecalho, filtros e tipos preservados', () => {
  const fields = [
    { key: 'name', label: 'Nome', value: (row) => row.name },
    { key: 'storyPoints', label: 'Story points', value: (row) => row.storyPoints }
  ];
  const archive = buildXlsxArchive(
    [{ name: 'QA & Desenvolvimento <Time>', storyPoints: 13 }],
    fields,
    new Date('2026-09-04T12:00:00.000Z')
  );
  const files = unzipSync(archive);

  assert.ok(files['[Content_Types].xml']);
  assert.ok(files['xl/workbook.xml']);
  assert.ok(files['xl/styles.xml']);
  assert.ok(files['xl/worksheets/sheet1.xml']);

  const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
  assert.match(sheet, /dimension ref="A1:B2"/);
  assert.match(sheet, /autoFilter ref="A1:B2"/);
  assert.match(sheet, /QA &amp; Desenvolvimento &lt;Time&gt;/);
  assert.match(sheet, /<c r="B2" s="2"><v>13<\/v><\/c>/);
});

test('recusa exportacao sem colunas', () => {
  assert.throws(() => buildXlsxArchive([], []), /ao menos uma coluna/);
});
