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
  firstName: ['firstname', 'givenname', 'forename', 'first'],
  lastName: ['lastname', 'surname', 'familyname', 'last'],
  organisation: ['organisation', 'organization', 'organisationname', 'organizationname', 'org', 'company', 'companyname', 'account', 'accountname']
};

// Full name comes from one column, or from First name + Last name joined with a space.
export const MAPPING_FIELDS = [
  { key: 'email', label: 'Email', required: true },
  { key: 'displayName', label: 'Full name', required: false },
  { key: 'firstName', label: 'First name', required: false },
  { key: 'lastName', label: 'Last name', required: false },
  { key: 'organisation', label: 'Organisation', required: false }
];
export const NAME_LABEL = 'Full name (or First name and Last name)';

// Best guess at which header holds each field ('' when none fits). Each header is used at most once
// for the core fields. Customer detail fields are matched on their name and may reuse a header (a
// FirstName column can feed both the name and a FirstName detail field).
export function guessMapping(headers, detailFields = []) {
  const used = new Set();
  const mapping = {};
  for (const { key } of MAPPING_FIELDS) {
    const hit = ALIASES[key].map((alias) => headers.find((h) => !used.has(h) && normalise(h) === alias)).find(Boolean);
    mapping[key] = hit || '';
    if (hit) used.add(hit);
  }
  // A full-name column wins; First/Last are only used when there isn't one.
  if (mapping.displayName) { mapping.firstName = ''; mapping.lastName = ''; }
  mapping.details = {};
  for (const field of detailFields) {
    const hit = headers.find((h) => normalise(h) === normalise(field.name));
    if (hit) mapping.details[field.name] = hit;
  }
  return mapping;
}

const hasName = (mapping, headers) => ['displayName', 'firstName', 'lastName'].some((k) => mapping?.[k] && (!headers || headers.includes(mapping[k])));

export function missingMappingFields(mapping, headers = null) {
  const missing = [];
  if (!mapping?.email || (headers && !headers.includes(mapping.email))) missing.push('Email');
  if (!hasName(mapping, headers)) missing.push(NAME_LABEL);
  return missing;
}

// Every column the mapping names, so a saved mapping is only offered for files that have them all.
export const mappedColumns = (mapping) => [...MAPPING_FIELDS.map(({ key }) => mapping?.[key]), ...Object.values(mapping?.details || {})].filter(Boolean);
export const mappingFits = (mapping, headers) => !missingMappingFields(mapping, headers).length && mappedColumns(mapping).every((h) => headers.includes(h));

// Rows in the importer's shape. Row numbers match the file (header is row 1). `details` holds the raw
// text of each mapped customer detail field; blank cells are left out so Jira keeps the current value.
export function applyMapping(table, mapping) {
  const col = (header) => (header ? table.headers.indexOf(header) : -1);
  const index = Object.fromEntries(MAPPING_FIELDS.map(({ key }) => [key, col(mapping?.[key])]));
  const detailIndex = Object.entries(mapping?.details || {}).map(([name, header]) => [name, col(header)]).filter(([, i]) => i >= 0);
  const cell = (record, i) => (i >= 0 ? String(record[i] ?? '').trim() : '');
  return table.records.map((record) => {
    const fullName = cell(record, index.displayName);
    const details = {};
    for (const [name, i] of detailIndex) {
      const value = cell(record, i);
      if (value) details[name] = value;
    }
    return {
      email: cell(record, index.email),
      displayName: fullName || [cell(record, index.firstName), cell(record, index.lastName)].filter(Boolean).join(' '),
      organisation: cell(record, index.organisation),
      details
    };
  });
}

// Saved mappings use the backend's field names.
export const toSaved = (mapping) => ({
  emailHeader: mapping.email,
  displayNameHeader: mapping.displayName || '',
  firstNameHeader: mapping.firstName || '',
  lastNameHeader: mapping.lastName || '',
  organisationHeader: mapping.organisation || '',
  detailHeaders: { ...(mapping.details || {}) }
});
export const fromSaved = (saved) => ({
  email: saved?.emailHeader || '',
  displayName: saved?.displayNameHeader || '',
  firstName: saved?.firstNameHeader || '',
  lastName: saved?.lastNameHeader || '',
  organisation: saved?.organisationHeader || '',
  details: { ...(saved?.detailHeaders || {}) }
});

// The most recently updated saved mapping whose columns all exist in this file (preferring the service project's own).
export function pickSavedMapping(saved, headers, serviceDeskId) {
  const candidates = (saved || []).filter((m) => mappingFits(fromSaved(m), headers)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return candidates.find((m) => String(m.serviceDeskId) === String(serviceDeskId)) || candidates[0] || null;
}

const detailPairs = (mapping) => Object.entries(mapping?.details || {}).filter(([, h]) => h).sort(([a], [b]) => a.localeCompare(b));
export const sameMapping = (a, b) => MAPPING_FIELDS.every(({ key }) => (a?.[key] || '') === (b?.[key] || ''))
  && JSON.stringify(detailPairs(a)) === JSON.stringify(detailPairs(b));
