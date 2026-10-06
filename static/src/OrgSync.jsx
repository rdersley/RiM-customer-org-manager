import React, { useEffect, useMemo, useState } from 'react';
import { Card, Button, Notice, EmptyState, Loading, Lozenge, Field } from '@retailinmotion/ui/react';
import { organisationKey } from './organisations.js';

const sourceLabel = { 'client-changed': ['Client changed', 'info'], created: ['New ticket', 'success'], backfill: ['Bulk correction', 'discovery'], 'missing-mapping': ['No mapping', 'warning'], failed: ['Failed', 'danger'] };
const CORRECT_CHUNK = 25;

// A dropdown of every option of a select field. A saved value that isn't an option any more (renamed,
// removed, or typed before dropdowns existed) stays visible and marked, so nothing changes silently.
function ValueSelect({ options, value, onChange, label, emptyLabel }) {
  const current = String(value || '').trim();
  const match = options.find((o) => o.toLowerCase() === current.toLowerCase());
  const stale = current && !match;
  return <select className="nq-select" aria-label={label} value={stale ? current : (match || '')} onChange={(e) => onChange(e.target.value)}>
    <option value="">{emptyLabel}</option>
    {stale && <option value={current}>{current} (not an option now)</option>}
    {options.map((o) => <option key={o} value={o}>{o}</option>)}
  </select>;
}

/**
 * Organisation sync tab: settings, client → organisation mappings, sync health and recent corrections.
 * `orgs` is the full organisation list from the Organisations tab loader.
 */
export default function OrgSync({ invoke, serviceDesks, orgs, loadOrgs, readOnly }) {
  const [setup, setSetup] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [secondSuggestions, setSecondSuggestions] = useState([]);
  // Every option of the Client / second field in the selected projects ({ found, options }); found is false
  // for text fields, which keep the typing box.
  const [clientOptions, setClientOptions] = useState({ found: false, options: [] });
  const [secondOptions, setSecondOptions] = useState({ found: false, options: [] });
  const [scan, setScan] = useState(null);
  const [correcting, setCorrecting] = useState(null);
  const [confirmCorrect, setConfirmCorrect] = useState(false);
  const [log, setLog] = useState([]);

  const orgById = useMemo(() => new Map(orgs.map((o) => [String(o.id), o.name])), [orgs]);
  const orgByName = useMemo(() => new Map(orgs.map((o) => [organisationKey(o.name), o])), [orgs]);
  const orgNames = (ids) => (ids || []).map((id) => orgById.get(String(id)) || `#${id}`).join(', ') || '—';

  async function load() {
    try {
      const [s, entries] = await Promise.all([invoke('getSyncSetup'), invoke('getSyncLog')]);
      setSetup(s);
      setLog(entries || []);
      const c = s.config || {};
      setDraft({
        enabled: Boolean(c.enabled),
        clientFieldId: c.clientFieldId || '',
        secondaryFieldId: c.secondaryFieldId || '',
        projectKeys: c.projectKeys || [],
        ignoredRequestTypeIds: c.ignoredRequestTypeIds || [],
        mappings: (c.mappings || []).map((m) => ({ clientValue: m.clientValue, secondaryValue: m.secondaryValue || '', organisation: m.organizationName || '', organizationId: m.organizationId }))
      });
    } catch (e) { setMessage({ kind: 'error', text: e.message }); }
  }

  useEffect(() => { load(); if (!orgs.length) loadOrgs(); }, []);
  useEffect(() => {
    if (!draft?.clientFieldId) return;
    invoke('getClientValueSuggestions', { fieldId: draft.clientFieldId, query: '' }).then(setSuggestions).catch(() => setSuggestions([]));
  }, [draft?.clientFieldId]);
  useEffect(() => {
    if (!draft?.secondaryFieldId) { setSecondSuggestions([]); return; }
    invoke('getClientValueSuggestions', { fieldId: draft.secondaryFieldId, query: '' }).then(setSecondSuggestions).catch(() => setSecondSuggestions([]));
  }, [draft?.secondaryFieldId]);
  const projectsKey = (draft?.projectKeys || []).join(',');
  useEffect(() => {
    const load = (fieldId, set) => {
      if (!fieldId || !draft?.projectKeys?.length) { set({ found: false, options: [] }); return; }
      invoke('getSyncFieldOptions', { fieldId, projectKeys: draft.projectKeys }).then(set).catch(() => set({ found: false, options: [] }));
    };
    load(draft?.clientFieldId, setClientOptions);
    load(draft?.secondaryFieldId, setSecondOptions);
  }, [draft?.clientFieldId, draft?.secondaryFieldId, projectsKey]);

  if (!setup || !draft) return <Card title="Organisation sync"><Loading text="Loading sync settings…"/></Card>;

  const update = (patch) => { setDraft((d) => ({ ...d, ...patch })); setMessage(null); };
  const setMapping = (i, patch) => update({ mappings: draft.mappings.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const addMapping = (clientValue = '', secondaryValue = '') => update({ mappings: [...draft.mappings, { clientValue, secondaryValue, organisation: '', organizationId: '' }] });
  // Health-check keys for unmapped values are the Client value, plus "\u001f" and the second value when there is one.
  const splitKey = (key) => { const [clientValue, secondaryValue = ''] = String(key).split('\u001f'); return { clientValue, secondaryValue }; };
  const both = (clientValue, secondaryValue) => (secondaryValue ? `${clientValue} · ${secondaryValue}` : clientValue);
  const toggleProject = (key) => update({ projectKeys: draft.projectKeys.includes(key) ? draft.projectKeys.filter((k) => k !== key) : [...draft.projectKeys, key] });

  // Resolves typed organisation names to ids; returns the problem rows, if any.
  function resolvedMappings() {
    const problems = [];
    const mappings = draft.mappings
      .filter((m) => m.clientValue.trim() || m.organisation.trim())
      .map((m, i) => {
        const org = orgByName.get(organisationKey(m.organisation));
        if (!m.clientValue.trim()) problems.push(`Row ${i + 1}: enter a client value.`);
        else if (!org) problems.push(`Row ${i + 1}: "${m.organisation || '(blank)'}" isn't an organisation on this site.`);
        return { clientValue: m.clientValue.trim(), secondaryValue: draft.secondaryFieldId ? String(m.secondaryValue || '').trim() : '', organizationId: org ? String(org.id) : '', organizationName: org?.name || '' };
      });
    return { mappings, problems };
  }

  async function save() {
    const { mappings, problems } = resolvedMappings();
    if (problems.length) { setMessage({ kind: 'error', title: "Couldn't save the mappings", text: problems.slice(0, 5).join(' ') }); return; }
    setSaving(true);
    try {
      const saved = await invoke('saveSyncConfig', { ...draft, mappings });
      const { warnings = [], ...config } = saved;
      setSetup((s) => ({ ...s, config }));
      const state = config.enabled ? 'Settings saved. Sync is on.' : 'Settings saved. Sync is off.';
      setMessage(warnings.length
        ? { kind: 'warning', title: `${state} Some organisations aren't added to the selected projects`, text: `${warnings.map((w) => `${w.projectKey}: ${w.organisations.join(', ')}`).join('; ')}. Jira only lets an organisation be set on a ticket once it's added to that service project, so sync will fail for these clients until they're added (Project settings → Customers).` }
        : { kind: 'success', text: state });
    } catch (e) { setMessage({ kind: 'error', title: "Couldn't save the settings", text: e.message }); }
    finally { setSaving(false); }
  }

  async function runScan() {
    setScan({ running: true, checked: 0, correct: 0, noClient: 0, ignored: 0, needsChange: [], missing: {} });
    setConfirmCorrect(false);
    const totals = { checked: 0, correct: 0, noClient: 0, ignored: 0, needsChange: [], missing: {} };
    try {
      let nextPageToken = null;
      for (let calls = 0; ; calls += 1) {
        if (calls >= 1000) throw new Error('Ticket check safety limit reached.');
        const r = await invoke('scanSyncHealth', { nextPageToken });
        for (const k of ['checked', 'correct', 'noClient', 'ignored']) totals[k] += r[k] || 0;
        totals.needsChange.push(...(r.needsChange || []));
        for (const [v, n] of Object.entries(r.missing || {})) totals.missing[v] = (totals.missing[v] || 0) + n;
        setScan({ running: !r.complete, ...totals });
        if (r.complete) break;
        nextPageToken = r.nextPageToken;
      }
      if (!readOnly) {
        const health = await invoke('saveSyncHealth', { ...totals, needsChange: totals.needsChange.length });
        setSetup((s) => ({ ...s, health }));
      }
    } catch (e) { setScan((s) => ({ ...s, running: false, error: e.message })); }
  }

  async function runCorrections() {
    const items = scan.needsChange;
    const result = { corrected: 0, unchanged: 0, failed: [] };
    setConfirmCorrect(false);
    setCorrecting({ done: 0, total: items.length, ...result });
    for (let i = 0; i < items.length; i += CORRECT_CHUNK) {
      try {
        const r = await invoke('applySyncCorrections', { issueIds: items.slice(i, i + CORRECT_CHUNK).map((x) => x.id) });
        result.corrected += r.corrected.length;
        result.unchanged += r.unchanged.length;
        result.failed.push(...r.failed.map((f) => ({ ...f, key: items.find((x) => x.id === f.id)?.key || f.id })));
      } catch (e) {
        result.failed.push(...items.slice(i, i + CORRECT_CHUNK).map((x) => ({ id: x.id, key: x.key, message: e.message })));
      }
      setCorrecting({ done: Math.min(i + CORRECT_CHUNK, items.length), total: items.length, ...result });
    }
    setCorrecting((c) => ({ ...c, finished: true }));
    setScan((s) => ({ ...s, needsChange: [] }));
    invoke('getSyncLog').then(setLog).catch(() => {});
  }

  const { fields, health } = setup;
  const missingEntries = Object.entries(scan?.missing || health?.missing || {}).sort((a, b) => b[1] - a[1]);
  const pairKey = (c, v) => `${String(c || '').trim().toLowerCase()}\u001f${String(v || '').trim().toLowerCase()}`;
  const mappedValues = new Set(draft.mappings.map((m) => pairKey(m.clientValue, m.secondaryValue)));
  const secondName = fields.clientCandidates.find((f) => f.id === draft.secondaryFieldId)?.name || 'Second field';
  const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;

  return <>
    <Card title="Organisation sync" description="Keeps the JSM Organizations field in step with a Client field on your tickets, without Jira Automation. The Client field is the source of truth.">
      <div className="nq-stack">
        {!fields.organisationsField && <Notice kind="warning" title="No Organizations field found">This site doesn't have the Jira Service Management Organizations field, so sync can't run here.</Notice>}
        {message && <Notice kind={message.kind} title={message.title}>{message.text}</Notice>}
        <div className="nq-grid nq-grid--2">
          <Field label="Client field" htmlFor="sync-client-field" help="A single-select or text custom field. Its value decides the organisation.">
            <select id="sync-client-field" className="nq-select" value={draft.clientFieldId} onChange={(e) => update({ clientFieldId: e.target.value })}>
              <option value="">Choose a field…</option>
              {fields.clientCandidates.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.type === 'select' ? 'select list' : 'text'})</option>)}
            </select>
          </Field>
          <Field label="Second field (optional)" htmlFor="sync-second-field" help="Use when one client is split across several organisations, for example by site or region. Rows without a second value are the client's default.">
            <select id="sync-second-field" className="nq-select" value={draft.secondaryFieldId} onChange={(e) => update({ secondaryFieldId: e.target.value })}>
              <option value="">Not used</option>
              {fields.clientCandidates.filter((f) => f.id !== draft.clientFieldId).map((f) => <option key={f.id} value={f.id}>{f.name} ({f.type === 'select' ? 'select list' : 'text'})</option>)}
            </select>
          </Field>
          <Field label="Organizations field" htmlFor="sync-org-field" help="Found automatically.">
            <input id="sync-org-field" className="nq-input" readOnly value={fields.organisationsField ? fields.organisationsField.name : 'Not found'}/>
          </Field>
        </div>
        <Field label="Projects" help="Sync only runs on tickets in these service projects.">
          <div className="nq-inline">
            {serviceDesks.map((d) => <label key={d.projectKey} className="nq-check"><input type="checkbox" checked={draft.projectKeys.includes(d.projectKey)} onChange={() => toggleProject(d.projectKey)}/> {d.projectName} ({d.projectKey})</label>)}
          </div>
        </Field>
        <label className="nq-check"><input type="checkbox" checked={draft.enabled} onChange={(e) => update({ enabled: e.target.checked })}/> Sync is on: correct the Organizations field whenever a ticket is created or its Client{draft.secondaryFieldId ? ` or ${secondName}` : ''} changes</label>
      </div>
    </Card>

    <Card title="Client mappings" description="Each Client value and the organisation it belongs to. Organisations that aren't in any mapping are never removed from tickets.">
      <div className="nq-stack">
        <datalist id="sync-client-values">{suggestions.map((v) => <option key={v} value={v}/>)}</datalist>
        <datalist id="sync-second-values">{secondSuggestions.map((v) => <option key={v} value={v}/>)}</datalist>
        <datalist id="sync-organisations">{orgs.slice(0, 5000).map((o) => <option key={o.id} value={o.name}/>)}</datalist>
        {draft.mappings.length ? <div className="nq-table-wrap"><table className="nq-table">
          <thead><tr><th>Client value</th>{draft.secondaryFieldId && <th>{secondName} (optional)</th>}<th>Organisation</th><th aria-label="Actions"/></tr></thead>
          <tbody>{draft.mappings.map((m, i) => <tr key={i}>
            <td>{clientOptions.found
              ? <ValueSelect options={clientOptions.options} value={m.clientValue} onChange={(v) => setMapping(i, { clientValue: v })} label={`Client value ${i + 1}`} emptyLabel="Choose a client…"/>
              : <input className="nq-input" list="sync-client-values" value={m.clientValue} onChange={(e) => setMapping(i, { clientValue: e.target.value })} aria-label={`Client value ${i + 1}`} placeholder="e.g. RYR"/>}</td>
            {draft.secondaryFieldId && <td>{secondOptions.found
              ? <ValueSelect options={secondOptions.options} value={m.secondaryValue || ''} onChange={(v) => setMapping(i, { secondaryValue: v })} label={`Second value ${i + 1}`} emptyLabel="Any (client default)"/>
              : <input className="nq-input" list="sync-second-values" value={m.secondaryValue || ''} onChange={(e) => setMapping(i, { secondaryValue: e.target.value })} aria-label={`Second value ${i + 1}`} placeholder="Any (client default)"/>}</td>}
            <td><input className="nq-input" list="sync-organisations" value={m.organisation} onChange={(e) => setMapping(i, { organisation: e.target.value })} aria-label={`Organisation ${i + 1}`} placeholder="Start typing an organisation"/></td>
            <td className="nq-table__actions"><Button appearance="subtle" small onClick={() => update({ mappings: draft.mappings.filter((_, j) => j !== i) })}>Remove</Button></td>
          </tr>)}</tbody>
        </table></div> : <EmptyState title="No mappings yet" compact>Add a row for each Client value, or run a ticket check to find the values your tickets use.</EmptyState>}
        <div className="nq-spread">
          <Button onClick={() => addMapping()}>Add mapping</Button>
          <Button appearance="primary" disabled={readOnly || saving} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</Button>
        </div>
      </div>
    </Card>

    <Card title="Sync health" description="Checks every ticket in the selected projects that has a Client value. Checking changes nothing." actions={<Button appearance="subtle" disabled={scan?.running || !setup.config?.clientFieldId} onClick={runScan}>{scan?.running ? 'Checking…' : 'Check tickets'}</Button>}>
      <div className="nq-stack">
        {!setup.config?.clientFieldId && <p className="nq-help">Save the Client field and projects first.</p>}
        {scan?.error && <Notice kind="error" title="Couldn't finish checking tickets">{scan.error}</Notice>}
        {(scan || health) && <div className="nq-stats">
          <div className="nq-stat"><strong className="nq-stat__value">{(scan?.checked ?? health.checked).toLocaleString()}</strong><span className="nq-stat__label">Checked</span></div>
          <div className="nq-stat nq-stat--success"><strong className="nq-stat__value">{(scan?.correct ?? health.correct).toLocaleString()}</strong><span className="nq-stat__label">Correct</span></div>
          <div className="nq-stat nq-stat--warning"><strong className="nq-stat__value">{(scan ? scan.needsChange.length : health.needsChange).toLocaleString()}</strong><span className="nq-stat__label">Need correcting</span></div>
          <div className="nq-stat nq-stat--danger"><strong className="nq-stat__value">{missingEntries.reduce((n, [, c]) => n + c, 0).toLocaleString()}</strong><span className="nq-stat__label">Missing mapping</span></div>
        </div>}
        {scan?.running && <Loading text={`Checking tickets… ${scan.checked.toLocaleString()} so far.`}/>}
        {!scan && health && <p className="nq-help">Last checked {new Date(health.checkedAt).toLocaleString()}.</p>}

        {scan && !scan.running && scan.needsChange.length > 0 && <>
          <div className="nq-table-wrap"><table className="nq-table">
            <thead><tr><th>Ticket</th><th>Client</th><th>Organisations now</th><th>Will become</th></tr></thead>
            <tbody>{scan.needsChange.slice(0, 100).map((x) => <tr key={x.id}><td>{x.key}</td><td>{both(x.clientValue, x.secondaryValue)}</td><td>{orgNames(x.from)}</td><td>{orgNames(x.to)}</td></tr>)}</tbody>
          </table></div>
          {scan.needsChange.length > 100 && <p className="nq-help">Showing the first 100 of {scan.needsChange.length.toLocaleString()}.</p>}
          {!confirmCorrect
            ? <div className="nq-inline"><Button appearance="primary" disabled={readOnly || Boolean(correcting && !correcting.finished)} onClick={() => setConfirmCorrect(true)}>Correct {plural(scan.needsChange.length, 'ticket')}</Button></div>
            : <Notice kind="warning" title={`Correct ${plural(scan.needsChange.length, 'ticket')}?`}>
              <p>The Organizations field on these tickets will be changed as shown. Each ticket is re-checked first, and organisations that aren't in a mapping are kept.</p>
              <div className="nq-inline"><Button appearance="primary" onClick={runCorrections}>Yes, correct {plural(scan.needsChange.length, 'ticket')}</Button><Button onClick={() => setConfirmCorrect(false)}>Cancel</Button></div>
            </Notice>}
        </>}
        {correcting && (correcting.finished
          ? <Notice kind={correcting.failed.length ? 'warning' : 'success'} title={correcting.failed.length ? 'Corrections finished with problems' : 'Tickets corrected'}>
            Corrected {plural(correcting.corrected, 'ticket')}. {correcting.unchanged ? `${plural(correcting.unchanged, 'ticket')} no longer needed it. ` : ''}{correcting.failed.length ? `${plural(correcting.failed.length, 'ticket')} failed: ${correcting.failed.slice(0, 5).map((f) => `${f.key} (${f.message})`).join('; ')}` : ''}
          </Notice>
          : <Loading text={`Correcting tickets… ${correcting.done.toLocaleString()} of ${correcting.total.toLocaleString()}.`}/>)}

        {missingEntries.length > 0 && <>
          <h3 className="nq-card__title">Client values with no mapping</h3>
          <div className="nq-table-wrap"><table className="nq-table">
            <thead><tr><th>Client value</th><th>Tickets</th><th aria-label="Actions"/></tr></thead>
            <tbody>{missingEntries.slice(0, 50).map(([key, count]) => { const { clientValue, secondaryValue } = splitKey(key); return <tr key={key}><td>{both(clientValue, secondaryValue)}</td><td>{count.toLocaleString()}</td>
              <td className="nq-table__actions">{mappedValues.has(pairKey(clientValue, secondaryValue)) ? <span className="nq-muted">Added, not saved</span> : <Button appearance="subtle" small onClick={() => addMapping(clientValue, secondaryValue)}>Add mapping</Button>}</td></tr>; })}</tbody>
          </table></div>
        </>}
      </div>
    </Card>

    <Card title="Recent corrections" description="Changes made by the app in the last 90 days, newest first." actions={<Button appearance="subtle" onClick={() => { loadOrgs(); invoke('getSyncLog').then(setLog); }}>Refresh</Button>}>
      {log.length ? <div className="nq-table-wrap"><table className="nq-table">
        <thead><tr><th>When</th><th>Ticket</th><th>Client</th><th>From</th><th>To</th><th>Why</th></tr></thead>
        <tbody>{log.map((e) => { const [label, kind] = sourceLabel[e.source] || [e.source, 'neutral']; return <tr key={`${e.at}-${e.issueKey}`}><td>{new Date(e.at).toLocaleString()}</td><td>{e.issueKey}</td><td>{both(e.clientValue, e.secondaryValue)}</td><td>{orgNames(e.from)}</td><td>{e.source === 'missing-mapping' ? '—' : orgNames(e.to)}</td><td><Lozenge kind={kind}>{label}</Lozenge>{e.error && <div className="nq-help">{e.error}</div>}</td></tr>; })}</tbody>
      </table></div> : <EmptyState title="No corrections yet" compact>When sync corrects a ticket, it's listed here.</EmptyState>}
    </Card>
  </>;
}
