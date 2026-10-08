import React, { useEffect, useState } from 'react';
import { Card, Button, Notice, EmptyState, Loading, Lozenge, Field } from '@retailinmotion/ui/react';

const sourceLabel = { created: ['New ticket', 'success'], 'reporter-changed': ['Reporter changed', 'info'], backfill: ['Bulk update', 'discovery'], failed: ['Failed', 'danger'] };
const CHUNK = 25;
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
const isoDay = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => isoDay(new Date(Date.now() - n * 86400000));
const DATE_PRESETS = [['Last 7 days', 7], ['Last 30 days', 30], ['Last 90 days', 90]];
const EMPTY_FILTER = { createdFrom: '', createdTo: '', fieldFilters: [] };

/**
 * Ticket details tab: copies the reporter's customer details (e.g. CrewCode, Base) into ticket fields.
 * Fills empty fields and placeholder values; any other value on a ticket is kept.
 */
export default function DetailSync({ invoke, serviceDesks, readOnly }) {
  const [setup, setSetup] = useState(null);
  const [detailNames, setDetailNames] = useState([]);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [scan, setScan] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [updating, setUpdating] = useState(null);
  const [log, setLog] = useState([]);
  // Limits for Check tickets (not saved): a Created range and select-field options.
  const [filter, setFilter] = useState(EMPTY_FILTER);
  const [filterOptions, setFilterOptions] = useState({});

  async function load() {
    try {
      const [s, detail, entries] = await Promise.all([
        invoke('getDetailSyncSetup'),
        invoke('getCustomerDetailFields').catch(() => ({ fields: [] })),
        invoke('getDetailSyncLog')
      ]);
      setSetup(s);
      setDetailNames((detail?.fields || []).map((f) => f.name));
      setLog(entries || []);
      const c = s.config || {};
      setDraft({
        enabled: Boolean(c.enabled),
        projectKeys: c.projectKeys || [],
        mappings: (c.mappings || []).map((m) => ({ detailName: m.detailName, fieldId: m.fieldId })),
        placeholders: (c.placeholders || ['Unknown', 'Please Update']).join(', ')
      });
    } catch (e) { setMessage({ kind: 'error', text: e.message }); }
  }
  useEffect(() => { load(); }, []);

  if (!setup || !draft) return <Card title="Ticket details"><Loading text="Loading settings…"/></Card>;

  const update = (patch) => { setDraft((d) => ({ ...d, ...patch })); setMessage(null); };
  const setMapping = (i, patch) => update({ mappings: draft.mappings.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const toggleProject = (key) => update({ projectKeys: draft.projectKeys.includes(key) ? draft.projectKeys.filter((k) => k !== key) : [...draft.projectKeys, key] });

  async function save() {
    setSaving(true);
    try {
      const config = await invoke('saveDetailSyncConfig', {
        ...draft,
        mappings: draft.mappings.filter((m) => m.detailName && m.fieldId),
        placeholders: draft.placeholders.split(',').map((p) => p.trim()).filter(Boolean)
      });
      setSetup((s) => ({ ...s, config }));
      setMessage({ kind: 'success', text: config.enabled ? 'Settings saved. New tickets are filled in automatically.' : 'Settings saved. Automatic filling is off.' });
    } catch (e) { setMessage({ kind: 'error', title: "Couldn't save the settings", text: e.message }); }
    finally { setSaving(false); }
  }

  const setFilterRow = (i, patch) => setFilter((f) => ({ ...f, fieldFilters: f.fieldFilters.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  async function chooseFilterField(i, fieldId) {
    setFilterRow(i, { fieldId, values: [] });
    if (!fieldId || filterOptions[fieldId]) return;
    setFilterOptions((o) => ({ ...o, [fieldId]: { loading: true, options: [] } }));
    try {
      const r = await invoke('getDetailFilterOptions', { fieldId });
      setFilterOptions((o) => ({ ...o, [fieldId]: { options: r.options || [] } }));
    } catch (e) { setFilterOptions((o) => ({ ...o, [fieldId]: { options: [], error: e.message } })); }
  }
  const activeFilter = { ...filter, fieldFilters: filter.fieldFilters.filter((x) => x.fieldId && x.values.length) };
  const filterSummary = [
    filter.createdFrom || filter.createdTo ? `created ${filter.createdFrom ? `from ${filter.createdFrom}` : ''}${filter.createdFrom && filter.createdTo ? ' ' : ''}${filter.createdTo ? `to ${filter.createdTo}` : ''}` : '',
    ...activeFilter.fieldFilters.map((x) => `${setup?.ticketFields.find((f) => f.id === x.fieldId)?.name || x.fieldId}: ${x.values.join(', ')}`)
  ].filter(Boolean).join(' · ');

  async function runScan() {
    const totals = { checked: 0, correct: 0, noDetails: 0, kept: 0, needsChange: [] };
    setScan({ running: true, ...totals, filterSummary });
    setConfirm(false);
    setUpdating(null);
    try {
      let nextPageToken = null;
      let waits = 0;
      for (let calls = 0; ; calls += 1) {
        if (calls >= 2000) throw new Error('Ticket check safety limit reached.');
        const r = await invoke('scanDetailSync', { nextPageToken, filter: activeFilter });
        for (const k of ['checked', 'correct', 'noDetails', 'kept']) totals[k] += r[k] || 0;
        totals.needsChange.push(...(r.needsChange || []));
        if (r.complete) { setScan({ running: false, ...totals, filterSummary }); break; }
        nextPageToken = r.nextPageToken;
        if (r.rateLimited) {
          // Jira asked the app to slow down: wait, then carry on from the same page.
          waits += 1;
          if (waits > 20) throw new Error('Jira kept asking the app to slow down. Wait a few minutes, then check again (a narrower date range helps).');
          setScan({ running: true, waiting: true, ...totals, filterSummary });
          await new Promise((resolve) => setTimeout(resolve, 30000));
        } else waits = 0;
        setScan({ running: true, ...totals, filterSummary });
      }
    } catch (e) { setScan((s) => ({ ...s, running: false, error: e.message })); }
  }

  async function runUpdates() {
    const items = scan.needsChange;
    const result = { updated: 0, unchanged: 0, failed: [] };
    setConfirm(false);
    setUpdating({ done: 0, total: items.length, ...result });
    // Each call returns the tickets it had no time for (`pending`); they go back to the front of the queue.
    const queue = [...items];
    let done = 0;
    let stalled = 0;
    while (queue.length) {
      const part = queue.splice(0, CHUNK);
      try {
        const r = await invoke('applyDetailSync', { issueIds: part.map((x) => x.id) });
        const pending = new Set((r.pending || []).map(String));
        result.updated += r.updated.length;
        result.unchanged += r.unchanged.length;
        result.failed.push(...r.failed.map((f) => ({ ...f, key: f.key || part.find((x) => x.id === f.id)?.key || f.id })));
        queue.unshift(...part.filter((x) => pending.has(String(x.id))));
        done += part.length - pending.size;
        stalled = pending.size === part.length ? stalled + 1 : 0;
        if (stalled >= 3) {
          result.failed.push(...queue.splice(0).map((x) => ({ key: x.key, message: 'Jira was too slow to update this ticket; check again later.' })));
        }
      } catch (e) {
        // A call that times out may still have filled some of its tickets; checking again finds the rest.
        result.failed.push(...part.map((x) => ({ key: x.key, message: e.message })));
        done += part.length;
      }
      setUpdating({ done: Math.min(done, items.length), total: items.length, ...result });
    }
    setUpdating((u) => ({ ...u, finished: true }));
    setScan((s) => ({ ...s, needsChange: [] }));
    invoke('getDetailSyncLog').then(setLog).catch(() => {});
  }

  const saved = setup.config;
  return <>
    <Card title="Ticket details" description="Copies the reporter's customer details (for example Crew code and Base) into fields on their tickets. Empty fields and placeholder values are filled; any other value already on a ticket is kept.">
      <div className="nq-stack">
        {message && <Notice kind={message.kind} title={message.title}>{message.text}</Notice>}
        <Field label="Projects" help="Only tickets in these service projects are filled.">
          <div className="nq-inline">
            {serviceDesks.map((d) => <label key={d.projectKey} className="nq-check"><input type="checkbox" checked={draft.projectKeys.includes(d.projectKey)} onChange={() => toggleProject(d.projectKey)}/> {d.projectName} ({d.projectKey})</label>)}
          </div>
        </Field>
        {draft.mappings.length ? <div className="nq-table-wrap"><table className="nq-table">
          <thead><tr><th>Customer detail</th><th>Ticket field</th><th aria-label="Actions"/></tr></thead>
          <tbody>{draft.mappings.map((m, i) => <tr key={i}>
            <td><select className="nq-select" aria-label={`Customer detail ${i + 1}`} value={m.detailName} onChange={(e) => setMapping(i, { detailName: e.target.value })}>
              <option value="">Choose a detail…</option>
              {m.detailName && !detailNames.includes(m.detailName) && <option value={m.detailName}>{m.detailName} (not found now)</option>}
              {detailNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select></td>
            <td><select className="nq-select" aria-label={`Ticket field ${i + 1}`} value={m.fieldId} onChange={(e) => setMapping(i, { fieldId: e.target.value })}>
              <option value="">Choose a field…</option>
              {setup.ticketFields.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.type === 'select' ? 'select list' : 'text'})</option>)}
            </select></td>
            <td className="nq-table__actions"><Button appearance="subtle" small onClick={() => update({ mappings: draft.mappings.filter((_, j) => j !== i) })}>Remove</Button></td>
          </tr>)}</tbody>
        </table></div> : <EmptyState title="No fields yet" compact>Add a row for each customer detail to copy, for example CrewCode → Crew code.</EmptyState>}
        <Field label="Values to replace" htmlFor="detail-placeholders" help="Comma-separated. A ticket field holding one of these (any case) is treated as empty and filled in.">
          <input id="detail-placeholders" className="nq-input" value={draft.placeholders} onChange={(e) => update({ placeholders: e.target.value })} placeholder="Unknown, Please Update"/>
        </Field>
        <label className="nq-check"><input type="checkbox" checked={draft.enabled} onChange={(e) => update({ enabled: e.target.checked })}/> Fill in new tickets automatically (and tickets whose reporter changes)</label>
        <div className="nq-spread">
          <Button onClick={() => update({ mappings: [...draft.mappings, { detailName: '', fieldId: '' }] })}>Add field</Button>
          <Button appearance="primary" disabled={readOnly || saving} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</Button>
        </div>
      </div>
    </Card>

    <Card title="Existing tickets" description="Finds tickets in the selected projects where a field is empty or holds a placeholder, and the reporter has that detail. Checking changes nothing." actions={<Button appearance="subtle" disabled={scan?.running || !saved?.mappings?.length} onClick={runScan}>{scan?.running ? 'Checking…' : 'Check tickets'}</Button>}>
      <div className="nq-stack">
        {!saved?.mappings?.length && <p className="nq-help">Save the fields and projects first.</p>}
        <div className="nq-grid nq-grid--3">
          <Field label="Created from" htmlFor="detail-created-from"><input id="detail-created-from" type="date" className="nq-input" value={filter.createdFrom} onChange={(e) => setFilter((f) => ({ ...f, createdFrom: e.target.value }))}/></Field>
          <Field label="Created to" htmlFor="detail-created-to" help="Includes this day."><input id="detail-created-to" type="date" className="nq-input" value={filter.createdTo} onChange={(e) => setFilter((f) => ({ ...f, createdTo: e.target.value }))}/></Field>
          <Field label="Quick range">
            <div className="nq-inline">
              {DATE_PRESETS.map(([label, days]) => <Button key={days} appearance="subtle" small onClick={() => setFilter((f) => ({ ...f, createdFrom: daysAgo(days), createdTo: '' }))}>{label}</Button>)}
            </div>
          </Field>
        </div>
        {filter.fieldFilters.map((x, i) => {
          const opts = filterOptions[x.fieldId];
          return <div key={i} className="nq-grid nq-grid--3">
            <Field label={i === 0 ? 'Only tickets where' : 'and where'} htmlFor={`detail-filter-field-${i}`}>
              <select id={`detail-filter-field-${i}`} className="nq-select" value={x.fieldId} onChange={(e) => chooseFilterField(i, e.target.value)}>
                <option value="">Choose a dropdown field…</option>
                {setup.ticketFields.filter((f) => f.type === 'select').map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </Field>
            <Field label="is one of" htmlFor={`detail-filter-values-${i}`} help={opts?.error || (opts?.loading ? 'Loading options…' : (x.fieldId && !opts?.options?.length ? 'No options found in the saved projects.' : 'Hold Ctrl to pick several.'))}>
              <select id={`detail-filter-values-${i}`} className="nq-select" multiple size={Math.min(6, Math.max(3, opts?.options?.length || 3))} value={x.values} disabled={!x.fieldId} onChange={(e) => setFilterRow(i, { values: [...e.target.selectedOptions].map((o) => o.value) })}>
                {(opts?.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label=" "><Button appearance="subtle" small onClick={() => setFilter((f) => ({ ...f, fieldFilters: f.fieldFilters.filter((_, j) => j !== i) }))}>Remove</Button></Field>
          </div>;
        })}
        <div className="nq-spread">
          <div className="nq-inline">
            {filter.fieldFilters.length < 5 && <Button appearance="subtle" small onClick={() => setFilter((f) => ({ ...f, fieldFilters: [...f.fieldFilters, { fieldId: '', values: [] }] }))}>Add field filter</Button>}
            {(filterSummary || filter.fieldFilters.length > 0) && <Button appearance="subtle" small onClick={() => setFilter(EMPTY_FILTER)}>Clear filters</Button>}
          </div>
          <p className="nq-help">{filterSummary ? `Checks only tickets ${filterSummary}.` : 'No filters: checks every matching ticket in the saved projects.'}</p>
        </div>
        {scan?.error && <Notice kind="error" title="Couldn't finish checking tickets">{scan.error}</Notice>}
        {scan && <div className="nq-stats">
          <div className="nq-stat"><strong className="nq-stat__value">{scan.checked.toLocaleString()}</strong><span className="nq-stat__label">Checked</span></div>
          <div className="nq-stat nq-stat--warning"><strong className="nq-stat__value">{scan.needsChange.length.toLocaleString()}</strong><span className="nq-stat__label">Can be filled</span></div>
          <div className="nq-stat"><strong className="nq-stat__value">{scan.kept.toLocaleString()}</strong><span className="nq-stat__label">Other value kept</span></div>
          <div className="nq-stat"><strong className="nq-stat__value">{scan.noDetails.toLocaleString()}</strong><span className="nq-stat__label">Reporter has no details</span></div>
        </div>}
        {scan && !scan.running && !scan.error && <p className="nq-help">Last check: {scan.filterSummary ? `tickets ${scan.filterSummary}` : 'all tickets in the saved projects'}.</p>}
        {scan?.running && <Loading text={scan.waiting ? `Jira asked the app to slow down. Carrying on in 30 seconds… (${scan.checked.toLocaleString()} checked so far)` : `Checking tickets… ${scan.checked.toLocaleString()} so far.`}/>}
        {scan && !scan.running && scan.needsChange.length > 0 && <>
          <div className="nq-table-wrap"><table className="nq-table">
            <thead><tr><th>Ticket</th><th>Changes</th></tr></thead>
            <tbody>{scan.needsChange.slice(0, 100).map((x) => <tr key={x.id}><td>{x.key}</td><td>{x.changes.map((c) => `${c.detailName}: ${c.from || '(empty)'} → ${c.to}`).join(' · ')}</td></tr>)}</tbody>
          </table></div>
          {scan.needsChange.length > 100 && <p className="nq-help">Showing the first 100 of {scan.needsChange.length.toLocaleString()}.</p>}
          {!confirm
            ? <div className="nq-inline"><Button appearance="primary" disabled={readOnly || Boolean(updating && !updating.finished)} onClick={() => setConfirm(true)}>Fill in {plural(scan.needsChange.length, 'ticket')}</Button></div>
            : <Notice kind="warning" title={`Fill in ${plural(scan.needsChange.length, 'ticket')}?`}>
              <p>The fields shown will be set on these tickets, and each change appears in the ticket's history. Every ticket is re-checked first; values other than the placeholders are never overwritten.</p>
              <div className="nq-inline"><Button appearance="primary" onClick={runUpdates}>Yes, fill in {plural(scan.needsChange.length, 'ticket')}</Button><Button onClick={() => setConfirm(false)}>Cancel</Button></div>
            </Notice>}
        </>}
        {updating && (updating.finished
          ? <Notice kind={updating.failed.length ? 'warning' : 'success'} title={updating.failed.length ? 'Finished with problems' : 'Tickets filled in'}>
            Updated {plural(updating.updated, 'ticket')}. {updating.unchanged ? `${plural(updating.unchanged, 'ticket')} no longer needed it. ` : ''}{updating.failed.length ? `${plural(updating.failed.length, 'ticket')} had problems: ${updating.failed.slice(0, 5).map((f) => `${f.key} (${f.message})`).join('; ')}` : ''}{updating.failed.length ? ' Some of these may already be filled; click Check tickets again to see what is left.' : ''}
          </Notice>
          : <Loading text={`Filling in tickets… ${updating.done.toLocaleString()} of ${updating.total.toLocaleString()}.`}/>)}
      </div>
    </Card>

    <Card title="Recent changes" description="Tickets the app filled in during the last 90 days, newest first." actions={<Button appearance="subtle" onClick={() => invoke('getDetailSyncLog').then(setLog)}>Refresh</Button>}>
      {log.length ? <div className="nq-table-wrap"><table className="nq-table">
        <thead><tr><th>When</th><th>Ticket</th><th>Fields set</th><th>Why</th></tr></thead>
        <tbody>{log.map((e) => { const [label, kind] = sourceLabel[e.source] || [e.source, 'neutral']; return <tr key={`${e.at}-${e.issueKey}`}><td>{new Date(e.at).toLocaleString()}</td><td>{e.issueKey}</td><td>{(e.fields || []).join(', ') || '—'}</td><td><Lozenge kind={kind}>{label}</Lozenge>{e.error && <div className="nq-help">{e.error}</div>}</td></tr>; })}</tbody>
      </table></div> : <EmptyState title="No changes yet" compact>When the app fills in a ticket, it's listed here.</EmptyState>}
    </Card>
  </>;
}
