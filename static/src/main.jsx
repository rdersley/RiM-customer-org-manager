import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, view } from '@forge/bridge';
import '@retailinmotion/ui/css';
import { enableTheme } from '@retailinmotion/ui/theme';
import { AppHeader, Tabs, Card, Button, Notice, EmptyState, Loading, Lozenge, Field, Footer } from '@retailinmotion/ui/react';
import { organisationNote, lookupOrganisations, attachOrganisationIds, loadAllOrganisations } from './organisations.js';
import OrgSync from './OrgSync.jsx';
import BackupRestore from './BackupRestore.jsx';
import { submitAndFinaliseBatch, problemRowsCsv, recheckNotFound, isTaskLimitError, TASK_LIMIT_WAIT } from './importBatch.js';
import { importImpact, importSafeguard, typedConfirmationMatches } from './safeguards.js';
import { parseCsvTable, guessMapping, missingMappingFields, mappingFits, applyMapping, pickSavedMapping, sameMapping, toSaved, fromSaved, MAPPING_FIELDS } from './csv.js';
import { checkDetails, mergeValidation, detailCount, detailSummary } from './details.js';

// Injected by vite.config.js from the root package.json.
const APP_VERSION = __APP_VERSION__;
const tabs = ['Customers', 'Organisations', 'Import', 'Import History', 'Organisation sync', 'Backup & restore'];

function validateRowsLocally(rows) {
  const seen = new Set();
  const errors = [];
  rows.forEach((row, index) => {
    const email = String(row.email || '').trim().toLowerCase();
    const displayName = String(row.displayName || row.fullName || '').trim();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) errors.push({ row: index + 2, field: 'email', message: 'Valid email required' });
    if (!displayName) errors.push({ row: index + 2, field: 'displayName', message: 'Display name required' });
    if (email && seen.has(email)) errors.push({ row: index + 2, field: 'email', message: 'Duplicate email in file' });
    if (email) seen.add(email);
  });
  const invalidRowCount = new Set(errors.map((e) => e.row)).size;
  return { total: rows.length, valid: Math.max(0, rows.length - invalidRowCount), errors };
}

function invalidRowMap(validationResult) {
  const invalidRows = new Map();
  (validationResult?.errors || []).forEach((e) => {
    const idx = e.row - 2;
    if (!invalidRows.has(idx)) invalidRows.set(idx, []);
    invalidRows.get(idx).push(e.message);
  });
  return invalidRows;
}

function makeSessionId() {
  return globalThis.crypto?.randomUUID?.() || `import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) throw new Error('This browser cannot create the secure import fingerprint required for recovery.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function App() {
  const [tab, setTab] = useState('Customers');
  const [serviceDesks, setServiceDesks] = useState([]);
  const [desk, setDesk] = useState('');
  const [customers, setCustomers] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [customerQuery, setCustomerQuery] = useState('');
  const [orgQuery, setOrgQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // null until known; the app is read-only when the site has no active licence (see src/license.js).
  const [appStatus, setAppStatus] = useState(null);
  const readOnly = appStatus?.licensed === false;
  const [rows, setRows] = useState([]);
  const [validation, setValidation] = useState(null);
  const [preview, setPreview] = useState([]);
  const [previewing, setPreviewing] = useState(false);
  const [comparisonProgress, setComparisonProgress] = useState(null);
  const [importStatus, setImportStatus] = useState(null);
  const [lastPlan, setLastPlan] = useState(null);
  const [rechecking, setRechecking] = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const [resumePlan, setResumePlan] = useState(null);
  const [history, setHistory] = useState([]);
  const [importSessions, setImportSessions] = useState([]);
  const [csvInfo, setCsvInfo] = useState(null);
  // Column mapping: the parsed file, the columns chosen for each field, and the mapping the preview used.
  const [csvTable, setCsvTable] = useState(null);
  const [mapping, setMapping] = useState(null);
  // The site's customer detail fields (empty when the site has none, or before a file is chosen).
  const [detailFields, setDetailFields] = useState([]);
  const [detailFieldsError, setDetailFieldsError] = useState('');
  const [appliedMapping, setAppliedMapping] = useState(null);
  const [mappingSource, setMappingSource] = useState('');
  const [savedMappings, setSavedMappings] = useState([]);
  const [mappingName, setMappingName] = useState('');
  const [mappingMessage, setMappingMessage] = useState(null);
  // Large imports are confirmed first (static/src/safeguards.js).
  const [confirmingImport, setConfirmingImport] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [fileFingerprint, setFileFingerprint] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const r = await invoke('getServiceDesks');
        setServiceDesks(r.values || []);
        if (r.values?.[0]) setDesk(String(r.values[0].id));
      } catch (e) { setError(e.message); }
    })();
    invoke('getAppStatus').then(setAppStatus).catch(() => {});
  }, []);

  useEffect(() => { if (tab === 'Organisations') loadOrgs(); }, [tab]);
  useEffect(() => { if (tab === 'Customers' && desk) loadCustomers(); }, [tab, desk]);
  useEffect(() => { if (tab === 'Import History') loadHistory(); }, [tab]);

  async function ensureDeskId() {
    if (desk) return String(desk);
    const existing = serviceDesks?.[0]?.id;
    if (existing !== undefined && existing !== null && String(existing)) {
      const id = String(existing);
      setDesk(id);
      return id;
    }
    const r = await invoke('getServiceDesks');
    const desks = r.values || [];
    setServiceDesks(desks);
    const id = String(desks?.[0]?.id || '');
    if (!id) throw new Error('No Jira service projects are available.');
    setDesk(id);
    return id;
  }

  async function loadCustomers(query = customerQuery) {
    setLoading(true); setError('');
    try {
      const serviceDeskId = await ensureDeskId();
      const r = await invoke('getCustomers', { serviceDeskId, query });
      setCustomers(r.values || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function loadOrgs() {
    setLoading(true); setError('');
    try {
      await loadAllOrganisations(invoke, (list) => setOrgs([...list]));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function loadHistory() {
    try {
      const [h, sessions] = await Promise.all([invoke('getImportHistory'), invoke('getImportSessions')]);
      const enriched = await Promise.all(h.map(async (x) => {
        try { return { ...x, task: await invoke('getTaskStatus', { taskId: x.taskId }) }; }
        catch { return x; }
      }));
      setHistory(enriched);
      setImportSessions(sessions || []);
    } catch (e) { setError(e.message); }
  }

  // An existing customer whose name already matches: skipped, unless the row sets customer details.
  function sameNameResult(row, i, orgNote) {
    const n = detailCount(row);
    if (!n) return { ...row, rowNumber: i + 2, action: 'SKIP', reason: orgNote ? `Customer already matches. ${orgNote}` : 'Customer already matches Jira.' };
    return { ...row, rowNumber: i + 2, action: 'UPDATE', nameUnchanged: true, reason: `Name already matches; sets ${n === 1 ? '1 customer detail' : `${n} customer details`}. ${orgNote}`.trim() };
  }

  async function buildPreview(parsed, validationResult) {
    if (!parsed.length) { setPreview([]); return; }
    setPreviewing(true); setError('');
    try {
      const serviceDeskId = await ensureDeskId();
      const { found: existingOrgs } = await lookupOrganisations(invoke, parsed.map((row) => row.organisation));
      const orgNames = new Set(existingOrgs.keys());
      const invalidRows = invalidRowMap(validationResult);
      const results = parsed.map((row, i) => invalidRows.has(i)
        ? { ...row, rowNumber: i + 2, action: 'ERROR', reason: invalidRows.get(i).join('; ') }
        : null);

      const validIndexes = [];
      for (let i = 0; i < parsed.length; i++) if (!invalidRows.has(i)) validIndexes.push(i);

      for (const i of validIndexes) {
        const row = parsed[i];
        try {
          const found = await invoke('getCustomers', { serviceDeskId, query: String(row.email || '').trim() });
          const exact = (found.values || []).find((c) => String(c.emailAddress || '').toLowerCase() === String(row.email || '').trim().toLowerCase());
          const orgNote = organisationNote(row, orgNames);
          results[i] = !exact
            ? { ...row, rowNumber: i + 2, action: 'CREATE', reason: orgNote || 'New customer.' }
            : String(exact.displayName || '').trim().toLowerCase() === String(row.displayName || '').trim().toLowerCase()
              ? sameNameResult(row, i, orgNote)
              : { ...row, rowNumber: i + 2, action: 'UPDATE', reason: `Existing Jira customer: ${exact.displayName || exact.emailAddress}. ${orgNote}`.trim() };
        } catch (e) {
          results[i] = { ...row, rowNumber: i + 2, action: 'ERROR', reason: `Jira lookup failed: ${e.message}` };
        }
      }
      setPreview(results.filter(Boolean));
    } catch (e) {
      setError(`Preview failed: ${e.message}`);
      setPreview([]);
    } finally { setPreviewing(false); }
  }

  async function buildLargePreview(parsed, validationResult) {
    const invalidRows = invalidRowMap(validationResult);
    const pendingPreview = parsed.map((row, i) => invalidRows.has(i)
      ? { ...row, rowNumber: i + 2, action: 'ERROR', reason: invalidRows.get(i).join('; ') }
      : { ...row, rowNumber: i + 2, action: 'PENDING', reason: 'Waiting for batched Jira comparison.' });
    setPreview(pendingPreview);

    setPreviewing(true);
    setComparisonProgress({ complete: false, customersScanned: 0, batches: 0 });
    setError('');
    try {
      const serviceDeskId = await ensureDeskId();
      const byEmail = new Map();
      let start = 0;
      let complete = false;
      let batches = 0;

      while (!complete) {
        if (batches >= 200) throw new Error('Customer index safety limit reached before Jira reported the final page.');
        const batch = await invoke('getCustomerIndexBatch', { serviceDeskId, start, pages: 10 });
        (batch.customers || []).forEach((customer) => {
          const email = String(customer.emailAddress || '').trim().toLowerCase();
          if (email) byEmail.set(email, customer);
        });
        batches += 1;
        complete = Boolean(batch.complete);
        const nextStart = Number(batch.nextStart || 0);
        if (!complete && (!Number.isFinite(nextStart) || nextStart <= start)) {
          throw new Error('Jira customer pagination stopped before the comparison was complete.');
        }
        start = nextStart;
        setComparisonProgress({ complete: false, customersScanned: byEmail.size, batches });
      }

      const validRows = parsed.filter((_, i) => !invalidRows.has(i));
      const { found: existingOrgs } = await lookupOrganisations(invoke, validRows.map((row) => row.organisation));
      const orgNames = new Set(existingOrgs.keys());
      const results = parsed.map((row, i) => {
        if (invalidRows.has(i)) return { ...row, rowNumber: i + 2, action: 'ERROR', reason: invalidRows.get(i).join('; ') };
        const email = String(row.email || '').trim().toLowerCase();
        const exact = byEmail.get(email);
        const orgNote = organisationNote(row, orgNames);
        if (!exact) return { ...row, rowNumber: i + 2, action: 'CREATE', reason: orgNote || 'New customer.' };
        if (String(exact.displayName || '').trim().toLowerCase() === String(row.displayName || '').trim().toLowerCase()) return sameNameResult(row, i, orgNote);
        return { ...row, rowNumber: i + 2, action: 'UPDATE', reason: `Existing Jira customer: ${exact.displayName || exact.emailAddress}. ${orgNote}`.trim() };
      });
      setPreview(results);
      setComparisonProgress({ complete: true, customersScanned: byEmail.size, batches });
    } catch (e) {
      setError(`Large import comparison failed: ${e.message}`);
      setComparisonProgress((current) => ({ ...(current || {}), failed: true }));
    } finally {
      setPreviewing(false);
    }
  }

  async function restoreRecoveryForFile(parsedRows, session, usedMapping) {
    if (!session) return;
    if (session.mapping && !sameMapping(fromSaved(session.mapping), usedMapping)) {
      const m = fromSaved(session.mapping);
      const name = m.displayName || [m.firstName, m.lastName].filter(Boolean).join(' + ');
      const details = Object.entries(m.details || {}).map(([field, column]) => `, ${field}: ${column}`).join('');
      throw new Error(`This file has an interrupted import that used different columns (Email: ${m.email}, Full name: ${name}${m.organisation ? `, Organisation: ${m.organisation}` : ''}${details}). Choose those columns to resume it.`);
    }

    const rowNumbers = Array.isArray(session.actionableRowNumbers) ? session.actionableRowNumbers.map(Number) : [];
    if (!rowNumbers.length || Number(session.totalRows) !== rowNumbers.length) {
      throw new Error('A saved import session matched this file, but its recovery row plan is incomplete. Start a new import rather than guessing.');
    }

    const recoveryRows = rowNumbers.map((rowNumber) => {
      const row = parsedRows[rowNumber - 2];
      if (!row) throw new Error(`Saved recovery row ${rowNumber} is not present in this CSV.`);
      return { ...row, rowNumber };
    });
    // Recovery discovery must not change Jira: organisations are resolved (and created) only when Resume is clicked.
    const chunks = [];
    for (let i = 0; i < recoveryRows.length; i += 100) chunks.push(recoveryRows.slice(i, i + 100));
    if (chunks.length !== Number(session.totalBatches)) throw new Error('Saved recovery batch count does not match this CSV. Resume has been blocked.');

    // A batch is done once it has been finalised (added to the project and organisations). Batches saved
    // before finalising existed have no flag and count as done.
    const completed = new Set((session.batches || []).filter((b) => b.finalised !== false).map((b) => Number(b.batchNumber)));
    let nextBatchIndex = 0;
    while (nextBatchIndex < chunks.length && completed.has(nextBatchIndex + 1)) nextBatchIndex += 1;
    if (nextBatchIndex >= chunks.length) return;
    const tasks = (session.batches || []).filter((b) => Number(b.batchNumber) <= nextBatchIndex).map((b) => ({ ...b, submittedRows: Number(b.count || 0), problems: [] }));
    const plan = { sessionId: session.id, serviceDeskId: String(session.serviceDeskId), totalRows: recoveryRows.length, chunks, nextBatchIndex, tasks, recovered: true, organisationsPending: true };
    setResumePlan(plan);
    setImportProgress({
      state: 'recovered',
      sessionId: session.id,
      totalRows: recoveryRows.length,
      totalBatches: chunks.length,
      completedBatches: nextBatchIndex,
      completedRows: Number(session.submittedRows || 0),
      currentBatch: nextBatchIndex + 1,
      attempt: 1
    });
  }

  async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setError('');
    setComparisonProgress(null);
    setImportProgress(null);
    setResumePlan(null);
    setImportStatus(null);
    setRows([]);
    setPreview([]);
    setValidation(null);
    setAppliedMapping(null);
    setMappingMessage(null);
    const fileText = await f.text();
    const fingerprint = await sha256Hex(fileText);
    setFileFingerprint(fingerprint);
    const table = parseCsvTable(fileText);
    setCsvTable(table);
    setCsvInfo({ fileName: f.name, headers: table.headers });

    // Columns: an interrupted import's own mapping, else a saved mapping that fits, else a guess.
    let chosen = null;
    let source = '';
    let session = null;
    let fields = [];
    try {
      const serviceDeskId = await ensureDeskId();
      const [saved, recoverable, detail] = await Promise.all([
        invoke('getImportMappings').catch(() => []),
        invoke('findRecoverableImportSession', { fingerprint, serviceDeskId }),
        invoke('getCustomerDetailFields').catch((err) => ({ fields: [], error: err.message }))
      ]);
      session = recoverable;
      fields = detail?.fields || [];
      setDetailFields(fields);
      setDetailFieldsError(detail?.error || '');
      setSavedMappings(saved || []);
      if (session?.mapping && mappingFits(fromSaved(session.mapping), table.headers)) {
        chosen = fromSaved(session.mapping);
        source = 'The columns from the interrupted import of this file.';
      } else {
        const match = pickSavedMapping(saved, table.headers, serviceDeskId);
        if (match) { chosen = fromSaved(match); source = `Using the saved mapping "${match.name}".`; }
      }
    } catch (err) {
      setError(`Recovery check failed: ${err.message}`);
    }
    if (!chosen) {
      chosen = guessMapping(table.headers, fields);
      source = missingMappingFields(chosen, table.headers).length ? '' : 'Matched automatically from the column names.';
    }
    setMapping(chosen);
    setMappingSource(source);
    if (!missingMappingFields(chosen, table.headers).length) await previewWith(table, chosen, session, fields);
  }

  async function previewWith(table, chosen, session, fields = detailFields) {
    setError('');
    setComparisonProgress(null);
    setImportProgress(null);
    setResumePlan(null);
    setImportStatus(null);
    setAppliedMapping(chosen);
    setConfirmingImport(false);
    setTypedConfirmation('');
    // Detail values are checked against each field's type and options; a bad cell excludes the row.
    const { rows: parsedRows, errors: detailErrors } = checkDetails(applyMapping(table, chosen), fields);
    setRows(parsedRows);
    try {
      if (parsedRows.length > 500) {
        const result = mergeValidation(validateRowsLocally(parsedRows), detailErrors);
        setValidation(result);
        await buildLargePreview(parsedRows, result);
      } else {
        const result = mergeValidation(await invoke('validateImport', { rows: parsedRows.map(({ details, ...row }) => row) }), detailErrors);
        setValidation(result);
        await buildPreview(parsedRows, result);
      }
      await restoreRecoveryForFile(parsedRows, session, chosen);
    } catch (err) {
      setError(`CSV validation or recovery check failed: ${err.message}`);
    }
  }

  async function previewWithCurrentMapping() {
    let session = null;
    try { session = await invoke('findRecoverableImportSession', { fingerprint: fileFingerprint, serviceDeskId: await ensureDeskId() }); } catch { session = null; }
    await previewWith(csvTable, mapping, session);
  }

  async function saveMapping() {
    setMappingMessage(null);
    try {
      const existing = savedMappings.find((m) => m.name.trim().toLowerCase() === mappingName.trim().toLowerCase());
      const saved = await invoke('saveImportMapping', { id: existing?.id, name: mappingName, serviceDeskId: await ensureDeskId(), ...toSaved(mapping) });
      setSavedMappings((list) => [saved, ...list.filter((m) => m.id !== saved.id)]);
      setMappingMessage({ kind: 'success', text: `Mapping "${saved.name}" saved.` });
    } catch (e) { setMappingMessage({ kind: 'error', text: e.message }); }
  }

  async function deleteMapping(id) {
    try {
      await invoke('deleteImportMapping', { id });
      setSavedMappings((list) => list.filter((m) => m.id !== id));
    } catch (e) { setMappingMessage({ kind: 'error', text: e.message }); }
  }

  async function submitBatchWithRetry(plan, batchIndex, existingTasks) {
    const chunk = plan.chunks[batchIndex];
    const batchNumber = batchIndex + 1;
    let lastError;
    let limitWaits = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      setImportProgress({
        state: 'running',
        sessionId: plan.sessionId,
        totalRows: plan.totalRows,
        totalBatches: plan.chunks.length,
        completedBatches: batchIndex,
        completedRows: Math.min(batchIndex * 100, plan.totalRows),
        currentBatch: batchNumber,
        attempt
      });
      try {
        // Re-running a batch is safe: the bulk call reuses its idempotency key and membership adds are idempotent.
        return await submitAndFinaliseBatch(invoke, plan, batchIndex);
      } catch (e) {
        lastError = e;
        // Jira is still working through earlier tasks: wait a minute and try the same batch again. This
        // doesn't use up an attempt; after an hour the import pauses and can be resumed later.
        if (isTaskLimitError(e) && limitWaits < TASK_LIMIT_WAIT.maxWaits) {
          limitWaits += 1;
          attempt -= 1;
          setImportProgress({
            state: 'waiting',
            sessionId: plan.sessionId,
            totalRows: plan.totalRows,
            totalBatches: plan.chunks.length,
            completedBatches: batchIndex,
            completedRows: Math.min(batchIndex * 100, plan.totalRows),
            currentBatch: batchNumber,
            waited: limitWaits,
            maxWaits: TASK_LIMIT_WAIT.maxWaits
          });
          await new Promise((resolve) => setTimeout(resolve, TASK_LIMIT_WAIT.intervalMs));
          continue;
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
      }
    }
    const completedRows = existingTasks.reduce((sum, task) => sum + Number(task.submittedRows || 0), 0);
    const failedPlan = { ...plan, nextBatchIndex: batchIndex, tasks: existingTasks };
    setResumePlan(failedPlan);
    setImportProgress({
      state: 'failed',
      sessionId: plan.sessionId,
      totalRows: plan.totalRows,
      totalBatches: plan.chunks.length,
      completedBatches: existingTasks.length,
      completedRows,
      currentBatch: batchNumber,
      attempt: 3,
      error: lastError?.message || 'Batch submission failed'
    });
    throw new Error(`Batch ${batchNumber} of ${plan.chunks.length} failed after 3 attempts. ${lastError?.message || ''}`.trim());
  }

  async function submitPlan(plan, startBatchIndex = 0, initialTasks = []) {
    const tasks = [...initialTasks];
    for (let i = startBatchIndex; i < plan.chunks.length; i += 1) {
      const task = await submitBatchWithRetry(plan, i, tasks);
      tasks.push(task);
      const completedRows = tasks.reduce((sum, item) => sum + Number(item.submittedRows || 0), 0);
      setImportProgress({
        state: i === plan.chunks.length - 1 ? 'complete' : 'running',
        sessionId: plan.sessionId,
        totalRows: plan.totalRows,
        totalBatches: plan.chunks.length,
        completedBatches: i + 1,
        completedRows,
        currentBatch: i + 1,
        attempt: 1
      });
    }
    setResumePlan(null);
    return tasks;
  }

  // Rows that finished (in the project and their organisations) and the ones that didn't. Batches resumed
  // from an earlier run count as finished; their per-row detail isn't kept.
  function batchOutcome(tasks) {
    const problems = tasks.flatMap((t) => t.problems || []);
    const linked = tasks.reduce((n, t) => n + (t.linked ?? Math.max(0, Number(t.submittedRows || 0) - (t.problems || []).length)), 0);
    return { linked, problems };
  }

  // After the last batch: new accounts Jira hasn't indexed yet are re-checked for a few minutes.
  async function finishOutcome(plan, tasks) {
    let { linked, problems } = batchOutcome(tasks);
    setLastPlan(plan);
    if (problems.some((p) => p.status === 'not-found')) {
      const before = problems.length;
      problems = await recheckNotFound(invoke, plan, problems, {
        onProgress: ({ attempt, attempts, waiting }) => setImportProgress((p) => ({ ...p, state: 'rechecking', attempt, attempts, waiting }))
      });
      linked += before - problems.length;
      setImportProgress((p) => ({ ...p, state: 'complete' }));
    }
    return { linked, problems };
  }

  async function checkAgain() {
    setRechecking(true);
    try {
      const before = importStatus.problems.length;
      const problems = await recheckNotFound(invoke, lastPlan, importStatus.problems, { attempts: 1, waitMs: 0 });
      setImportStatus((st) => ({ ...st, problems, linked: st.linked + (before - problems.length) }));
    } catch (e) { setError(e.message); }
    finally { setRechecking(false); }
  }

  function downloadProblemRows() {
    const byNumber = new Map(rows.map((r, i) => [i + 2, r]));
    const blob = new Blob([problemRowsCsv(importStatus.problems, byNumber)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(csvInfo?.fileName || 'import').replace(/\.csv$/i, '')}-rows-to-fix.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function runImport() {
    setLoading(true); setError(''); setImportStatus(null); setResumePlan(null);
    try {
      if (preview.some((r) => r.action === 'PENDING')) {
        throw new Error('Valid rows are still waiting for Jira comparison. Error rows will be excluded automatically, but unchecked rows cannot be submitted yet.');
      }
      const actionable = preview.filter((r) => r.action === 'CREATE' || r.action === 'UPDATE');
      if (!actionable.length) throw new Error('There are no Create or Update rows to import.');
      if (!fileFingerprint) throw new Error('Import fingerprint is missing. Re-select the CSV before importing.');

      setImportProgress({ state: 'preparing', totalRows: actionable.length, totalBatches: Math.ceil(actionable.length / 100), completedBatches: 0, completedRows: 0 });
      const serviceDeskId = await ensureDeskId();
      const { rows: mapped, created } = await attachOrganisationIds(invoke, actionable);
      const chunks = [];
      for (let i = 0; i < mapped.length; i += 100) chunks.push(mapped.slice(i, i + 100));
      const sessionId = makeSessionId();
      const plan = { sessionId, serviceDeskId, totalRows: mapped.length, chunks };
      await invoke('startImportSession', {
        id: sessionId,
        fingerprint: fileFingerprint,
        serviceDeskId,
        fileName: csvInfo?.fileName || '',
        mapping: toSaved(appliedMapping),
        actionableRowNumbers: mapped.map((r) => r.rowNumber),
        totalRows: mapped.length,
        totalBatches: chunks.length,
        skipped: preview.filter((r) => r.action === 'SKIP').length,
        excludedErrors: preview.filter((r) => r.action === 'ERROR').length
      });
      const tasks = await submitPlan(plan);
      setImportStatus({
        submitted: mapped.length,
        tasks,
        ...(await finishOutcome(plan, tasks)),
        createdOrganizations: created.length,
        skipped: preview.filter((r) => r.action === 'SKIP').length,
        excludedErrors: preview.filter((r) => r.action === 'ERROR').length,
        sessionId: plan.sessionId
      });
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function resumeImport() {
    if (!resumePlan) return;
    setLoading(true); setError('');
    try {
      let plan = resumePlan;
      let createdOrganizations = 0;
      if (plan.organisationsPending) {
        // Only the batches still to submit need organisation ids; completed batches are left untouched.
        const remaining = plan.chunks.slice(plan.nextBatchIndex);
        const { rows: mapped, created } = await attachOrganisationIds(invoke, remaining.flat());
        const remapped = [];
        let offset = 0;
        for (const chunk of remaining) { remapped.push(mapped.slice(offset, offset + chunk.length)); offset += chunk.length; }
        plan = { ...plan, chunks: [...plan.chunks.slice(0, plan.nextBatchIndex), ...remapped], organisationsPending: false };
        createdOrganizations = created.length;
      }
      const tasks = await submitPlan(plan, plan.nextBatchIndex, plan.tasks || []);
      setImportStatus({
        submitted: plan.totalRows,
        tasks,
        ...(await finishOutcome(plan, tasks)),
        createdOrganizations,
        skipped: preview.filter((r) => r.action === 'SKIP').length,
        excludedErrors: preview.filter((r) => r.action === 'ERROR').length,
        sessionId: plan.sessionId,
        resumed: true
      });
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  const summary = useMemo(() => ({ total: rows.length, valid: validation?.valid || 0, errors: validation?.errors?.length || 0 }), [rows, validation]);
  const previewSummary = useMemo(() => preview.reduce((a, r) => {
    a[r.action] = (a[r.action] || 0) + 1;
    return a;
  }, { CREATE: 0, UPDATE: 0, SKIP: 0, ERROR: 0, PENDING: 0 }), [preview]);
  const filteredOrgs = useMemo(() => {
    const q = orgQuery.trim().toLowerCase();
    return q ? orgs.filter((o) => String(o.name || '').toLowerCase().includes(q)) : orgs;
  }, [orgs, orgQuery]);
  const errorReasons = useMemo(() => {
    const m = new Map();
    preview.filter((r) => r.action === 'ERROR').forEach((r) => m.set(r.reason, (m.get(r.reason) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [preview]);

  const actionKind = { CREATE: 'success', UPDATE: 'info', SKIP: 'neutral', ERROR: 'danger', PENDING: 'warning' };
  const statusKind = (status) => ({ SUBMITTED: 'success', COMPLETE: 'success', RUNNING: 'info', FAILED: 'danger', PAUSED: 'warning' }[String(status || '').toUpperCase()] || 'neutral');
  const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
  const changeCount = previewSummary.CREATE + previewSummary.UPDATE;
  const previewHasDetails = useMemo(() => preview.some((r) => detailCount(r) > 0), [preview]);
  const impact = useMemo(() => importImpact(preview), [preview]);
  const safeguard = useMemo(() => importSafeguard(impact), [impact]);
  const deskName = serviceDesks.find((d) => String(d.id) === String(desk))?.projectName || 'the selected service project';
  function startImport() {
    if (safeguard.level === 'none') { runImport(); return; }
    setTypedConfirmation('');
    setConfirmingImport(true);
  }
  const importButtonLabel = `Import ${changeCount.toLocaleString()} customer change${changeCount === 1 ? '' : 's'}${previewSummary.ERROR ? ` (exclude ${previewSummary.ERROR.toLocaleString()} error${previewSummary.ERROR === 1 ? '' : 's'})` : ''}`;
  const deskPicker = (tab === 'Customers' || tab === 'Import') && serviceDesks.length > 0
    ? <select className="nq-select" aria-label="Service project" value={desk} onChange={(e) => setDesk(e.target.value)}>{serviceDesks.map((d) => <option key={d.id} value={d.id}>{d.projectName}</option>)}</select>
    : null;

  return <div className="nq-page">
    <AppHeader product="Customer & Organisation Manager" subtitle="Bulk customer and organisation administration for Jira Service Management." version={APP_VERSION} actions={deskPicker}/>
    <Tabs items={tabs.map((t) => ({ id: t, label: t }))} active={tab} onChange={setTab}/>
    <div className="nq-stack">
      {readOnly && <Notice kind="warning" title="Read-only: no active licence">This site doesn't have an active licence for Customer & Organisation Manager. You can still browse customers and organisations and preview imports, but importing is turned off. A Jira administrator can start a trial or renew from Manage apps.</Notice>}
      {error && <Notice kind="error">{error}</Notice>}

      {tab === 'Customers' && <Card title="Customers" description="Customers of the selected service project.">
        <div className="nq-filters">
          <input className="nq-input nq-input--search" value={customerQuery} onChange={(e) => setCustomerQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadCustomers(e.currentTarget.value); }} placeholder="Search customers by name or email" aria-label="Search customers"/>
          <Button appearance="primary" onClick={() => loadCustomers(customerQuery)}>Search</Button>
          <Button onClick={() => { setCustomerQuery(''); loadCustomers(''); }}>Reset</Button>
        </div>
        {loading && !customers.length ? <Loading text="Loading customers…"/>
          : customers.length ? <div className="nq-table-wrap"><table className="nq-table"><thead><tr><th>Name</th><th>Email</th><th>Account</th></tr></thead><tbody>{customers.map((c) => <tr key={c.accountId || c.key}><td>{c.displayName}</td><td>{c.emailAddress || '—'}</td><td className="nq-muted">{c.accountId || c.key}</td></tr>)}</tbody></table></div>
            : <EmptyState title="No customers found" compact>No customers were returned for this service project{customerQuery ? ' and search' : ''}.</EmptyState>}
      </Card>}

      {tab === 'Organisations' && <Card title="Organisations" description={orgs.length
        ? `${filteredOrgs.length === orgs.length ? plural(orgs.length, 'organisation') : `${filteredOrgs.length.toLocaleString()} of ${plural(orgs.length, 'organisation')} match`}${loading ? ' · loading more…' : ''}`
        : 'Every organisation on this Jira site.'} actions={<Button appearance="subtle" onClick={loadOrgs} disabled={loading}>Refresh</Button>}>
        <div className="nq-filters">
          <input className="nq-input nq-input--search" value={orgQuery} onChange={(e) => setOrgQuery(e.target.value)} placeholder="Search organisations" aria-label="Search organisations"/>
        </div>
        {loading && !orgs.length ? <Loading text="Loading organisations…"/>
          : filteredOrgs.length ? <>
            <div className="nq-table-wrap"><table className="nq-table"><thead><tr><th>Name</th><th>ID</th></tr></thead><tbody>{filteredOrgs.slice(0, 500).map((o) => <tr key={o.id}><td>{o.name}</td><td className="nq-muted">{o.id}</td></tr>)}</tbody></table></div>
            {filteredOrgs.length > 500 && <p className="nq-help">Showing the first 500. Search to narrow the list.</p>}
          </>
            : <EmptyState title={orgs.length ? 'No organisations match your search.' : 'No organisations yet'} compact>{orgs.length ? 'Try a different name.' : 'Organisations are created when an import names one that does not exist yet.'}</EmptyState>}
      </Card>}

      {tab === 'Import' && <>
        <Card title="Import" description="Upload a CSV with a header row. You choose which columns hold the email, full name and (optionally) organisation. The preview checks Jira before anything is changed.">
          <Field label="CSV file" htmlFor="csv-file"><input id="csv-file" className="nq-input" type="file" accept=".csv,text/csv" onChange={onFile}/></Field>
        </Card>

        {csvTable && mapping && <Card title="Column mapping" description={mappingSource || 'Choose which column holds each field.'}>
          <div className="nq-stack">
            {!csvTable.headers.length && <Notice kind="error" title="This file has no header row">The first row must name the columns, for example Email, Full Name, Organisation.</Notice>}
            {csvTable.headers.length > 0 && missingMappingFields(mapping, csvTable.headers).length > 0 && <Notice kind="warning" title="Choose the columns to import">Pick the column for {missingMappingFields(mapping, csvTable.headers).join(' and ')}. The preview starts once they're chosen.</Notice>}
            {mappingMessage && <Notice kind={mappingMessage.kind}>{mappingMessage.text}</Notice>}
            {detailFieldsError && <Notice kind="warning" title="Customer details couldn't be loaded">{detailFieldsError} You can still import names, emails and organisations.</Notice>}
            <div className="nq-grid nq-grid--3">
              {MAPPING_FIELDS.filter(({ key }) => !(mapping.displayName && (key === 'firstName' || key === 'lastName'))).map(({ key, label, required }) => {
                const col = csvTable.headers.indexOf(mapping[key]);
                const sample = col >= 0 ? (csvTable.records.find((r) => r[col]) || [])[col] : '';
                const nameHelp = key === 'displayName' ? 'Or leave this and choose First name and Last name' : (key === 'firstName' || key === 'lastName') ? 'Joined with a space to make the full name' : '';
                return <Field key={key} label={label} required={required} htmlFor={`map-${key}`} help={sample ? `e.g. ${sample}` : (nameHelp || (required ? 'Required' : 'Optional'))}>
                  <select id={`map-${key}`} className="nq-select" value={mapping[key] || ''} onChange={(e) => { setMapping((m) => ({ ...m, [key]: e.target.value })); setMappingSource(''); }}>
                    <option value="">{required ? 'Choose a column…' : 'Not in this file'}</option>
                    {csvTable.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </Field>;
              })}
            </div>
            {detailFields.length > 0 && <>
              <h3 className="nq-card__title">Customer details</h3>
              <p className="nq-help">Values are checked against each field's type and options. A blank cell leaves the customer's current value unchanged.</p>
              <div className="nq-grid nq-grid--3">
                {detailFields.map((f) => {
                  const column = mapping.details?.[f.name] || '';
                  const col = csvTable.headers.indexOf(column);
                  const sample = col >= 0 ? (csvTable.records.find((r) => r[col]) || [])[col] : '';
                  const kind = { SELECT: 'Single choice', MULTISELECT: 'Multiple choice (separate with ;)', NUMBER: 'Number', EMAIL: 'Email', URL: 'Web address' }[f.type] || 'Text';
                  return <Field key={f.name} label={f.name} htmlFor={`map-detail-${f.name}`} help={sample ? `e.g. ${sample}` : kind}>
                    <select id={`map-detail-${f.name}`} className="nq-select" value={column} onChange={(e) => { const value = e.target.value; setMapping((m) => { const details = { ...(m.details || {}) }; if (value) details[f.name] = value; else delete details[f.name]; return { ...m, details }; }); setMappingSource(''); }}>
                      <option value="">Not imported</option>
                      {csvTable.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </Field>;
                })}
              </div>
            </>}
            <div className="nq-grid nq-grid--3">
              <div>
                {savedMappings.length > 0 ? <select className="nq-select" aria-label="Use a saved mapping" value="" onChange={(e) => { const m = savedMappings.find((x) => x.id === e.target.value); if (m) { setMapping(fromSaved(m)); setMappingSource(`Using the saved mapping "${m.name}".`); setMappingName(m.name); } }}>
                  <option value="">Use a saved mapping…</option>
                  {savedMappings.map((m) => <option key={m.id} value={m.id} disabled={!mappingFits(fromSaved(m), csvTable.headers)}>{m.name}{mappingFits(fromSaved(m), csvTable.headers) ? '' : ' (columns not in this file)'}</option>)}
                </select> : <p className="nq-help">No saved mappings yet.</p>}
              </div>
              <input className="nq-input" aria-label="Mapping name" placeholder="Name this mapping" value={mappingName} onChange={(e) => setMappingName(e.target.value)}/>
              <div className="nq-inline">
                <Button disabled={readOnly || !mappingName.trim() || missingMappingFields(mapping, csvTable.headers).length > 0} onClick={saveMapping}>Save mapping</Button>
                {savedMappings.some((m) => m.name === mappingName) && <Button appearance="subtle" onClick={() => deleteMapping(savedMappings.find((m) => m.name === mappingName).id)}>Delete saved mapping</Button>}
              </div>
            </div>
            <div className="nq-spread">
              <p className="nq-help">Saved mappings are used automatically for files with the same columns.</p>
              <Button appearance="primary" disabled={previewing || missingMappingFields(mapping, csvTable.headers).length > 0 || sameMapping(mapping, appliedMapping)} onClick={previewWithCurrentMapping}>{appliedMapping ? 'Preview again with these columns' : 'Preview with these columns'}</Button>
            </div>
          </div>
        </Card>}

        {previewSummary.ERROR > 0 && <Notice kind="error" title={`${plural(previewSummary.ERROR, 'row')} will be excluded from this import`}>
          <p>The valid rows can continue. These rows won't be sent to Jira; correct them and import them separately later.</p>
          {errorReasons.slice(0, 5).map(([reason, count]) => <div key={reason}><strong>{plural(count, 'row')}:</strong> {reason}</div>)}
        </Notice>}

        {comparisonProgress && <Card title={comparisonProgress.complete ? 'Jira comparison complete' : 'Large import Jira comparison'}>
          {comparisonProgress.complete
            ? <p>All valid CSV rows have now been checked against Jira. Scanned {plural(comparisonProgress.customersScanned, 'existing customer email')} in {plural(comparisonProgress.batches, 'batch', 'batches')}.</p>
            : <Loading text={`Building the customer index from Jira… ${plural(comparisonProgress.customersScanned, 'customer email')} scanned so far.`}/>}
        </Card>}

        {previewSummary.PENDING > 0 && !comparisonProgress?.complete && <Notice kind="warning" title="Large import safety check">
          <p><strong>{previewSummary.PENDING.toLocaleString()} valid rows are being checked.</strong>{previewSummary.ERROR > 0 ? ` ${plural(previewSummary.ERROR, 'error row')} will be excluded automatically.` : ''}</p>
          <p>Import stays disabled until the Jira comparison is complete, so no unchecked rows can be submitted.</p>
        </Notice>}

        {rows.length > 0 && <div className="nq-stats">
          <div className="nq-stat"><strong className="nq-stat__value">{summary.total.toLocaleString()}</strong><span className="nq-stat__label">Rows</span></div>
          <div className="nq-stat nq-stat--success"><strong className="nq-stat__value">{previewSummary.CREATE.toLocaleString()}</strong><span className="nq-stat__label">Create</span></div>
          <div className="nq-stat nq-stat--info"><strong className="nq-stat__value">{previewSummary.UPDATE.toLocaleString()}</strong><span className="nq-stat__label">Update</span></div>
          <div className="nq-stat"><strong className="nq-stat__value">{previewSummary.SKIP.toLocaleString()}</strong><span className="nq-stat__label">Skip</span></div>
          <div className="nq-stat nq-stat--danger"><strong className="nq-stat__value">{previewSummary.ERROR.toLocaleString()}</strong><span className="nq-stat__label">Excluded</span></div>
        </div>}

        {previewing && <Loading text="Checking existing Jira customers and organisations…"/>}

        {preview.length > 0 && <Card title="Import preview" description={preview.length > 500 ? `Showing the first 500 of ${preview.length.toLocaleString()} rows.` : undefined}>
          <div className="nq-table-wrap"><table className="nq-table"><thead><tr><th>Row</th><th>Action</th><th>Name</th><th>Email</th><th>Organisation</th>{previewHasDetails && <th>Customer details</th>}<th>Reason</th></tr></thead><tbody>{preview.slice(0, 500).map((r, i) => <tr key={`${r.email}-${i}`}><td>{r.rowNumber}</td><td><Lozenge kind={actionKind[r.action] || 'neutral'}>{r.action}</Lozenge></td><td>{r.displayName || '—'}</td><td>{r.email || '—'}</td><td>{r.organisation || '—'}</td>{previewHasDetails && <td>{detailSummary(r) || '—'}</td>}<td>{r.reason}</td></tr>)}</tbody></table></div>
        </Card>}

        {importProgress && <Card title={importProgress.state === 'complete' ? 'Import batches finished' : importProgress.state === 'rechecking' ? 'Finishing new customers' : importProgress.state === 'failed' ? 'Import paused safely' : importProgress.state === 'waiting' ? 'Waiting for Jira' : importProgress.state === 'recovered' ? 'Saved import recovered' : importProgress.state === 'preparing' ? 'Preparing import' : 'Submitting import batches'}>
          {importProgress.state === 'preparing' && <Loading text={`Preparing organisations and ${plural(importProgress.totalRows, 'customer change')}…`}/>}
          {importProgress.state === 'recovered' && <p><strong>This exact CSV matches a saved interrupted import.</strong> {importProgress.completedRows.toLocaleString()} of {plural(importProgress.totalRows, 'row')} were already submitted. Resume continues from batch {importProgress.currentBatch} of {importProgress.totalBatches} using the original row plan. Organisations are only checked or created when you click Resume.</p>}
          {importProgress.state !== 'preparing' && importProgress.state !== 'recovered' && <p><strong>{importProgress.completedRows.toLocaleString()} of {plural(importProgress.totalRows, 'row')} submitted</strong> across {importProgress.completedBatches} of {plural(importProgress.totalBatches, 'batch', 'batches')}.</p>}
          {importProgress.state === 'rechecking' && <Loading text={`Waiting for Jira to finish creating ${plural(importProgress.waiting, 'new customer')} before adding them to the project and organisations (check ${importProgress.attempt} of ${importProgress.attempts})…`}/>}
          {importProgress.state === 'running' && <Loading text={`Processing batch ${importProgress.currentBatch} of ${importProgress.totalBatches}${importProgress.attempt > 1 ? `, retry ${importProgress.attempt} of 3` : ''}…`}/>}
          {importProgress.state === 'waiting' && <Loading text={`Jira is still working through earlier import tasks and isn't accepting new ones yet. Batch ${importProgress.currentBatch} will be sent when it does (checked every minute, ${importProgress.waited} of ${importProgress.maxWaits}). Keep this page open.`}/>}
          {importProgress.state === 'failed' && <Notice kind="error" title={`Batch ${importProgress.currentBatch} wasn't accepted`}>
            <p>{isTaskLimitError(importProgress.error) ? 'Jira still had too many unfinished import tasks after an hour of waiting. Try Resume later; Jira finishes them in the background.' : `Jira's reply: ${importProgress.error || 'no details'}`}</p>
            <p>Earlier batches stay recorded, and retrying reuses the same idempotency key, so batches Jira already accepted aren't resubmitted.</p>
          </Notice>}
        </Card>}

        {confirmingImport && !loading && <Notice kind="warning" title={`Check before importing ${plural(impact.changes, 'customer change')}`}>
          <p>This is a large import ({safeguard.reasons.join(', ')}). It will change {deskName}:</p>
          <ul>
            {impact.create > 0 && <li>{plural(impact.create, 'new customer')} created and added to the project</li>}
            {impact.renames > 0 && <li>{plural(impact.renames, 'existing customer')} renamed to the name in the file</li>}
            {impact.update > impact.renames && <li>{plural(impact.update - impact.renames, 'existing customer')} with customer details updated</li>}
            {impact.newOrganisations.length > 0 && <li>{plural(impact.newOrganisations.length, 'organisation')} created: {impact.newOrganisations.slice(0, 10).join(', ')}{impact.newOrganisations.length > 10 ? `, and ${(impact.newOrganisations.length - 10).toLocaleString()} more` : ''}</li>}
          </ul>
          <p>Jira has no undo for this. Check the preview above first.</p>
          {safeguard.level === 'typed' && <Field label={`Type ${impact.changes.toLocaleString()} to confirm`} htmlFor="import-confirm-count"><input id="import-confirm-count" className="nq-input" inputMode="numeric" autoComplete="off" value={typedConfirmation} onChange={(e) => setTypedConfirmation(e.target.value)}/></Field>}
          <div className="nq-inline">
            <Button appearance="primary" disabled={safeguard.level === 'typed' && !typedConfirmationMatches(typedConfirmation, impact.changes)} onClick={() => { setConfirmingImport(false); runImport(); }}>Yes, import {plural(impact.changes, 'change')}</Button>
            <Button onClick={() => setConfirmingImport(false)}>Cancel</Button>
          </div>
        </Notice>}

        {(rows.length > 0 || resumePlan) && <div className="nq-inline">
          {rows.length > 0 && !resumePlan && <Button appearance="primary" disabled={readOnly || loading || previewing || previewSummary.PENDING > 0 || (previewSummary.CREATE + previewSummary.UPDATE === 0) || confirmingImport} onClick={startImport}>{loading ? 'Submitting…' : importButtonLabel}</Button>}
          {resumePlan && <Button appearance="primary" disabled={readOnly || loading} onClick={resumeImport}>{loading ? 'Resuming…' : `Resume saved import from batch ${resumePlan.nextBatchIndex + 1}`}</Button>}
        </div>}

        {importStatus && <Notice kind={importStatus.problems.length ? 'warning' : 'success'} title={importStatus.problems.length ? `Import finished: ${plural(importStatus.problems.length, 'row')} to fix` : (importStatus.resumed ? 'Import resumed and complete' : 'Import complete')}>
          <p>{plural(importStatus.linked, 'customer')} created or updated and added to {serviceDesks.find((d) => String(d.id) === String(desk))?.projectName || 'the service project'} and their organisations. Skipped {plural(importStatus.skipped, 'unchanged row')}. Excluded {plural(importStatus.excludedErrors, 'error row')}. Created {plural(importStatus.createdOrganizations, 'missing organisation')}.</p>
          {importStatus.problems.length > 0 && <>
            <div className="nq-table-wrap"><table className="nq-table"><thead><tr><th>Row</th><th>Email</th><th>Problem</th></tr></thead><tbody>{importStatus.problems.slice(0, 50).map((p) => <tr key={`${p.rowNumber}-${p.email}`}><td>{p.rowNumber}</td><td>{p.email}</td><td>{p.error}</td></tr>)}</tbody></table></div>
            {importStatus.problems.length > 50 && <p className="nq-help">Showing the first 50 of {importStatus.problems.length.toLocaleString()}.</p>}
            <div className="nq-inline">{importStatus.problems.some((p) => p.status === 'not-found') && lastPlan && <Button disabled={rechecking} onClick={checkAgain}>{rechecking ? 'Checking…' : 'Check again'}</Button>}<Button onClick={downloadProblemRows}>Download rows to fix (CSV)</Button></div>
          </>}
          <p className="nq-help">Import session: {importStatus.sessionId}</p>
        </Notice>}
      </>}

      {tab === 'Import History' && <Card title="Import History" description="Import sessions and the Jira bulk tasks they submitted." actions={<Button appearance="subtle" onClick={loadHistory}>Refresh status</Button>}>
        <div className="nq-stack">
          <h3 className="nq-card__title">Import sessions</h3>
          {importSessions.length ? <div className="nq-table-wrap"><table className="nq-table"><thead><tr><th>Started</th><th>File</th><th>Progress</th><th>Status</th><th>Session</th></tr></thead><tbody>{importSessions.map((s) => <tr key={s.id}><td>{new Date(s.createdAt).toLocaleString()}</td><td>{s.fileName || '—'}</td><td>{Number(s.submittedRows || 0).toLocaleString()} / {Number(s.totalRows || 0).toLocaleString()} rows · {Number(s.completedBatches || 0)} / {Number(s.totalBatches || 0)} batches{s.linkedRows != null ? ` · ${Number(s.linkedRows).toLocaleString()} added${s.problemRows ? `, ${Number(s.problemRows).toLocaleString()} to fix` : ''}` : ''}</td><td><Lozenge kind={statusKind(s.status)}>{s.status || 'Unknown'}</Lozenge></td><td className="nq-muted">{s.id}</td></tr>)}</tbody></table></div>
            : <EmptyState title="No import sessions yet" compact>Sessions appear here once you run an import.</EmptyState>}
          <h3 className="nq-card__title">Bulk task history</h3>
          {history.length ? <div className="nq-table-wrap"><table className="nq-table"><thead><tr><th>Submitted</th><th>Batch</th><th>Rows</th><th>Status</th><th>Failures</th><th>Task</th></tr></thead><tbody>{history.map((h) => <tr key={h.id}><td>{new Date(h.createdAt).toLocaleString()}</td><td>{h.batchNumber && h.totalBatches ? `${h.batchNumber}/${h.totalBatches}` : '—'}</td><td>{h.count}</td><td><Lozenge kind={statusKind(h.task?.status)}>{h.task?.status || 'Unknown'}</Lozenge></td><td>{h.task?.failures?.length || 0}</td><td className="nq-muted">{h.taskId}</td></tr>)}</tbody></table></div>
            : <EmptyState title="No bulk tasks yet" compact>Each import batch is recorded here with its Jira task status.</EmptyState>}
        </div>
      </Card>}
      {tab === 'Organisation sync' && <OrgSync invoke={invoke} serviceDesks={serviceDesks} orgs={orgs} loadOrgs={loadOrgs} readOnly={readOnly}/>}
      {tab === 'Backup & restore' && <BackupRestore invoke={invoke} app="Customer & Organisation Manager" filePrefix="retailinmotion-customer-org-manager"/>}
    </div>
    <Footer product="Customer & Organisation Manager" version={APP_VERSION}/>
  </div>;
}

enableTheme(view);
createRoot(document.getElementById('root')).render(<App/>);
