// CSV reading and column mapping for the importer. Pure functions, unit-tested in test/csv.test.mjs.

// Parses CSV text (RFC 4180): quoted fields may contain commas, quotes ("") and line breaks. Handles CRLF
// and the byte-order mark Excel adds. Rows that are completely empty are dropped.
export function parseCsvTable(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      records.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); records.push(row); }
  const nonEmpty = records.filter((r) => r.some((v) => v.trim() !== ''));
  const [header = [], ...body] = nonEmpty;
  return { headers: header.map((h) => h.trim()), records: body.map((r) => r.map((v) => v.trim())) };
}

const normalise = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = {
  email: ['email', 'emailaddress', 'mail', 'emailid', 'customeremail', 'contactemail', 'workemail'],
  displayName: ['displayname', 'fullname', 'name', 'customername', 'contactname', 'username', 'customer'],
  organisation: ['organisation', 'organization', 'organisationname', 'organizationname', 'org', 'company', 'companyname', 'account', 'accountname']
};

export const MAPPING_FIELDS = [
  { key: 'email', label: 'Email', required: true },
  { key: 'displayName', label: 'Full name', required: true },
  { key: 'organisation', label: 'Organisation', required: false }
];

// Best guess at which header holds each field ('' when none fits). Each header is used at most once.
export function guessMapping(headers) {
  const used = new Set();
  const mapping = {};
  for (const { key } of MAPPING_FIELDS) {
    const hit = ALIASES[key].map((alias) => headers.find((h) => !used.has(h) && normalise(h) === alias)).find(Boolean);
    mapping[key] = hit || '';
    if (hit) used.add(hit);
  }
  return mapping;
}

export function missingMappingFields(mapping, headers = null) {
  return MAPPING_FIELDS.filter((f) => f.required && (!mapping?.[f.key] || (headers && !headers.includes(mapping[f.key])))).map((f) => f.label);
}

// Rows in the importer's shape. Row numbers match the file (header is row 1).
export function applyMapping(table, mapping) {
  const index = Object.fromEntries(MAPPING_FIELDS.map(({ key }) => [key, mapping?.[key] ? table.headers.indexOf(mapping[key]) : -1]));
  const cell = (record, key) => (index[key] >= 0 ? record[index[key]] ?? '' : '');
  return table.records.map((record) => ({
    email: cell(record, 'email'),
    displayName: cell(record, 'displayName'),
    organisation: cell(record, 'organisation')
  }));
}

// Saved mappings use the backend's field names.
export const toSaved = (mapping) => ({ emailHeader: mapping.email, displayNameHeader: mapping.displayName, organisationHeader: mapping.organisation || '' });
export const fromSaved = (saved) => ({ email: saved?.emailHeader || '', displayName: saved?.displayNameHeader || '', organisation: saved?.organisationHeader || '' });

// The most recently updated saved mapping whose columns all exist in this file (preferring the service project's own).
export function pickSavedMapping(saved, headers, serviceDeskId) {
  const fits = (m) => [m.emailHeader, m.displayNameHeader].every((h) => h && headers.includes(h)) && (!m.organisationHeader || headers.includes(m.organisationHeader));
  const candidates = (saved || []).filter(fits).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return candidates.find((m) => String(m.serviceDeskId) === String(serviceDeskId)) || candidates[0] || null;
}

export const sameMapping = (a, b) => MAPPING_FIELDS.every(({ key }) => (a?.[key] || '') === (b?.[key] || ''));
