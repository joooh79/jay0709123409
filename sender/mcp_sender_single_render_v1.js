#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || '';
const CURRENT_STATE_MCP_BASE_URL = process.env.CURRENT_STATE_MCP_BASE_URL || '';

const sessions = new Map();

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization'
  };
}

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

function sendNoContent(res, statusCode = 204, extraHeaders = {}) {
  res.writeHead(statusCode, {
    ...corsHeaders(),
    ...extraHeaders
  });
  res.end();
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

function requireObject(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

function isGarbledText(value) {
  return typeof value === 'string' && value.includes('�');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactArray(arr) {
  return Array.isArray(arr) ? arr.filter((v) => v !== undefined) : [];
}

function normalizeOptionalText(value) {
  return value === undefined || value === null ? '' : value;
}

function validatePayloadShape(payload) {
  requireObject(payload, 'payload');
  requireObject(payload.workflow, 'payload.workflow');
  requireObject(payload.patients, 'payload.patients');
  requireObject(payload.visits, 'payload.visits');
  requireObject(payload.findings_present, 'payload.findings_present');

  if (!Array.isArray(payload.findings_records)) {
    throw new Error('payload.findings_records must be an array');
  }

  const patientId = safeString(payload.patients.patient_id);
  if (!patientId) {
    throw new Error('payload.patients.patient_id is required');
  }

  const visitDate = safeString(payload.visits.date);
  if (!visitDate) {
    throw new Error('payload.visits.date is required');
  }

  const visitId = safeString(payload.visits.visit_id);
  if (!visitId) {
    throw new Error('payload.visits.visit_id is required');
  }

  if (payload.findings_records.length === 0) {
    throw new Error('payload.findings_records must contain at least one record');
  }
}

function buildDeterministicRecordName(visitId, toothNumber, branchCode) {
  return `${visitId}-${toothNumber}-${branchCode}`;
}

function normalizePainLevel(value) {
  if (value === '' || value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'number') {
    return value;
  }

  const coerced = Number(value);
  return Number.isNaN(coerced) ? '' : coerced;
}

function transformCanonicalPayload(payload) {
  validatePayloadShape(payload);

  const inputJson = JSON.stringify(payload);
  const inputHash = sha256(inputJson);

  const transformed = {
    workflow: {
      mode: '',
      patient_status_claim: safeString(payload.workflow.patient_status_claim),
      visit_intent_claim: safeString(payload.workflow.visit_intent_claim),
      target_visit_date: normalizeOptionalText(payload.workflow.target_visit_date),
      target_visit_id: normalizeOptionalText(payload.workflow.target_visit_id),
      target_visit_clue: normalizeOptionalText(payload.workflow.target_visit_clue),
      uncertainty_note: normalizeOptionalText(payload.workflow.uncertainty_note),
      patient_recheck_attempted:
        payload.workflow.patient_recheck_attempted === true
          ? true
          : normalizeOptionalText(payload.workflow.patient_recheck_attempted),
      doctor_confirmed_correction:
        payload.workflow.doctor_confirmed_correction === true
          ? true
          : payload.workflow.doctor_confirmed_correction === false
            ? false
            : normalizeOptionalText(payload.workflow.doctor_confirmed_correction)
    },
    patients: {
      patient_id: safeString(payload.patients.patient_id),
      birth_year: normalizeOptionalText(payload.patients.birth_year),
      gender: normalizeOptionalText(payload.patients.gender)
    },
    visits: {
      visit_id: safeString(payload.visits.visit_id),
      date: safeString(payload.visits.date),
      visit_type: normalizeOptionalText(payload.visits.visit_type),
      chief_complaint: normalizeOptionalText(payload.visits.chief_complaint),
      pain_level: normalizePainLevel(payload.visits.pain_level)
    },
    findings_present: {
      pre_op: !!payload.findings_present.pre_op,
      radiographic: !!payload.findings_present.radiographic,
      operative: !!payload.findings_present.operative,
      diagnosis: !!payload.findings_present.diagnosis,
      treatment_plan: !!payload.findings_present.treatment_plan,
      doctor_reasoning: !!payload.findings_present.doctor_reasoning
    },
    findings_records: compactArray(
      payload.findings_records.map((record) => {
        requireObject(record, 'payload.findings_records[]');
        requireObject(record.fields, 'payload.findings_records[].fields');

        const visitId = safeString(record.visit_id || payload.visits.visit_id);
        const toothNumber = safeString(record.tooth_number);
        const branchCode = safeString(record.branch_code);
        const recordName =
          safeString(record.record_name) ||
          buildDeterministicRecordName(visitId, toothNumber, branchCode);

        return {
          branch_key: safeString(record.branch_key),
          branch_code: branchCode,
          branch_label: safeString(record.branch_label),
          visit_id: visitId,
          tooth_number: toothNumber,
          record_name: recordName,
          fields: {
            ...deepClone(record.fields),
            'Record name': recordName,
            'Visit ID': visitId,
            'Tooth number': toothNumber
          }
        };
      })
    ),
    record_name_rule: '{Visit ID}-{Tooth number}-{BRANCH CODE}',
    record_name_generation_source: 'sender_deterministic'
  };

  const transformedJson = JSON.stringify(transformed);
  const transformedHash = sha256(transformedJson);

  return {
    request_id: crypto.randomUUID(),
    status: 'SUCCESS',
    stage: 'TRANSFORM',
    input_hash: inputHash,
    transformed_hash: transformedHash,
    transformed_payload: transformed,
    debug: {
      validation_passed: true,
      contract_valid: true,
      transformation_applied: true,
      parity_mode: 'findings_records'
    }
  };
}


function isExistingVisitUpdatePayload(payload) {
  return (
    safeString(payload?.workflow?.mode) === 'existing_visit_update' &&
    safeString(payload?.workflow?.patient_status_claim) === 'existing_patient' &&
    safeString(payload?.workflow?.visit_intent_claim) === 'existing_visit_update'
  );
}

function hasPhase1HeaderTouch(payload) {
  const patients = payload?.patients || {};
  const visits = payload?.visits || {};

  return Boolean(
    patients.birth_year !== undefined ||
    patients.gender !== undefined ||
    visits.chief_complaint !== undefined ||
    visits.pain_level !== undefined ||
    visits.visit_type !== undefined
  );
}

function hasPhase1SymptomTouch(payload) {
  const records = Array.isArray(payload?.findings_records) ? payload.findings_records : [];

  return records.some((record) => {
    const branchKey = safeString(record?.branch_key);
    const fields = record?.fields || {};
    return branchKey === 'pre_op' && fields.Symptom !== undefined;
  });
}

function isPhase1ApplicableExistingVisitUpdate(payload) {
  if (!isExistingVisitUpdatePayload(payload)) return false;
  return hasPhase1HeaderTouch(payload) || hasPhase1SymptomTouch(payload);
}

function normalizeStringArray(value) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : value && typeof value === 'object'
        ? [value]
        : [];

  return rawItems
    .map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return safeString(item.value || item.label || item.name || item.title).trim();
      }
      return safeString(item).trim();
    })
    .filter(Boolean);
}

function mergeMultiSelectAdd(storedArr, incomingArr) {
  const stored = normalizeStringArray(storedArr);
  const incoming = normalizeStringArray(incomingArr);
  const seen = new Set();
  const merged = [];

  for (const item of [...stored, ...incoming]) {
    if (seen.has(item)) continue;
    seen.add(item);
    merged.push(item);
  }

  return merged;
}


function getCurrentStateBaseUrl() {
  return CURRENT_STATE_MCP_BASE_URL.replace(/\/+$/, '');
}

function expandUrlTemplate(template, values) {
  return safeString(template).replace(/\{(\w+)\}/g, (_, key) => {
    const aliases = {
      id: 'fetchId',
      fetch_id: 'fetchId',
      fetchId: 'fetchId'
    };
    const resolvedKey = aliases[key] || key;
    const value = values[resolvedKey];
    return encodeURIComponent(value === undefined || value === null ? '' : String(value));
  });
}

function buildCurrentStateFetchCandidates(fetchId) {
  const base = getCurrentStateBaseUrl();
  const candidates = [];
  const template = safeString(process.env.CURRENT_STATE_FETCH_URL_TEMPLATE);

  if (template) {
    candidates.push(expandUrlTemplate(template, { fetchId }));
  }

  if (base) {
    candidates.push(`${base}/fetch?id=${encodeURIComponent(fetchId)}`);
    candidates.push(`${base}/api/fetch?id=${encodeURIComponent(fetchId)}`);
    candidates.push(`${base}/mcp/fetch?id=${encodeURIComponent(fetchId)}`);
    candidates.push(`${base}?op=fetch&id=${encodeURIComponent(fetchId)}`);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function httpRequestJson(urlString, method = 'GET', body = undefined, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const client = parsed.protocol === 'https:' ? https : http;
    const payload = body === undefined ? undefined : JSON.stringify(body);

    const req = client.request(
      parsed,
      {
        method,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(payload)
              }
            : {})
        }
      },
      (res) => {
        let raw = '';

        res.on('data', (chunk) => {
          raw += chunk;
        });

        res.on('end', () => {
          let parsedBody = null;
          let parseError = null;

          try {
            parsedBody = raw ? JSON.parse(raw) : {};
          } catch (error) {
            parseError = error;
          }

          resolve({
            status: res.statusCode || 0,
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300 && !parseError,
            body: parsedBody,
            raw_text: raw,
            parse_error: parseError,
            url: urlString,
            method
          });
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Current-state fetch timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function tryFetchById(fetchId) {
  const candidates = buildCurrentStateFetchCandidates(fetchId);
  if (candidates.length === 0) {
    return {
      ok: false,
      status: 0,
      body: null,
      raw_text: '',
      last_error: 'CURRENT_STATE_MCP_BASE_URL is not configured',
      attempted_urls: []
    };
  }

  const attempted = [];
  for (const url of candidates) {
    try {
      const resp = await httpRequestJson(url, 'GET');
      attempted.push({
        url,
        status: resp.status,
        ok: resp.ok,
        raw_text: resp.raw_text
      });
      if (resp.ok) {
        return {
          ...resp,
          attempted_urls: attempted
        };
      }
    } catch (error) {
      attempted.push({
        url,
        status: 0,
        ok: false,
        raw_text: String(error && error.message ? error.message : error)
      });
    }
  }

  return {
    ok: false,
    status: attempted.length > 0 ? attempted[attempted.length - 1].status : 0,
    body: null,
    raw_text: attempted.length > 0 ? attempted[attempted.length - 1].raw_text : '',
    last_error: 'Current-state fetch failed for all candidate URLs',
    attempted_urls: attempted
  };
}

async function fetchPatient(patientId) {
  return tryFetchById(`patient:${patientId}`);
}

async function fetchVisitByDate(patientId, visitDate) {
  return tryFetchById(`visit_by_date:${patientId}:${visitDate}`);
}

async function fetchVisitChildren(visitRecordId) {
  return tryFetchById(`visit_children:${visitRecordId}`);
}

async function fetchRecord(tableAlias, recordId) {
  return tryFetchById(`record:${tableAlias}:${recordId}`);
}

function getBodyRecord(body) {
  if (body && typeof body === 'object') {
    if (body.result && typeof body.result === 'object') {
      if (body.result.record && typeof body.result.record === 'object') return body.result.record;
      if (body.result.item && typeof body.result.item === 'object') return body.result.item;
    }
    if (body.record && typeof body.record === 'object') return body.record;
    return body;
  }
  return {};
}

function getRecordFields(body) {
  const record = getBodyRecord(body);
  if (record && typeof record.fields === 'object' && record.fields !== null) {
    return record.fields;
  }
  if (record && typeof record.record_fields === 'object' && record.record_fields !== null) {
    return record.record_fields;
  }
  if (body && typeof body.record_fields === 'object' && body.record_fields !== null) {
    return body.record_fields;
  }
  return {};
}

function getVisitRecordIdFromBody(body) {
  const record = getBodyRecord(body);
  return safeString(record.id || body?.recordId || body?.id);
}

function getRecordsArray(body) {
  if (Array.isArray(body?.result?.records)) return body.result.records;
  if (Array.isArray(body?.records)) return body.records;
  if (Array.isArray(body?.result?.children)) return body.result.children;
  if (Array.isArray(body?.children)) return body.children;
  if (Array.isArray(body?.result?.items)) return body.result.items;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

function getPreOpChildIds(childrenBody) {
  const direct = childrenBody?.child_link_summary?.pre_op_clinical_findings;
  if (Array.isArray(direct)) return direct.map((v) => safeString(v)).filter(Boolean);

  const nested = childrenBody?.result?.child_link_summary?.pre_op_clinical_findings;
  if (Array.isArray(nested)) return nested.map((v) => safeString(v)).filter(Boolean);

  const alt1 = childrenBody?.pre_op_clinical_findings;
  if (Array.isArray(alt1)) return alt1.map((v) => safeString(v)).filter(Boolean);

  const alt2 = childrenBody?.result?.pre_op_clinical_findings;
  if (Array.isArray(alt2)) return alt2.map((v) => safeString(v)).filter(Boolean);

  return [];
}

function makePreOpLookupKey(toothNumber, recordName) {
  return `${safeString(toothNumber)}::${safeString(recordName)}`;
}

function findPreOpSnapshotMatch(preOpEntries, toothNumber, recordName) {
  const entries = Array.isArray(preOpEntries) ? preOpEntries : [];
  const normalizedTooth = safeString(toothNumber);
  const normalizedRecordName = safeString(recordName);

  const exact = entries.find((entry) => {
    const fields = getRecordFields(entry?.body);
    return (
      safeString(fields['Tooth number']) === normalizedTooth &&
      safeString(fields['Record name']) === normalizedRecordName
    );
  });
  if (exact?.recordId) {
    const fields = getRecordFields(exact.body);
    return {
      id: exact.recordId,
      resolution: 'matched_existing_row',
      matched_record_name: safeString(fields['Record name']) || normalizedRecordName,
      body: exact.body
    };
  }

  const fallback = entries.find((entry) => {
    const fields = getRecordFields(entry?.body);
    return safeString(fields['Tooth number']) === normalizedTooth;
  });
  if (fallback?.recordId) {
    const fields = getRecordFields(fallback.body);
    return {
      id: fallback.recordId,
      resolution: 'matched_by_tooth_fallback',
      matched_record_name: safeString(fields['Record name']) || normalizedRecordName,
      body: fallback.body
    };
  }

  return {
    id: '',
    resolution: 'unresolved',
    matched_record_name: '',
    body: null
  };
}


function hasAnyPreOpFindingsTouch(transformedPayload) {
  const findings = Array.isArray(transformedPayload?.findings_records)
    ? transformedPayload.findings_records
    : [];
  return findings.some((record) => {
    if (safeString(record?.branch_key) !== 'pre_op') return false;
    const fields = record?.fields || {};
    return Object.keys(fields).some((key) => !['Record name', 'Visit ID', 'Tooth number'].includes(key));
  });
}

function hasSymptomTouch(transformedPayload) {
  const findings = Array.isArray(transformedPayload?.findings_records)
    ? transformedPayload.findings_records
    : [];
  return findings.some((record) => safeString(record?.branch_key) === 'pre_op' && record?.fields?.Symptom !== undefined);
}

async function buildExistingVisitUpdateCurrentState(transformedPayload) {
  const patientId = safeString(transformedPayload?.patients?.patient_id);
  const visitDate = safeString(transformedPayload?.visits?.date);
  const symptomTouched = hasSymptomTouch(transformedPayload);
  const needPreOpRecords = symptomTouched || hasAnyPreOpFindingsTouch(transformedPayload);
  const needPatientState = transformedPayload?.patients?.birth_year !== undefined || transformedPayload?.patients?.gender !== undefined;

  let patientResp = null;
  if (needPatientState && patientId) {
    patientResp = await fetchPatient(patientId);
  }

  const visitResp = await fetchVisitByDate(patientId, visitDate);
  if (!visitResp.ok) {
    return {
      ready: false,
      fatal: symptomTouched,
      reason_code: 'CURRENT_STATE_VISIT_FETCH_FAILED',
      reason_message: 'Current-state visit fetch failed',
      diagnostics: {
        fetch_id: `visit_by_date:${patientId}:${visitDate}`,
        attempted_urls: visitResp.attempted_urls || [],
        raw_text: visitResp.raw_text || '',
        status: visitResp.status || 0
      },
      visitRecordId: '',
      visitBody: {},
      visitChildrenBody: {},
      patientBody: patientResp && patientResp.ok ? patientResp.body : {},
      preOpRecordsByTooth: {},
      preOpRecordsByLookup: {}
    };
  }

  const visitRecordId = getVisitRecordIdFromBody(visitResp.body);
  if (!visitRecordId) {
    return {
      ready: false,
      fatal: symptomTouched,
      reason_code: 'CURRENT_STATE_TARGET_VISIT_NOT_FOUND',
      reason_message: 'Target visit not found for existing_visit_update',
      diagnostics: {
        fetch_id: `visit_by_date:${patientId}:${visitDate}`,
        attempted_urls: visitResp.attempted_urls || []
      },
      visitRecordId: '',
      visitBody: visitResp.body || {},
      visitChildrenBody: {},
      patientBody: patientResp && patientResp.ok ? patientResp.body : {},
      preOpRecordsByTooth: {},
      preOpRecordsByLookup: {}
    };
  }

  const state = {
    ready: true,
    fatal: false,
    diagnostics: {},
    visitRecordId,
    patientBody: patientResp && patientResp.ok ? patientResp.body : {},
    visitBody: visitResp.body,
    visitChildrenBody: {},
    preOpRecordsByTooth: {},
    preOpRecordsByLookup: {}
  };

  if (!needPreOpRecords) {
    return state;
  }

  const childrenResp = await fetchVisitChildren(visitRecordId);
  if (!childrenResp.ok) {
    return {
      ...state,
      ready: false,
      fatal: symptomTouched,
      reason_code: 'CURRENT_STATE_VISIT_CHILDREN_FETCH_FAILED',
      reason_message: 'Visit children fetch failed',
      diagnostics: {
        fetch_id: `visit_children:${visitRecordId}`,
        attempted_urls: childrenResp.attempted_urls || [],
        raw_text: childrenResp.raw_text || '',
        status: childrenResp.status || 0
      }
    };
  }

  state.visitChildrenBody = childrenResp.body;

  const allPreOpIds = getPreOpChildIds(childrenResp.body);
  const fetchedPreOpEntries = [];

  for (const childRecordId of allPreOpIds) {
    const recordResp = await fetchRecord('pre_op', childRecordId);
    if (!recordResp.ok) {
      continue;
    }
    fetchedPreOpEntries.push({
      recordId: childRecordId,
      body: recordResp.body
    });
  }

  const findings = Array.isArray(transformedPayload?.findings_records)
    ? transformedPayload.findings_records
    : [];

  for (const record of findings) {
    if (safeString(record?.branch_key) !== 'pre_op') continue;

    const toothNumber = safeString(record?.tooth_number);
    const recordName = safeString(record?.record_name);
    const childLookup = findPreOpSnapshotMatch(fetchedPreOpEntries, toothNumber, recordName);
    const childRecordId = childLookup.id;

    if (!childRecordId) {
      if (record?.fields?.Symptom !== undefined) {
        state.preOpRecordsByLookup[makePreOpLookupKey(toothNumber, recordName)] = {
          recordId: '',
          requestedRecordName: recordName,
          matchedRecordName: '',
          row_resolution: 'unresolved',
          body: null
        };
      }
      continue;
    }

    const entry = {
      recordId: childRecordId,
      requestedRecordName: recordName,
      matchedRecordName: childLookup.matched_record_name || recordName,
      row_resolution: childLookup.resolution || 'matched_existing_row',
      body: childLookup.body
    };

    state.preOpRecordsByLookup[makePreOpLookupKey(toothNumber, recordName)] = entry;

    if (
      !state.preOpRecordsByTooth[toothNumber] ||
      state.preOpRecordsByTooth[toothNumber].row_resolution !== 'matched_existing_row'
    ) {
      state.preOpRecordsByTooth[toothNumber] = entry;
    }
  }

  return state;
}


function detectHeaderTouchedFields(transformedPayload) {
  const patients = transformedPayload?.patients || {};
  const visits = transformedPayload?.visits || {};

  return {
    patients: {
      birth_year: patients.birth_year !== undefined && patients.birth_year !== '',
      gender: patients.gender !== undefined && patients.gender !== ''
    },
    visits: {
      chief_complaint:
        visits.chief_complaint !== undefined && visits.chief_complaint !== '',
      pain_level:
        visits.pain_level !== undefined && visits.pain_level !== '',
      visit_type: visits.visit_type !== undefined && visits.visit_type !== ''
    }
  };
}

function detectFindingsTouchedFields(transformedPayload) {
  const findings = Array.isArray(transformedPayload?.findings_records)
    ? transformedPayload.findings_records
    : [];

  const result = {
    pre_op: {}
  };

  for (const record of findings) {
    if (safeString(record?.branch_key) !== 'pre_op') continue;

    const toothNumber = safeString(record?.tooth_number);
    const recordName = safeString(record?.record_name);
    const fields = record?.fields || {};

    const touchedFields = Object.keys(fields).filter((key) => {
      if (key === 'Record name' || key === 'Visit ID' || key === 'Tooth number') {
        return false;
      }
      return fields[key] !== undefined;
    });

    if (touchedFields.length === 0) continue;

    result.pre_op[toothNumber] = {
      record_name: recordName,
      touchedFields
    };
  }

  return result;
}

function resolveUpdateScope(headerTouched, findingsTouched) {
  const hasHeader =
    Object.values(headerTouched.patients || {}).some(Boolean) ||
    Object.values(headerTouched.visits || {}).some(Boolean);
  const hasFindings = Object.keys(findingsTouched.pre_op || {}).length > 0;

  if (hasHeader && hasFindings) return 'mixed';
  if (hasHeader) return 'header_only';
  if (hasFindings) return 'findings_only';
  return 'findings_only';
}

function getStoredPreOpEntry(currentState, toothNumber, recordName = '') {
  const exact = currentState?.preOpRecordsByLookup?.[makePreOpLookupKey(toothNumber, recordName)];
  if (exact) return exact;
  return currentState?.preOpRecordsByTooth?.[safeString(toothNumber)] || null;
}

function getStoredPreOpField(currentState, toothNumber, fieldName, recordName = '') {
  const entry = getStoredPreOpEntry(currentState, toothNumber, recordName);
  const fields = getRecordFields(entry?.body);
  return fields[fieldName];
}

function getStoredPreOpRowResolution(currentState, toothNumber, recordName = '') {
  const entry = getStoredPreOpEntry(currentState, toothNumber, recordName);
  return entry?.row_resolution || 'unresolved';
}

function buildPhase1MultiplePreview(transformedPayload, currentState) {
  const findings = Array.isArray(transformedPayload?.findings_records)
    ? transformedPayload.findings_records
    : [];

  const items = [];

  for (const record of findings) {
    if (safeString(record?.branch_key) !== 'pre_op') continue;

    const incomingSymptom = record?.fields?.Symptom;
    if (incomingSymptom === undefined) continue;

    const toothNumber = safeString(record?.tooth_number);
    const recordName = safeString(record?.record_name);
    const before = normalizeStringArray(
      getStoredPreOpField(currentState, toothNumber, 'Symptom', recordName)
    );
    const incoming = normalizeStringArray(incomingSymptom);
    const afterIfAdd = mergeMultiSelectAdd(before, incoming);
    const rowResolution = getStoredPreOpRowResolution(currentState, toothNumber, recordName);

    items.push({
      number: items.length + 1,
      key: `pre_op.${toothNumber}.Symptom`,
      branch: 'pre_op',
      tooth_number: toothNumber,
      record_name: recordName,
      field: 'Symptom',
      before,
      incoming,
      default_policy: 'add',
      after_if_add: afterIfAdd,
      write_target_type: 'finding_row',
      row_resolution: rowResolution,
      merge_mode: 'add',
      current_live_before: before,
      expected_after_if_add: afterIfAdd
    });
  }

  return {
    stage: 'multiple_policy_preview',
    items,
    prompt:
      'add가 아니라 replace로 바꾸고 싶은 항목 번호를 입력하세요. 없으면 0을 입력하세요.'
  };
}


function normalizeChoiceToken(raw) {
  if (raw === undefined || raw === null) return '';
  if (raw === true) return 'true';
  if (raw === false) return 'false';
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'string') return raw.trim().toLowerCase();
  return '';
}

function parseStage1ChoiceToReplaceOverrides(rawChoice, stage1Preview) {
  const token = normalizeChoiceToken(rawChoice);
  const items = Array.isArray(stage1Preview?.items) ? stage1Preview.items : [];

  if (token === '' || token === '0' || token === 'keep_add' || token === 'add') {
    return [];
  }

  if (token === 'replace' && items.length > 0) {
    return [items[0].key];
  }

  if (/^\d+$/.test(token)) {
    const number = Number(token);
    if (number === 0) return [];
    const matched = items.find((item) => item.number === number);
    if (matched?.key) return [matched.key];
  }

  return [];
}

function extractPhase1Stage1Input(input) {
  if (input === undefined || input === null || input === '') {
    return undefined;
  }

  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return input;
  }

  if (input && typeof input === 'object') {
    if (Array.isArray(input.replaceOverrides)) return input;

    const candidates = [
      input.phase1_multiple_policy_choice,
      input.multiple_policy_choice,
      input.stage1_choice,
      input.choice,
      input.preview_choice
    ];

    for (const candidate of candidates) {
      if (candidate !== undefined && candidate !== null && candidate !== '') {
        return candidate;
      }
    }
  }

  return undefined;
}

function parsePhase1Decision(input, stage1Preview) {
  if (input === undefined || input === null || input === '') {
    return {
      replaceOverrides: []
    };
  }

  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return {
      replaceOverrides: parseStage1ChoiceToReplaceOverrides(input, stage1Preview)
    };
  }

  if (input && typeof input === 'object') {
    if (Array.isArray(input.replaceOverrides)) {
      return {
        replaceOverrides: input.replaceOverrides
          .map((item) => (typeof item === 'string' ? item : ''))
          .map((item) => item.trim())
          .filter(Boolean)
      };
    }

    const extracted = extractPhase1Stage1Input(input);
    return {
      replaceOverrides: parseStage1ChoiceToReplaceOverrides(extracted, stage1Preview)
    };
  }

  return {
    replaceOverrides: []
  };
}

function resolveFieldPolicy(changeKey, fieldName, decision) {
  const overrides = Array.isArray(decision?.replaceOverrides)
    ? decision.replaceOverrides
    : [];

  if (fieldName === 'Symptom') {
    return overrides.includes(changeKey) ? 'replace' : 'add';
  }

  return 'replace';
}

function normalizeComparableValue(section, field, value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (Array.isArray(value)) {
    return normalizeStringArray(value);
  }

  const key = `${section}.${field}`;

  if (key === 'patients.birth_year' || key === 'visits.pain_level') {
    if (value === '') return '';
    const coerced = Number(value);
    return Number.isNaN(coerced) ? safeString(value).trim() : coerced;
  }

  if (typeof value === 'number') {
    return value;
  }

  return safeString(value).trim();
}

function valuesEqual(a, b, section = '', field = '') {
  return JSON.stringify(normalizeComparableValue(section, field, a)) === JSON.stringify(normalizeComparableValue(section, field, b));
}

function buildPhase1Stage1ChoiceGuide() {
  return {
    next_step_type: 'sender_transform',
    send_ready: false,
    requires_confirmation_args: false,
    requires_choice_args: true,
    confirmation_field_path: '',
    choice_field_path: 'phase1_decision.phase1_multiple_policy_choice',
    confirmation_value_for_each_choice: {
      '0': 'keep_add',
      '1': 'replace'
    },
    arg_patch_per_choice: {
      '0': {
        phase1_decision: {
          phase1_multiple_policy_choice: 0
        }
      },
      '1': {
        phase1_decision: {
          phase1_multiple_policy_choice: 1
        }
      }
    }
  };
}

function buildPhase1Stage2ChoiceGuide() {
  return {
    next_step_type: 'sender_send',
    send_ready: false,
    requires_confirmation_args: true,
    requires_choice_args: false,
    confirmation_field_path: 'phase1_decision.phase1_full_preview_confirmation',
    confirmation_value_for_each_choice: {
      '1': 'send_now',
      '2': 'cancel'
    },
    accepted_confirmation_values: {
      send_now: [1, '1', 'send_now', true],
      cancel: [2, '2', 'cancel', false]
    },
    arg_patch_per_choice: {
      '1': {
        phase1_decision: {
          phase1_full_preview_confirmation: 1
        }
      },
      '2': {
        phase1_decision: {
          phase1_full_preview_confirmation: 2
        }
      }
    }
  };
}

function buildPhase1FullPreview(transformedPayload, currentState, headerTouched, findingsTouched, decision) {
  const headerChanges = [];
  const findingsChanges = [];
  const patientFields = getRecordFields(currentState?.patientBody);
  const visitFields = getRecordFields(currentState?.visitBody);
  const replaceOverrideAppliedTo = deepClone(decision?.replaceOverrides || []);

  if (headerTouched.patients.birth_year) {
    const before = patientFields['Birth year'] ?? '(current-state unavailable)';
    const incoming = transformedPayload?.patients?.birth_year || '';
    headerChanges.push({
      section: 'patients',
      field: 'birth_year',
      before,
      incoming,
      policy: 'replace',
      after: incoming,
      no_op: valuesEqual(before, incoming, 'patients', 'birth_year')
    });
  }

  if (headerTouched.patients.gender) {
    const before = patientFields['Gender'] ?? '(current-state unavailable)';
    const incoming = transformedPayload?.patients?.gender || '';
    headerChanges.push({
      section: 'patients',
      field: 'gender',
      before,
      incoming,
      policy: 'replace',
      after: incoming,
      no_op: valuesEqual(before, incoming, 'patients', 'gender')
    });
  }

  if (headerTouched.visits.chief_complaint) {
    const before = visitFields['Chief Complaint'] || '';
    const incoming = transformedPayload?.visits?.chief_complaint || '';
    headerChanges.push({
      section: 'visits',
      field: 'chief_complaint',
      before,
      incoming,
      policy: 'replace',
      after: incoming,
      no_op: valuesEqual(before, incoming, 'visits', 'chief_complaint')
    });
  }

  if (headerTouched.visits.pain_level) {
    const before = visitFields['Pain level'] ?? '';
    const incoming = transformedPayload?.visits?.pain_level ?? '';
    headerChanges.push({
      section: 'visits',
      field: 'pain_level',
      before,
      incoming,
      policy: 'replace',
      after: incoming,
      no_op: valuesEqual(before, incoming, 'visits', 'pain_level')
    });
  }

  if (headerTouched.visits.visit_type) {
    const before = visitFields['Visit type'] || '';
    const incoming = transformedPayload?.visits?.visit_type || '';
    headerChanges.push({
      section: 'visits',
      field: 'visit_type',
      before,
      incoming,
      policy: 'replace',
      after: incoming,
      no_op: valuesEqual(before, incoming, 'visits', 'visit_type')
    });
  }

  const findings = Array.isArray(transformedPayload?.findings_records)
    ? transformedPayload.findings_records
    : [];

  for (const record of findings) {
    if (safeString(record?.branch_key) !== 'pre_op') continue;

    const toothNumber = safeString(record?.tooth_number);
    const fields = record?.fields || {};
    const recordName = safeString(record?.record_name);

    for (const [fieldName, incomingValue] of Object.entries(fields)) {
      if (fieldName === 'Record name' || fieldName === 'Visit ID' || fieldName === 'Tooth number') {
        continue;
      }

      const beforeValue = getStoredPreOpField(currentState, toothNumber, fieldName, recordName);
      const rowResolution = getStoredPreOpRowResolution(currentState, toothNumber, recordName);
      const changeKey = `pre_op.${toothNumber}.${fieldName}`;
      const policy = resolveFieldPolicy(changeKey, fieldName, decision);

      let afterValue;
      if (fieldName === 'Symptom' && policy === 'add') {
        afterValue = mergeMultiSelectAdd(beforeValue, incomingValue);
      } else if (Array.isArray(incomingValue)) {
        afterValue = deepClone(incomingValue);
      } else {
        afterValue = incomingValue;
      }

      const noOp = valuesEqual(beforeValue, afterValue, 'pre_op', fieldName);

      findingsChanges.push({
        branch: 'pre_op',
        tooth_number: toothNumber,
        record_name: recordName,
        field: fieldName,
        before: beforeValue,
        incoming: incomingValue,
        policy,
        after: afterValue,
        no_op: noOp,
        write_target_type: 'finding_row',
        row_resolution: rowResolution,
        merge_mode: noOp ? 'no_op' : policy,
        current_live_before: beforeValue,
        expected_after: afterValue
      });
    }
  }

  return {
    route_summary: {
      patient_id: transformedPayload?.patients?.patient_id || '',
      visit_id: transformedPayload?.visits?.visit_id || '',
      visit_date: transformedPayload?.visits?.date || '',
      route: 'existing_visit_update',
      update_scope: resolveUpdateScope(headerTouched, findingsTouched)
    },
    policy_summary: {
      multiple_default_policy: 'add',
      replace_override_applied_to: replaceOverrideAppliedTo
    },
    header_changes: headerChanges,
    findings_changes: findingsChanges,
    execution_summary: {
      header_fields_to_update: headerChanges
        .filter((item) => !item.no_op)
        .map((item) => `${item.section}.${item.field}`),
      findings_records_to_update: [
        ...new Set(findingsChanges.filter((item) => !item.no_op).map((item) => item.record_name))
      ],
      add_applied_fields: findingsChanges
        .filter((item) => item.policy === 'add' && !item.no_op)
        .map((item) => `${item.branch}.${item.tooth_number}.${item.field}`),
      replace_applied_fields: findingsChanges
        .filter((item) => item.policy === 'replace' && !item.no_op)
        .map((item) => `${item.branch}.${item.tooth_number}.${item.field}`)
    },
    confirmation: {
      message: '기존 방문 업데이트 preview입니다. 이 내용대로 적용할까요?',
      choices: ['1. 이대로 진행', '2. 취소']
    }
  };
}

function buildSenderExecutionMetadata(headerTouched, stage2Preview, decision) {
  const grouped = {};

  for (const change of stage2Preview.findings_changes || []) {
    const toothNumber = safeString(change.tooth_number);
    grouped[toothNumber] ||= {
      record_name: change.record_name || '',
      fields: {}
    };
    grouped[toothNumber].fields[change.field] = !change.no_op;
  }

  const headerFlags = {
    patients: {
      birth_year: false,
      gender: false
    },
    visits: {
      chief_complaint: false,
      pain_level: false,
      visit_type: false
    }
  };

  for (const change of stage2Preview.header_changes || []) {
    if (change.section === 'patients' && change.field in headerFlags.patients) {
      headerFlags.patients[change.field] = !change.no_op;
    }
    if (change.section === 'visits' && change.field in headerFlags.visits) {
      headerFlags.visits[change.field] = !change.no_op;
    }
  }

  return {
    route: 'existing_visit_update',
    update_scope: stage2Preview?.route_summary?.update_scope || 'findings_only',
    header_update_flags: headerFlags,
    findings_update_flags: {
      pre_op: grouped
    },
    preview_decision_trace: {
      two_stage_preview_used: true,
      multiple_override_stage_used: true,
      multiple_override_changed_fields: deepClone(decision?.replaceOverrides || []),
      final_confirmation: 'confirmed'
    }
  };
}


function parseFinalConfirmation(raw) {
  const value = normalizeChoiceToken(raw);
  if (value === '1' || value === 'send_now' || value === 'confirm' || value === 'confirmed' || value === 'true' || value === 'yes') {
    return 'send_now';
  }
  if (value === '2' || value === 'cancel' || value === 'false' || value === 'no') {
    return 'cancel';
  }
  return '';
}

function extractPhase1FinalConfirmation(args) {
  const direct = parseFinalConfirmation(args && args.final_confirmation);
  if (direct) return direct;

  const decision = (args && args.phase1_decision && typeof args.phase1_decision === 'object')
    ? args.phase1_decision
    : {};

  const candidates = [
    decision.phase1_full_preview_confirmation,
    decision.preview_confirmation,
    decision.final_confirmation,
    decision.stage2_confirmation,
    decision.confirmation,
    decision.send_now
  ];

  for (const candidate of candidates) {
    const parsed = parseFinalConfirmation(candidate);
    if (parsed) return parsed;
  }

  return '';
}

function extractPhase1DecisionForTransform(rawDecision) {
  if (!rawDecision || typeof rawDecision !== 'object' || Array.isArray(rawDecision)) {
    return rawDecision;
  }

  const cleaned = { ...rawDecision };
  delete cleaned.phase1_full_preview_confirmation;
  delete cleaned.preview_confirmation;
  delete cleaned.final_confirmation;
  delete cleaned.stage2_confirmation;
  delete cleaned.confirmation;
  delete cleaned.send_now;

  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function buildPhase1ExecutionPayload(transformedPayload, stage2Preview, headerTouched, decision) {
  const finalPayload = deepClone(transformedPayload);
  const findingsByTooth = {};

  for (const change of stage2Preview.findings_changes || []) {
    const toothNumber = safeString(change.tooth_number);
    findingsByTooth[toothNumber] ||= {};
    findingsByTooth[toothNumber][change.field] = change.after;
  }

  finalPayload.findings_records = finalPayload.findings_records.map((record) => {
    if (safeString(record?.branch_key) !== 'pre_op') return record;

    const toothNumber = safeString(record?.tooth_number);
    const patch = findingsByTooth[toothNumber];
    if (!patch) return record;

    return {
      ...record,
      fields: {
        ...record.fields,
        ...patch
      }
    };
  });

  finalPayload.sender_execution = buildSenderExecutionMetadata(
    headerTouched,
    stage2Preview,
    decision
  );

  return finalPayload;
}


async function buildPhase1TransformEnvelope(payload, transformResult, phase1DecisionRaw) {
  const transformedPayload = transformResult.transformed_payload;
  const headerTouched = detectHeaderTouchedFields(transformedPayload);
  const findingsTouched = detectFindingsTouchedFields(transformedPayload);
  const symptomTouched = hasSymptomTouch(transformedPayload);
  const currentState = await buildExistingVisitUpdateCurrentState(transformedPayload);

  if (!currentState.ready && currentState.fatal) {
    return {
      ok: false,
      tool: 'sender_transform',
      request_id: transformResult.request_id,
      status: 'ERROR',
      stage: 'PHASE1_CURRENT_STATE_REQUIRED_UNAVAILABLE',
      input_hash: transformResult.input_hash,
      transformed_hash: transformResult.transformed_hash,
      transformed_payload: transformResult.transformed_payload,
      error: {
        code: currentState.reason_code || 'CURRENT_STATE_REQUIRED_UNAVAILABLE',
        message: currentState.reason_message || 'Current-state is required for this Phase 1 flow but unavailable'
      },
      debug: {
        ...transformResult.debug,
        phase1_applicable: true,
        current_state_ready: false,
        current_state_required: true,
        current_state_diagnostics: currentState.diagnostics || {}
      }
    };
  }


const stage1Preview = currentState.ready
  ? buildPhase1MultiplePreview(transformedPayload, currentState)
  : { stage: 'multiple_policy_preview', items: [], prompt: '' };

const rawStage1Decision = extractPhase1Stage1Input(phase1DecisionRaw);

if (symptomTouched && (stage1Preview.items || []).length > 0 && rawStage1Decision === undefined) {
  return {
    ok: true,
    tool: 'sender_transform',
    request_id: transformResult.request_id,
    status: transformResult.status,
    stage: 'PHASE1_STAGE1_PREVIEW',
    input_hash: transformResult.input_hash,
    transformed_hash: transformResult.transformed_hash,
    transformed_payload: transformResult.transformed_payload,
    phase1: {
      applicable: true,
      stage: 1,
      current_state_ready: true,
      stage1_preview: stage1Preview,
      next_step: buildPhase1Stage1ChoiceGuide()
    },
    interaction: {
      mode: 'ask_user',
      ui_kind: 'preview_confirmation',
      user_message: '기존 방문 업데이트 multiple preview입니다. 아래 내용을 확인한 뒤 숫자로 선택해 주세요.',
      assistant_question: `${stage1Preview.prompt}\n0. 그대로 add\n1. replace로 변경`,
      required_user_input: {
        type: 'single_number_choice',
        field: 'phase1_multiple_policy_choice',
        choices: [
          { number: 0, label: '그대로 add', value: 'keep_add', arg_patch: { phase1_decision: { phase1_multiple_policy_choice: 0 } } },
          { number: 1, label: 'replace로 변경', value: 'replace', arg_patch: { phase1_decision: { phase1_multiple_policy_choice: 1 } } }
        ]
      },
      next_step: buildPhase1Stage1ChoiceGuide(),
      do_not_ask: []
    },
    execution_contract: {
      contract_version: '1.0',
      mode: 'await_user_choice',
      must_show_message: true,
      user_visible_message: '기존 방문 업데이트 multiple preview입니다. 아래 내용을 확인한 뒤 숫자로 선택해 주세요.',
      must_ask_user: true,
      user_question: '0. 그대로 add\n1. replace로 변경',
      accepted_input_type: 'single_number_choice',
      allowed_numbers: [0, 1],
      number_meanings: {
        '0': 'keep_add',
        '1': 'replace'
      },
      allowed_actions: [
        'show_preview',
        'ask_single_number_choice',
        'build_full_preview_after_user_choice'
      ],
      forbidden_actions: [
        'auto_send_without_confirmation'
      ],
      auto_resend_allowed: false,
      stop_after_response: false,
      next_step: buildPhase1Stage1ChoiceGuide()
    },
    debug: {
      ...transformResult.debug,
      phase1_applicable: true,
      current_state_ready: true
    }
  };
}

const phase1Decision = parsePhase1Decision(rawStage1Decision, stage1Preview);
  const stage2Preview = buildPhase1FullPreview(
    transformedPayload,
    currentState,
    headerTouched,
    findingsTouched,
    phase1Decision
  );
  const finalExecutionPayload = buildPhase1ExecutionPayload(
    transformedPayload,
    stage2Preview,
    headerTouched,
    phase1Decision
  );

  return {
    ok: true,
    tool: 'sender_transform',
    request_id: transformResult.request_id,
    status: transformResult.status,
    stage: 'PHASE1_STAGE2_PREVIEW',
    input_hash: transformResult.input_hash,
    transformed_hash: transformResult.transformed_hash,
    transformed_payload: finalExecutionPayload,
    preview_summary: buildPreviewSummary(finalExecutionPayload),
    phase1: {
      applicable: true,
      stage: 2,
      current_state_ready: currentState.ready,
      current_state_optional_fallback_used: !currentState.ready,
      current_state_diagnostics: currentState.ready ? {} : (currentState.diagnostics || {}),
      stage1_preview: stage1Preview,
      stage1_decision: phase1Decision,
      stage2_preview: stage2Preview,
      next_step: buildPhase1Stage2ChoiceGuide()
    },
    interaction: {
      mode: 'ask_user',
      ui_kind: 'preview_confirmation',
      user_message: '기존 방문 업데이트 full preview입니다. 아래 내용을 확인한 뒤 숫자로 선택해 주세요.',
      assistant_question: '숫자만 입력해 주세요.\n1. 이대로 진행\n2. 취소',
      required_user_input: {
        type: 'single_number_choice',
        field: 'phase1_full_preview_confirmation',
        choices: [
          { number: 1, label: '이대로 진행', value: 'send_now', arg_patch: { phase1_decision: { phase1_full_preview_confirmation: 1 } } },
          { number: 2, label: '취소', value: 'cancel', arg_patch: { phase1_decision: { phase1_full_preview_confirmation: 2 } } }
        ]
      },
      next_step: buildPhase1Stage2ChoiceGuide(),
      do_not_ask: []
    },
    execution_contract: {
      contract_version: '1.0',
      mode: 'await_user_choice',
      must_show_message: true,
      user_visible_message: '기존 방문 업데이트 full preview입니다. 아래 내용을 확인한 뒤 숫자로 선택해 주세요.',
      must_ask_user: true,
      user_question: '1. 이대로 진행\n2. 취소',
      accepted_input_type: 'single_number_choice',
      allowed_numbers: [1, 2],
      number_meanings: {
        '1': 'send_now',
        '2': 'cancel'
      },
      allowed_actions: [
        'show_preview',
        'ask_single_number_choice',
        'send_after_user_confirms'
      ],
      forbidden_actions: [
        'auto_send_without_confirmation'
      ],
      auto_resend_allowed: false,
      stop_after_response: false,
      next_step: buildPhase1Stage2ChoiceGuide()
    },
    debug: {
      ...transformResult.debug,
      phase1_applicable: true,
      current_state_ready: currentState.ready,
      current_state_optional_fallback_used: !currentState.ready,
      current_state_diagnostics: currentState.ready ? {} : (currentState.diagnostics || {})
    }
  };
}



function buildPreviewSummary(transformedPayload) {
  const patientStatusClaim = transformedPayload.workflow?.patient_status_claim || '';
  const visitIntentClaim = transformedPayload.workflow?.visit_intent_claim || '';

  function buildClaimLabel(patientStatus, visitIntent) {
    if (patientStatus === 'existing_patient' && visitIntent === 'new_visit') {
      return '구(이미 등록된) 환자 신규 방문 기록';
    }

    if (patientStatus === 'existing_patient' && visitIntent === 'existing_visit_update') {
      return '구(이미 등록된) 환자 기존 방문 업데이트';
    }

    if (patientStatus === 'new_patient' && visitIntent === 'new_visit') {
      return '신규 환자 신규 방문 기록';
    }

    if (patientStatus === 'new_patient' && visitIntent === 'existing_visit_update') {
      return '신규 환자 기존 방문 업데이트(비정상 조합 가능)';
    }

    return '';
  }

  const findings = Array.isArray(transformedPayload.findings_records)
    ? transformedPayload.findings_records.map((record, index) => {
        const symptom = Array.isArray(record.fields?.Symptom)
          ? record.fields.Symptom.join(', ')
          : '';

        return {
          no: index + 1,
          branch_code: record.branch_code || '',
          branch_label: record.branch_label || '',
          tooth_number: record.tooth_number || '',
          record_name: record.record_name || '',
          symptom,
          visible_crack: record.fields?.['Visible crack'] || '',
          pulp_cold_test: record.fields?.['Pulp - cold test'] || ''
        };
      })
    : [];

  return {
    patient_id: transformedPayload.patients?.patient_id || '',
    patient_status_claim: patientStatusClaim,
    visit_intent_claim: visitIntentClaim,
    claim_label: buildClaimLabel(patientStatusClaim, visitIntentClaim),
    visit_id: transformedPayload.visits?.visit_id || '',
    visit_date: transformedPayload.visits?.date || '',
    visit_type: transformedPayload.visits?.visit_type || '',
    chief_complaint: transformedPayload.visits?.chief_complaint || '',
    pain_level:
      transformedPayload.visits?.pain_level === ''
        ? '(blank)'
        : transformedPayload.visits?.pain_level,
    findings
  };
}

function buildTransformInteraction() {
  return {
    mode: 'ask_user',
    ui_kind: 'preview_confirmation',
    user_message:
      '변환 preview입니다. 이 내용대로 Make/Airtable에 전송하시겠습니까?',
    assistant_question:
      '숫자만 입력해 주세요.\n1. 이대로 전송\n2. 수정 후 다시 preview\n3. 취소',
    required_user_input: {
      type: 'single_number_choice',
      field: 'preview_confirmation',
      choices: [
        { number: 1, label: '이대로 전송', value: 'send_now' },
        { number: 2, label: '수정 후 다시 preview', value: 'revise_and_preview_again' },
        { number: 3, label: '취소', value: 'cancel' }
      ]
    },
    do_not_ask: []
  };
}

function buildTransformExecutionContract() {
  return {
    contract_version: '1.0',
    mode: 'await_user_choice',
    must_show_message: true,
    user_visible_message:
      '변환 preview입니다. 아래 내용을 확인한 뒤 숫자로 선택해 주세요.',
    must_ask_user: true,
    user_question:
      '1. 이대로 전송\n2. 수정 후 다시 preview\n3. 취소',
    accepted_input_type: 'single_number_choice',
    allowed_numbers: [1, 2, 3],
    number_meanings: {
      '1': 'send_now',
      '2': 'revise_and_preview_again',
      '3': 'cancel'
    },
    allowed_actions: [
      'show_preview',
      'ask_single_number_choice',
      'send_after_user_confirms'
    ],
    forbidden_actions: [
      'auto_send_without_confirmation'
    ],
    auto_resend_allowed: false,
    stop_after_response: false
  };
}

function httpRequest(urlString, method = 'GET', body = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body ? JSON.stringify(body) : null;
    const transport = url.protocol === 'https:' ? https : http;

    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        Accept: 'application/json, text/plain, */*'
      }
    };

    if (payload) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const request = transport.request(options, (response) => {
      let responseData = '';

      response.on('data', (chunk) => {
        responseData += chunk;
      });

      response.on('end', () => {
        let parsed = null;
        try {
          parsed = responseData ? JSON.parse(responseData) : null;
        } catch {
          parsed = null;
        }

        resolve({
          statusCode: response.statusCode || 0,
          headers: response.headers,
          bodyText: responseData,
          bodyJson: parsed
        });
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    request.on('error', reject);

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

function extractBestMessage(senderJson) {
  const topLevelMessage = safeString(senderJson.message);

  const parsedMessage =
    senderJson.make_response_parsed &&
    typeof senderJson.make_response_parsed === 'object'
      ? safeString(senderJson.make_response_parsed.message)
      : '';

  const parsedGateMessage =
    senderJson.make_response_parsed &&
    typeof senderJson.make_response_parsed === 'object'
      ? safeString(senderJson.make_response_parsed.gate_message)
      : '';

  if (parsedMessage && !isGarbledText(parsedMessage)) {
    return parsedMessage;
  }

  if (parsedGateMessage && !isGarbledText(parsedGateMessage)) {
    return parsedGateMessage;
  }

  if (topLevelMessage && !isGarbledText(topLevelMessage)) {
    return topLevelMessage;
  }

  const raw = safeString(senderJson.make_response_raw);
  if (raw) {
    try {
      const reparsed = JSON.parse(raw);
      const rawMessage = safeString(reparsed.message);
      const rawGateMessage = safeString(reparsed.gate_message);
      if (rawMessage) return rawMessage;
      if (rawGateMessage) return rawGateMessage;
    } catch {
      // ignore
    }
  }

  return parsedMessage || parsedGateMessage || topLevelMessage || '';
}

function mapResultTypeFromMake(parsed, transport) {
  if (parsed && typeof parsed === 'object') {
    const reasonCode = safeString(parsed.reason_code);
    const status = safeString(parsed.status);
    const gateResult = safeString(parsed.gate_result);

    if (reasonCode === 'PATIENT_NOT_FOUND_RECHECK_REQUIRED') {
      return 'recheck_required';
    }

    if (
      parsed.hard_stop === true ||
      status === 'hard_stop' ||
      gateResult === 'hard_stop'
    ) {
      return 'hard_stop';
    }

    if (
      parsed.correction_needed === true ||
      status === 'correction_required' ||
      gateResult === 'correction_required'
    ) {
      return 'correction_required';
    }

    if (status === 'normal_pass' || gateResult === 'normal_pass') {
      return 'success';
    }
  }

  if (
    transport &&
    transport.statusCode >= 200 &&
    transport.statusCode < 300 &&
    safeString(transport.bodyText).trim() === 'Accepted'
  ) {
    return 'accepted_no_json';
  }

  return 'technical_error';
}

function buildSendEnvelope(transformResult, transport) {
  const parsed = transport.bodyJson;
  const resultType = mapResultTypeFromMake(parsed, transport);

  let message = '';
  let writeAllowed = null;
  let resendAllowed = null;
  let reasonCode = '';
  let makeStatus = '';
  let gateResult = '';
  let sameDateVisitExists = null;
  let suggestedCorrection = null;

  if (parsed && typeof parsed === 'object') {
    message = safeString(parsed.message) || safeString(parsed.gate_message);
    writeAllowed =
      typeof parsed.write_allowed === 'boolean' ? parsed.write_allowed : null;
    resendAllowed =
      typeof parsed.resend_allowed === 'boolean' ? parsed.resend_allowed : null;
    reasonCode = safeString(parsed.reason_code);
    makeStatus = safeString(parsed.status);
    gateResult = safeString(parsed.gate_result);
    sameDateVisitExists =
      typeof parsed.same_date_visit_exists === 'boolean'
        ? parsed.same_date_visit_exists
        : null;
    suggestedCorrection =
      parsed.suggested_correction && typeof parsed.suggested_correction === 'object'
        ? parsed.suggested_correction
        : null;
  } else if (resultType === 'accepted_no_json') {
    message = '정상적으로 기록을 생성하였습니다.';
    writeAllowed = true;
    resendAllowed = false;
    makeStatus = 'accepted_no_json';
    gateResult = 'accepted_no_json';
  }

  const senderJson = {
    request_id: transformResult.request_id,
    status: 'SUCCESS',
    stage: 'COMPLETED',
    result_type: resultType,
    message,
    write_allowed: writeAllowed,
    resend_allowed: resendAllowed,
    reason_code: reasonCode,
    make_status: makeStatus,
    gate_result: gateResult,
    same_date_visit_exists: sameDateVisitExists,
    suggested_correction: suggestedCorrection,
    input_hash: transformResult.input_hash,
    transformed_hash: transformResult.transformed_hash,
    transformed_payload: transformResult.transformed_payload,
    make_response_raw: transport.bodyText,
    make_response_parsed: parsed,
    transport,
    debug: {
      validation_passed: true,
      contract_valid: true,
      transformation_applied: true,
      webhook_sent: transport.statusCode >= 200 && transport.statusCode < 300,
      parity_mode: 'findings_records',
      make_response_parsed: !!parsed
    }
  };

  return normalizeSendOutput(senderJson);
}

function buildInteraction(senderJson) {
  const resultType = senderJson.result_type || 'technical_error';
  const reasonCode = senderJson.reason_code || '';
  const message = extractBestMessage(senderJson);

  if (resultType === 'success') {
    return {
      mode: 'inform',
      ui_kind: 'success',
      user_message: `정상 처리되었습니다. ${message}`.trim(),
      assistant_question: '',
      required_user_input: null,
      do_not_ask: []
    };
  }

  if (resultType === 'accepted_no_json') {
    return {
      mode: 'inform',
      ui_kind: 'success',
      user_message: '정상적으로 기록을 생성하였습니다.',
      assistant_question: '',
      required_user_input: null,
      do_not_ask: []
    };
  }

  if (
    resultType === 'correction_required' &&
    reasonCode === 'SAME_DATE_EXISTING_VISIT_POSSIBLE_UPDATE'
  ) {
    return {
      mode: 'ask_user',
      ui_kind: 'confirmation',
      user_message:
        '같은 날짜에 이미 등록된 방문 기록이 있습니다. 숫자만 입력해 주세요.',
      assistant_question:
        '1. 기존 기록에 이어서 수정/추가로 진행\n2. 새 방문으로 유지하고 그대로 진행',
      required_user_input: {
        type: 'single_number_choice',
        field: 'workflow.doctor_confirmed_correction',
        choices: [
          {
            number: 1,
            label: '기존 기록에 이어서 수정/추가로 진행',
            value: 'confirm_existing_visit_update'
          },
          {
            number: 2,
            label: '새 방문으로 유지하고 그대로 진행',
            value: 'keep_new_visit_claim'
          }
        ]
      },
      do_not_ask: [
        'patients.patient_id',
        'visits.date',
        'full_json',
        'full_briefing',
        'findings_reentry'
      ]
    };
  }

  if (
    resultType === 'recheck_required' &&
    reasonCode === 'PATIENT_NOT_FOUND_RECHECK_REQUIRED'
  ) {
    return {
      mode: 'ask_user',
      ui_kind: 'input',
      user_message: '입력한 patient_id로는 기존 환자 기록을 찾지 못했습니다.',
      assistant_question: '수정된 6자리 patient_id만 다시 입력해 주세요.',
      required_user_input: {
        type: 'patient_id',
        field: 'patients.patient_id',
        format: '6_digit_string'
      },
      do_not_ask: [
        'visits.date',
        'visits.chief_complaint',
        'findings_reentry',
        'full_json',
        'full_briefing'
      ]
    };
  }

  if (
    resultType === 'hard_stop' &&
    reasonCode === 'PATIENT_NOT_FOUND_RECHECK_FAILED'
  ) {
    return {
      mode: 'stop',
      ui_kind: 'hard_stop',
      user_message:
        'patient_id를 다시 확인해도 기존 환자 기록을 찾지 못했습니다. 자동 진행을 중단합니다. 수동 확인이 필요합니다.',
      assistant_question: '',
      required_user_input: null,
      do_not_ask: [
        'patients.patient_id',
        'full_json',
        'full_briefing',
        'retry'
      ]
    };
  }

  if (
    resultType === 'hard_stop' &&
    reasonCode === 'SAME_DATE_EXISTING_VISIT_KEEP_NEW_VISIT_CLAIM'
  ) {
    return {
      mode: 'stop',
      ui_kind: 'hard_stop',
      user_message:
        '같은 날짜에 이미 등록된 방문 기록이 있는데도 새 방문으로 유지하려 했기 때문에 자동 진행이 중단되었습니다. 수동 확인이 필요합니다.',
      assistant_question: '',
      required_user_input: null,
      do_not_ask: [
        'patients.patient_id',
        'visits.date',
        'full_json',
        'full_briefing',
        'retry'
      ]
    };
  }

  if (resultType === 'hard_stop') {
    return {
      mode: 'stop',
      ui_kind: 'hard_stop',
      user_message: message,
      assistant_question: '',
      required_user_input: null,
      do_not_ask: ['full_json', 'full_briefing', 'retry']
    };
  }

  return {
    mode: 'inform',
    ui_kind: 'info',
    user_message: message,
    assistant_question: '',
    required_user_input: null,
    do_not_ask: []
  };
}

function buildResendPlan(senderJson) {
  const resultType = senderJson.result_type || 'technical_error';
  const reasonCode = senderJson.reason_code || '';

  if (
    resultType === 'correction_required' &&
    reasonCode === 'SAME_DATE_EXISTING_VISIT_POSSIBLE_UPDATE'
  ) {
    return {
      preserve_clinical_payload: true,
      replace_fields: [],
      set_fields_on_confirm_existing_visit_update: {
        'workflow.visit_intent_claim': 'existing_visit_update',
        'workflow.doctor_confirmed_correction': true,
        'workflow.correction_applied': 'true',
        'workflow.correction_case': 'same_date_existing_visit_possible_update',
        'workflow.correction_source': 'sender_resend_after_correction_required'
      },
      set_fields_on_keep_new_visit_claim: {
        'workflow.doctor_confirmed_correction': false
      },
      regenerate_fields: []
    };
  }

  if (
    resultType === 'recheck_required' &&
    reasonCode === 'PATIENT_NOT_FOUND_RECHECK_REQUIRED'
  ) {
    return {
      preserve_clinical_payload: true,
      replace_fields: ['patients.patient_id'],
      set_fields: {
        'workflow.patient_recheck_attempted': true
      },
      regenerate_fields: [
        'visits.visit_id',
        'findings_records[].visit_id',
        'findings_records[].record_name'
      ]
    };
  }

  return null;
}

function buildExecutionContract(senderJson) {
  const resultType = senderJson.result_type || 'technical_error';
  const reasonCode = senderJson.reason_code || '';
  const message = extractBestMessage(senderJson);

  if (resultType === 'success') {
    return {
      contract_version: '1.0',
      mode: 'complete',
      must_show_message: true,
      user_visible_message: `정상 처리되었습니다. ${message}`.trim(),
      must_ask_user: false,
      user_question: '',
      accepted_input_type: null,
      allowed_actions: ['finish'],
      forbidden_actions: [
        'ask_full_json_again',
        'ask_full_briefing_again',
        'ask_findings_again'
      ],
      auto_resend_allowed: false,
      stop_after_response: true
    };
  }

  if (resultType === 'accepted_no_json') {
    return {
      contract_version: '1.0',
      mode: 'complete',
      must_show_message: true,
      user_visible_message: '정상적으로 기록을 생성하였습니다.',
      must_ask_user: false,
      user_question: '',
      accepted_input_type: null,
      allowed_actions: ['finish', 'optional_postcheck'],
      forbidden_actions: [],
      auto_resend_allowed: false,
      stop_after_response: true
    };
  }

  if (
    resultType === 'correction_required' &&
    reasonCode === 'SAME_DATE_EXISTING_VISIT_POSSIBLE_UPDATE'
  ) {
    return {
      contract_version: '1.0',
      mode: 'await_user_choice',
      must_show_message: true,
      user_visible_message:
        '같은 날짜에 이미 등록된 방문 기록이 있습니다. 숫자만 입력해 주세요.',
      must_ask_user: true,
      user_question:
        '1. 기존 기록에 이어서 수정/추가로 진행\n2. 새 방문으로 유지하고 그대로 진행',
      accepted_input_type: 'single_number_choice',
      allowed_numbers: [1, 2],
      number_meanings: {
        '1': 'confirm_existing_visit_update',
        '2': 'keep_new_visit_claim'
      },
      allowed_actions: [
        'ask_single_number_choice',
        'patch_previous_payload',
        'resend_after_user_answer'
      ],
      forbidden_actions: [
        'ask_patient_id_again',
        'ask_full_json_again',
        'ask_full_briefing_again',
        'ask_findings_again'
      ],
      auto_resend_allowed: false,
      stop_after_response: false
    };
  }

  if (
    resultType === 'recheck_required' &&
    reasonCode === 'PATIENT_NOT_FOUND_RECHECK_REQUIRED'
  ) {
    return {
      contract_version: '1.0',
      mode: 'await_user_input',
      must_show_message: true,
      user_visible_message: '입력한 patient_id로는 기존 환자 기록을 찾지 못했습니다.',
      must_ask_user: true,
      user_question: '수정된 6자리 patient_id만 다시 입력해 주세요.',
      accepted_input_type: 'patient_id',
      accepted_format: '6_digit_string',
      allowed_actions: [
        'ask_only_patient_id',
        'patch_previous_payload',
        'resend_after_user_answer'
      ],
      forbidden_actions: [
        'ask_visit_date_again',
        'ask_chief_complaint_again',
        'ask_findings_again',
        'ask_full_json_again',
        'ask_full_briefing_again'
      ],
      auto_resend_allowed: false,
      stop_after_response: false
    };
  }

  if (resultType === 'hard_stop') {
    return {
      contract_version: '1.0',
      mode: 'stop',
      must_show_message: true,
      user_visible_message: buildInteraction(senderJson).user_message || message,
      must_ask_user: false,
      user_question: '',
      accepted_input_type: null,
      allowed_actions: ['show_stop_message'],
      forbidden_actions: [
        'retry_again',
        'ask_patient_id_again_when_resend_false',
        'ask_full_json_again',
        'ask_full_briefing_again'
      ],
      auto_resend_allowed: false,
      stop_after_response: true
    };
  }

  return {
    contract_version: '1.0',
    mode: 'inform',
    must_show_message: true,
    user_visible_message: message,
    must_ask_user: false,
    user_question: '',
    accepted_input_type: null,
    allowed_actions: ['show_message'],
    forbidden_actions: [],
    auto_resend_allowed: false,
    stop_after_response: false
  };
}

function normalizeSendOutput(senderJson) {
  return {
    ok: senderJson.status === 'SUCCESS',
    tool: 'sender_send',
    request_id: senderJson.request_id || '',
    status: senderJson.status || '',
    stage: senderJson.stage || '',
    result_type: senderJson.result_type || 'technical_error',
    message: extractBestMessage(senderJson),
    write_allowed:
      typeof senderJson.write_allowed === 'boolean'
        ? senderJson.write_allowed
        : null,
    resend_allowed:
      typeof senderJson.resend_allowed === 'boolean'
        ? senderJson.resend_allowed
        : null,
    reason_code: senderJson.reason_code || '',
    make_status: senderJson.make_status || '',
    gate_result: senderJson.gate_result || '',
    data: {
      same_date_visit_exists:
        typeof senderJson.same_date_visit_exists === 'boolean'
          ? senderJson.same_date_visit_exists
          : null,
      suggested_correction:
        senderJson.suggested_correction &&
        typeof senderJson.suggested_correction === 'object'
          ? senderJson.suggested_correction
          : null
    },
    input_hash: senderJson.input_hash || '',
    transformed_hash: senderJson.transformed_hash || '',
    transformed_payload: senderJson.transformed_payload || {},
    make_response_raw: senderJson.make_response_raw || '',
    make_response_parsed:
      senderJson.make_response_parsed &&
      typeof senderJson.make_response_parsed === 'object'
        ? senderJson.make_response_parsed
        : null,
    transport:
      senderJson.transport && typeof senderJson.transport === 'object'
        ? senderJson.transport
        : {},
    interaction: buildInteraction(senderJson),
    resend_plan: buildResendPlan(senderJson),
    execution_contract: buildExecutionContract(senderJson),
    debug: senderJson.debug || {}
  };
}


async function runTransformTool(args) {
  requireObject(args, 'args');
  requireObject(args.payload, 'args.payload');

  const result = transformCanonicalPayload(args.payload);

  if (isPhase1ApplicableExistingVisitUpdate(args.payload)) {
    return buildPhase1TransformEnvelope(args.payload, result, args.phase1_decision);
  }

  const preview_summary = buildPreviewSummary(result.transformed_payload);

  return {
    ok: result.status === 'SUCCESS',
    tool: 'sender_transform',
    request_id: result.request_id,
    status: result.status,
    stage: result.stage,
    input_hash: result.input_hash,
    transformed_hash: result.transformed_hash,
    transformed_payload: result.transformed_payload,
    preview_summary,
    interaction: buildTransformInteraction(),
    execution_contract: buildTransformExecutionContract(),
    debug: result.debug
  };
}


async function runSendTool(args) {
  requireObject(args, 'args');
  requireObject(args.payload, 'args.payload');

  if (!MAKE_WEBHOOK_URL) {
    throw new Error('MAKE_WEBHOOK_URL is not configured');
  }

  const transformResult = transformCanonicalPayload(args.payload);
  let outboundPayload = transformResult.transformed_payload;

  if (isPhase1ApplicableExistingVisitUpdate(args.payload)) {
    const finalConfirmation = extractPhase1FinalConfirmation(args);
    const phase1DecisionForTransform = extractPhase1DecisionForTransform(args.phase1_decision);

    const envelope = await buildPhase1TransformEnvelope(
      args.payload,
      transformResult,
      phase1DecisionForTransform
    );

    if (finalConfirmation === 'cancel') {
      return {
        ok: true,
        tool: 'sender_send',
        request_id: transformResult.request_id,
        status: 'CANCELLED',
        stage: 'PHASE1_CANCELLED',
        result_type: 'cancelled',
        message: '전송이 취소되었습니다.',
        write_allowed: false,
        resend_allowed: false,
        reason_code: '',
        make_status: '',
        gate_result: 'cancelled',
        data: { same_date_visit_exists: null, suggested_correction: null },
        input_hash: transformResult.input_hash,
        transformed_hash: transformResult.transformed_hash,
        transformed_payload: envelope.transformed_payload || transformResult.transformed_payload,
        make_response_raw: '',
        make_response_parsed: null,
        transport: {},
        interaction: {
          mode: 'inform',
          ui_kind: 'cancelled',
          user_message: '전송이 취소되었습니다.',
          assistant_question: '',
          required_user_input: null,
          do_not_ask: []
        },
        resend_plan: null,
        execution_contract: {
          contract_version: '1.0',
          mode: 'stop',
          must_show_message: true,
          user_visible_message: '전송이 취소되었습니다.',
          must_ask_user: false,
          user_question: '',
          accepted_input_type: null,
          allowed_actions: ['show_stop_message'],
          forbidden_actions: ['auto_send_without_confirmation'],
          auto_resend_allowed: false,
          stop_after_response: true,
          next_step: buildPhase1Stage2ChoiceGuide()
        },
        debug: {
          ...transformResult.debug,
          phase1_applicable: true,
          send_cancelled_by_user: true
        }
      };
    }

    if (envelope?.stage === 'PHASE1_STAGE1_PREVIEW') {
      return {
        ok: false,
        tool: 'sender_send',
        request_id: transformResult.request_id,
        status: 'ERROR',
        stage: 'PHASE1_STAGE1_CHOICE_REQUIRED',
        result_type: 'phase1_stage1_choice_required',
        message: '먼저 sender_transform에서 Stage 1 preview를 보여주고, 사용자의 선택을 받은 뒤 다시 진행해야 합니다.',
        write_allowed: false,
        resend_allowed: false,
        reason_code: 'PHASE1_STAGE1_CHOICE_REQUIRED',
        make_status: '',
        gate_result: 'phase1_stage1_choice_required',
        data: { same_date_visit_exists: null, suggested_correction: null },
        input_hash: transformResult.input_hash,
        transformed_hash: transformResult.transformed_hash,
        transformed_payload: envelope.transformed_payload || transformResult.transformed_payload,
        make_response_raw: '',
        make_response_parsed: null,
        transport: {},
        interaction: {
          mode: 'inform',
          ui_kind: 'info',
          user_message: '먼저 preview를 확인하고 선택을 완료한 뒤 전송해 주세요.',
          assistant_question: '',
          required_user_input: null,
          do_not_ask: []
        },
        resend_plan: null,
        execution_contract: {
          contract_version: '1.0',
          mode: 'stop',
          must_show_message: true,
          user_visible_message: '먼저 preview를 확인하고 선택을 완료한 뒤 전송해 주세요.',
          must_ask_user: false,
          user_question: '',
          accepted_input_type: null,
          allowed_actions: ['show_stop_message'],
          forbidden_actions: ['auto_send_without_confirmation'],
          auto_resend_allowed: false,
          stop_after_response: true
        },
        debug: {
          ...(envelope.debug || {}),
          phase1_applicable: true,
          send_blocked_until_stage1_choice: true
        }
      };
    }

    if (finalConfirmation !== 'send_now') {
      return {
        ok: false,
        tool: 'sender_send',
        request_id: transformResult.request_id,
        status: 'ERROR',
        stage: 'PHASE1_FINAL_CONFIRMATION_REQUIRED',
        result_type: 'phase1_final_confirmation_required',
        message: 'sender_send는 최종 확인 완료 후에만 실행됩니다. 먼저 sender_transform preview를 보고, phase1_decision.phase1_full_preview_confirmation 값을 포함해 다시 호출해 주세요.',
        write_allowed: false,
        resend_allowed: false,
        reason_code: 'PHASE1_FINAL_CONFIRMATION_REQUIRED',
        make_status: '',
        gate_result: 'phase1_final_confirmation_required',
        data: { same_date_visit_exists: null, suggested_correction: null },
        input_hash: transformResult.input_hash,
        transformed_hash: transformResult.transformed_hash,
        transformed_payload: envelope.transformed_payload || transformResult.transformed_payload,
        make_response_raw: '',
        make_response_parsed: null,
        transport: {},
        required_confirmation_field: 'phase1_decision.phase1_full_preview_confirmation',
        accepted_confirmation_values: {
          send_now: [1, '1', 'send_now', true],
          cancel: [2, '2', 'cancel', false]
        },
        arg_patch: {
          phase1_decision: {
            phase1_full_preview_confirmation: 1
          }
        },
        next_call_example: {
          use_same_payload: true,
          phase1_decision: {
            phase1_full_preview_confirmation: 1
          }
        },
        next_step: buildPhase1Stage2ChoiceGuide(),
        interaction: {
          mode: 'inform',
          ui_kind: 'info',
          user_message: '먼저 preview를 확인하고 최종 숫자 선택을 완료한 뒤 전송해 주세요.',
          assistant_question: '',
          required_user_input: null,
          do_not_ask: []
        },
        resend_plan: null,
        execution_contract: {
          contract_version: '1.0',
          mode: 'stop',
          must_show_message: true,
          user_visible_message: '먼저 preview를 확인하고 최종 숫자 선택을 완료한 뒤 전송해 주세요.',
          must_ask_user: false,
          user_question: '',
          accepted_input_type: null,
          allowed_actions: ['show_stop_message'],
          forbidden_actions: ['auto_send_without_confirmation'],
          auto_resend_allowed: false,
          stop_after_response: true
        },
        debug: {
          ...(envelope.debug || {}),
          phase1_applicable: true,
          send_blocked_until_final_confirmation: true
        }
      };
    }

    outboundPayload = envelope.transformed_payload;
  }

  const transport = await httpRequest(
    MAKE_WEBHOOK_URL,
    'POST',
    outboundPayload,
    45000
  );

  return buildSendEnvelope(
    {
      ...transformResult,
      transformed_payload: outboundPayload,
      transformed_hash: sha256(JSON.stringify(outboundPayload))
    },
    transport
  );
}

function runHealthTool() {
  return {
    ok: true,
    service: 'mcp-sender-v1-render-single',
    version: '1.1.9-phase1-existing-visit-update-hotfix9',
    enable_network_send: !!MAKE_WEBHOOK_URL,
    webhook_url: MAKE_WEBHOOK_URL || '',
    current_state_mcp_configured: !!CURRENT_STATE_MCP_BASE_URL
  };
}

function toolDefinitions() {

  return [
    {
      name: 'sender_health',
      description: 'Check sender MCP server health and runtime configuration.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: 'sender_transform',
      description:
        'Transform canonical dental case JSON into findings_records-parity payload for preview and validation. For existing_visit_update Phase 1, may return Stage 1 or Stage 2 preview envelopes. No downstream write.',
      inputSchema: {
        type: 'object',
        properties: {
          payload: {
            type: 'object',
            description: 'Canonical sender input payload'
          },
          phase1_decision: {
            type: 'object',
            description: 'Optional Phase 1 existing_visit_update policy override object'
          }
        },
        required: ['payload'],
        additionalProperties: false
      }
    },
    {
      name: 'sender_send',
      description:
        'Transform canonical dental case JSON, optionally apply existing_visit_update Phase 1 policy decisions, send it to Make webhook, and return normalized result including interaction, resend_plan, and execution_contract.',
      inputSchema: {
        type: 'object',
        properties: {
          payload: {
            type: 'object',
            description: 'Canonical sender input payload'
          },
          phase1_decision: {
            type: 'object',
            description: 'Optional Phase 1 existing_visit_update policy override object'
          },
          final_confirmation: {
            type: ['string', 'boolean', 'number'],
            description: 'Optional final confirmation for Phase 1 existing_visit_update send. Use 1/send_now/true to actually send.'
          }
        },
        required: ['payload'],
        additionalProperties: false
      }
    }
  ];
}

async function handleToolCall(toolName, args) {
  if (toolName === 'sender_health') {
    return runHealthTool();
  }

  if (toolName === 'sender_transform') {
    return runTransformTool(args);
  }

  if (toolName === 'sender_send') {
    return runSendTool(args);
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

function createSession(res) {
  const sessionId = crypto.randomUUID();

  sessions.set(sessionId, {
    id: sessionId,
    res,
    createdAt: Date.now()
  });

  res.on('close', () => {
    sessions.delete(sessionId);
  });

  return sessionId;
}

function writeSse(res, event, data) {
  if (event) {
    res.write(`event: ${event}\n`);
  }

  const payload =
    typeof data === 'string' ? data : JSON.stringify(data);

  for (const line of String(payload).split('\n')) {
    res.write(`data: ${line}\n`);
  }

  res.write('\n');
}

function sendRpcResult(sessionId, id, result) {
  const session = sessions.get(sessionId);
  if (!session) return;

  writeSse(session.res, 'message', {
    jsonrpc: '2.0',
    id,
    result
  });
}

function sendRpcError(sessionId, id, code, message, data = null) {
  const session = sessions.get(sessionId);
  if (!session) return;

  writeSse(session.res, 'message', {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      data
    }
  });
}

async function handleRpc(sessionId, message) {
  const id = Object.prototype.hasOwnProperty.call(message, 'id')
    ? message.id
    : null;
  const method = message.method;
  const params = message.params || {};

  if (method === 'initialize') {
    return sendRpcResult(sessionId, id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: 'ai-dental-clinic-sender',
        version: '1.0.0'
      }
    });
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'ping') {
    return sendRpcResult(sessionId, id, {});
  }

  if (method === 'tools/list') {
    return sendRpcResult(sessionId, id, {
      tools: toolDefinitions()
    });
  }

  if (method === 'tools/call') {
    try {
      const toolName = params.name;
      const args = params.arguments || {};

      if (typeof toolName !== 'string' || !toolName) {
        return sendRpcError(sessionId, id, -32602, 'Tool name is required');
      }

      const result = await handleToolCall(toolName, args);

      return sendRpcResult(sessionId, id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ],
        structuredContent: result
      });
    } catch (error) {
      return sendRpcError(
        sessionId,
        id,
        -32000,
        error.message || 'Tool call failed',
        null
      );
    }
  }

  return sendRpcError(sessionId, id, -32601, `Method not found: ${method}`);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = requestUrl.pathname;

    if (req.method === 'OPTIONS') {
      return sendNoContent(res, 204);
    }

    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'ai-dental-clinic-mcp-sse-server',
        version: '1.0.0',
        enable_network_send: !!MAKE_WEBHOOK_URL,
        webhook_url: MAKE_WEBHOOK_URL || ''
      });
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/sse')) {
      res.writeHead(200, {
        ...corsHeaders(),
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });

      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      const sessionId = createSession(res);
      const postPath = `/messages?sessionId=${encodeURIComponent(sessionId)}`;

      writeSse(res, 'endpoint', postPath);

      const timer = setInterval(() => {
        if (!res.writableEnded) {
          res.write(': keepalive\n\n');
        }
      }, 15000);

      res.on('close', () => {
        clearInterval(timer);
      });

      return;
    }

    if (req.method === 'POST' && pathname === '/messages') {
      const sessionId = requestUrl.searchParams.get('sessionId');

      if (!sessionId || !sessions.has(sessionId)) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Invalid or missing sessionId'
        });
      }

      const body = await parseJsonBody(req);
      requireObject(body, 'body');

      await handleRpc(sessionId, body);

      return sendNoContent(res, 202);
    }

    if (req.method === 'GET' && pathname === '/manifest') {
      return sendJson(res, 200, {
        name: 'ai-dental-clinic-sender',
        version: '1.0.0',
        tools: toolDefinitions()
      });
    }

    return sendJson(res, 404, {
      ok: false,
      error: 'Not found',
      endpoints: [
        'GET /',
        'GET /sse',
        'POST /messages?sessionId=...',
        'GET /health',
        'GET /manifest'
      ]
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: error.message || 'Unknown error'
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MCP SSE server listening on http://${HOST}:${PORT}`);
  console.log(`MAKE_WEBHOOK_URL configured: ${!!MAKE_WEBHOOK_URL}`);
});
