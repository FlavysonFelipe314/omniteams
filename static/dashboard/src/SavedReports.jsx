import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@forge/bridge';
import { normalizeReportConfig } from '../../../src/shared/saved-report-config.mjs';

export default function SavedReports({ config, onApply, disabled }) {
  const [reports, setReports] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [savedConfig, setSavedConfig] = useState(null);
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(null);
  const selected = reports.find((report) => report.id === selectedId);
  let changed = false;
  try { changed = savedConfig && JSON.stringify(normalizeReportConfig(config)) !== JSON.stringify(savedConfig); } catch { changed = Boolean(savedConfig); }

  async function refresh() {
    setBusy(true);
    setError('');
    try {
      setReports(await invoke('listSavedReports'));
      setReady(true);
    } catch {
      setError('Não foi possível carregar seus relatórios salvos. Tente novamente.');
    } finally { setBusy(false); }
  }
  useEffect(() => { refresh(); }, []);

  async function open(id) {
    if (!id) { setSelectedId(''); setSavedConfig(null); setMessage(''); return; }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const report = await invoke('getSavedReport', { id });
      const next = normalizeReportConfig(report.config);
      await onApply(next);
      setSelectedId(id);
      setSavedConfig(next);
      setMessage(`Relatório “${report.name}” aplicado.`);
    } catch (error) { setError(error.message || 'Não foi possível abrir o relatório.'); }
    finally { setBusy(false); }
  }

  function edit(mode) {
    setError('');
    setMessage('');
    try {
      // Capture the settings at the moment the user opens the save dialog.
      const snapshot = mode === 'delete' ? null : normalizeReportConfig(config);
      setDialog({ mode, snapshot, name: mode === 'new' ? '' : selected.name, id: mode === 'new' ? undefined : selected.id });
    } catch (error) { setError(error.message); }
  }

  async function submit(name) {
    setBusy(true);
    setError('');
    try {
      if (dialog.mode === 'delete') {
        await invoke('deleteSavedReport', { id: dialog.id });
        setReports((current) => current.filter((report) => report.id !== dialog.id));
        setSelectedId('');
        setSavedConfig(null);
        setMessage('Relatório excluído. Os filtros atuais continuam disponíveis.');
      } else {
        const report = await invoke('saveReport', { id: dialog.id, name, config: dialog.snapshot });
        setReports((current) => [...current.filter((item) => item.id !== report.id), report].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')));
        setSelectedId(report.id);
        setSavedConfig(report.config);
        setMessage(`Relatório “${report.name}” salvo.`);
      }
      setDialog(null);
    } catch (error) { setError(error.message || 'Não foi possível salvar a alteração. Tente novamente.'); }
    finally { setBusy(false); }
  }

  return <section className="saved-reports panel" aria-label="Relatórios Salvos">
    <div className="saved-reports-controls">
      <label>Relatórios Salvos
        <select aria-label="Selecionar Relatório Salvo" value={selectedId} onChange={(event) => open(event.target.value)} disabled={busy || disabled || !ready}>
          <option value="">{busy && !ready ? 'Carregando relatórios…' : reports.length ? 'Selecione um relatório' : 'Nenhum relatório salvo'}</option>
          {reports.map((report) => <option key={report.id} value={report.id}>{report.name}</option>)}
        </select>
      </label>
      <button className="primary" disabled={busy || disabled || !ready} onClick={() => edit('new')}>Salvar como Novo</button>
      <button className="ghost" disabled={busy || disabled || !selected} onClick={() => edit('update')}>Atualizar Salvo</button>
      <button className="ghost" disabled={busy || disabled || !selected} onClick={() => open(selectedId)}>Reaplicar</button>
      <button className="ghost" disabled={busy || disabled || !selected} onClick={() => edit('delete')}>Excluir</button>
      {error && !dialog && <button className="ghost" disabled={busy} onClick={refresh}>Atualizar Lista</button>}
    </div>
    <p className="muted-text">Seus filtros salvos, disponíveis para você neste Jira. As datas são mantidas como foram salvas.</p>
    {changed && <p className="saved-report-changed">Filtros alterados — use “Atualizar Salvo” para guardar as mudanças.</p>}
    {message && <p role="status">{message}</p>}
    {error && !dialog && <p role="alert" className="export-error">{error}</p>}
    {dialog && <SaveReportDialog dialog={dialog} busy={busy} error={error} onClose={() => { if (!busy) { setDialog(null); setError(''); } }} onSubmit={submit} />}
  </section>;
}

function SaveReportDialog({ dialog, busy, error, onClose, onSubmit }) {
  const [name, setName] = useState(dialog.name);
  const container = useRef(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    (container.current.querySelector('input') || container.current.querySelector('button'))?.focus();
    return () => previousFocus?.focus();
  }, []);
  const deleting = dialog.mode === 'delete';
  function keyDown(event) {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') {
      const elements = [...container.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  return createPortal(<div className="modal-backdrop">
    <form ref={container} className="modal saved-report-dialog" role="dialog" aria-modal="true" aria-labelledby="saved-report-title" onKeyDown={keyDown} onSubmit={(event) => { event.preventDefault(); if (!busy) onSubmit(name.trim()); }}>
      <div className="modal-head">
        <h2 id="saved-report-title">{deleting ? 'Excluir Relatório' : dialog.mode === 'new' ? 'Salvar Novo Relatório' : 'Atualizar Relatório'}</h2>
        <button type="button" className="icon-button ghost" aria-label="Fechar" disabled={busy} onClick={onClose}>×</button>
      </div>
      {deleting ? <p>Excluir o relatório “{dialog.name}”? Essa ação remove apenas a configuração salva.</p> : <>
        <label>Nome do Relatório<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Pessoa por Projeto" maxLength={80} required disabled={busy} /></label>
        <p className="muted-text">Salva período, colaboradores, filtros, aba atual e colunas de exportação. Os dados do Jira são atualizados ao abrir o relatório.</p>
      </>}
      {error && <p role="alert" className="export-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancelar</button>
        <button className={deleting ? 'danger-button' : 'primary'} disabled={busy || (!deleting && !name.trim())}>{busy ? 'Aguarde…' : deleting ? 'Excluir' : 'Salvar'}</button>
      </div>
    </form>
  </div>, document.body);
}
