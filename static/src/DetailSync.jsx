import React, { useEffect, useState } from 'react';
import { Card, Button, Notice, EmptyState, Loading, Lozenge, Field } from '@nuvriqo/ui/react';

const sourceLabel = { created: ['New ticket', 'success'], 'reporter-changed': ['Reporter changed', 'info'], backfill: ['Bulk update', 'discovery'], failed: ['Failed', 'danger'] };
const CHUNK = 25;
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;

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

  async function runScan() {
    const totals = { checked: 0, correct: 0, noDetails: 0, kept: 0, needsChange: [] };
    setScan({ running: true, ...totals });
    setConfirm(false);
    setUpdating(null);
    try {
      let nextPageToken = null;
      for (let calls = 0; ; calls += 1) {
        if (calls >= 2000) throw new Error('Ticket check safety limit reached.');
        const r = await invoke('scanDetailSync', { nextPageToken });
        for (const k of ['checked', 'correct', 'noDetails', 'kept']) totals[k] += r[k] || 0;
        totals.needsChange.push(...(r.needsChange || []));
        setScan({ running: !r.complete, ...totals });
        if (r.complete) break;
        nextPageToken = r.nextPageToken;
      }
    } catch (e) { setScan((s) => ({ ...s, running: false, error: e.message })); }
  }

  async function runUpdates() {
    const items = scan.needsChange;
    const result = { updated: 0, unchanged: 0, failed: [] };
    setConfirm(false);
    setUpdating({ done: 0, total: items.length, ...result });
    for (let i = 0; i < items.length; i += CHUNK) {
      const part = items.slice(i, i + CHUNK);
      try {
        const r = await invoke('applyDetailSync', { issueIds: part.map((x) => x.id) });
        result.updated += r.updated.length;
        result.unchanged += r.unchanged.length;
        result.failed.push(...r.failed.map((f) => ({ ...f, key: f.key || part.find((x) => x.id === f.id)?.key || f.id })));
      } catch (e) {
        result.failed.push(...part.map((x) => ({ key: x.key, message: e.message })));
      }
      setUpdating({ done: Math.min(i + CHUNK, items.length), total: items.length, ...result });
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
        {scan?.error && <Notice kind="error" title="Couldn't finish checking tickets">{scan.error}</Notice>}
        {scan && <div className="nq-stats">
          <div className="nq-stat"><strong className="nq-stat__value">{scan.checked.toLocaleString()}</strong><span className="nq-stat__label">Checked</span></div>
          <div className="nq-stat nq-stat--warning"><strong className="nq-stat__value">{scan.needsChange.length.toLocaleString()}</strong><span className="nq-stat__label">Can be filled</span></div>
          <div className="nq-stat"><strong className="nq-stat__value">{scan.kept.toLocaleString()}</strong><span className="nq-stat__label">Other value kept</span></div>
          <div className="nq-stat"><strong className="nq-stat__value">{scan.noDetails.toLocaleString()}</strong><span className="nq-stat__label">Reporter has no details</span></div>
        </div>}
        {scan?.running && <Loading text={`Checking tickets… ${scan.checked.toLocaleString()} so far.`}/>}
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
            Updated {plural(updating.updated, 'ticket')}. {updating.unchanged ? `${plural(updating.unchanged, 'ticket')} no longer needed it. ` : ''}{updating.failed.length ? `${plural(updating.failed.length, 'ticket')} had problems: ${updating.failed.slice(0, 5).map((f) => `${f.key} (${f.message})`).join('; ')}` : ''}
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
