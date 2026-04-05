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
const CURRENT_STATE_FETCH_ROUNDS = Math.max(1, Number(process.env.CURRENT_STATE_FETCH_ROUNDS || 3));
const CURRENT_STATE_FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.CURRENT_STATE_FETCH_TIMEOUT_MS || 12000));
const CURRENT_STATE_FETCH_BACKOFF_MS = Math.max(0, Number(process.env.CURRENT_STATE_FETCH_BACKOFF_MS || 800));
const CHIEF_COMPLAINT_ADD_SEPARATOR = process.env.CHIEF_COMPLAINT_ADD_SEPARATOR || '';
const SENDER_RUNTIME_VERSION = '1.1.17-phase1-closeout';

/*
═══════════════════════════════════════════════════════════════════════════════
  PHASE 1 REGRESSION PACK LOCK
  
  This runtime embeds locked phase1 behavior for regression testing.
  DO NOT modify routing logic, phase1 decision flow, or preview/send blocking
  without updating the regression pack specification.
  
  Reference: ./PHASE1_REGRESSION_PACK_SPEC.md
  
  Locked Cases:
    RP-01: new_patient + Spatient_found → conflict preview with 3 choices
    RP-02: choice_2 + not_found → resolved to normal new_visit preview
    RP-03: choice_2 + found → updated conflict preview (no loop)
    RP-04: choice_2 + current_state_unavailable → safe stop (retry_later)
    RP-05: same_date_correction + choice_1 → existing_visit_update preview re-entry
    RP-06: same_date_correction + choice_2 → hard-stop transaction
    RP-07: existing_visit_update + all_no_op → result_type=no_op, send blocked
    RP-08: existing_visit_update + real_changes → stage_2 preview required
    RP-09: existing_visit_update + two_stage_complete → ready for final send
    RP-10: all_routes + patient_change → is_patient_recheck_required=true
    RP-11: patient_recheck_failed → no auto-recovery, re-input required
    RP-12: existing_patient + new_visit → direct stage_2, no conflict
    RP-13: same_date_choice_1 → existing_visit_update mode, no further choices
  
  Version Lock: SENDER_RUNTIME_VERSION = '1.1.17-phase1-closeout'
═══════════════════════════════════════════════════════════════════════════════
*/

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildDeterministicVisitId(patientId, visitDate) {
  const normalizedPatientId = safeString(patientId);
  const normalizedVisitDate = safeString(visitDate).replace(/-/g, '');
  return normalizedPatientId && normalizedVisitDate
    ? `VISIT-${normalizedPatientId}-${normalizedVisitDate}`
    : '';
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

  const deterministicVisitId = buildDeterministicVisitId(
    payload.patients.patient_id,
    payload.visits.date
  );

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
            : normalizeOptionalText(payload.workflow.doctor_confirmed_correction),
      correction_applied: normalizeOptionalText(payload.workflow.correction_applied),
      correction_case: normalizeOptionalText(payload.workflow.correction_case),
      correction_source: normalizeOptionalText(payload.workflow.correction_source)
    },
    patients: {
      patient_id: safeString(payload.patients.patient_id),
      birth_year: normalizeOptionalText(payload.patients.birth_year),
      gender: normalizeOptionalText(payload.patients.gender)
    },
    visits: {
      visit_id: deterministicVisitId || safeString(payload.visits.visit_id),
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

        const visitId = deterministicVisitId || safeString(record.visit_id || payload.visits.visit_id);
        const toothNumber = safeString(record.tooth_number);
        const branchCode = safeString(record.branch_code);
        const recordName = buildDeterministicRecordName(visitId, toothNumber, branchCode);

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

function hasAnyFindingsTouch(payload) {
  const records = Array.isArray(payload?.findings_records) ? payload.findings_records : [];

  return records.some((record) => {
    const fields = record?.fields || {};
    return Object.keys(fields).some((key) => !['Record name', 'Visit ID', 'Tooth number'].includes(key));
  });
}

function isPhase1ApplicableExistingVisitUpdate(payload) {
  if (!isExistingVisitUpdatePayload(payload)) return false;
  return hasPhase1HeaderTouch(payload) || hasAnyFindingsTouch(payload);
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

function normalizeChiefComplaintText(value) {
  return safeString(value).trim();
}

function mergeChiefComplaintAdd(before, incoming) {
  const normalizedBefore = normalizeChiefComplaintText(before);
  const normalizedIncoming = normalizeChiefComplaintText(incoming);
  const separator = CHIEF_COMPLAINT_ADD_SEPARATOR;

  if (!normalizedBefore) return normalizedIncoming;
  if (!normalizedIncoming) return normalizedBefore;
  if (normalizedBefore === normalizedIncoming) return normalizedBefore;
  if (!separator) return normalizedIncoming;

  return `${normalizedBefore}${separator}${normalizedIncoming}`;
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

function isResponseSemanticNotFound(resp) {
  if (!resp || resp.status !== 404) return false;
  if (!resp.body || typeof resp.body !== 'object') return false;
  return resp.body.error === 'not_found' || resp.body.query_status === 'not_found';
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
      attempted_urls: [],
      retry_rounds_used: 0
    };
  }

  const attempted = [];
  const rounds = CURRENT_STATE_FETCH_ROUNDS;

  for (let round = 0; round < rounds; round += 1) {
    const timeoutMs = CURRENT_STATE_FETCH_TIMEOUT_MS * (round + 1);

    for (const url of candidates) {
      try {
        const resp = await httpRequestJson(url, 'GET', undefined, timeoutMs);
        attempted.push({
          url,
          status: resp.status,
          ok: resp.ok,
          raw_text: resp.raw_text,
          timeout_ms: timeoutMs,
          round: round + 1
        });
        if (resp.ok) {
          return {
            ...resp,
            attempted_urls: attempted,
            retry_rounds_used: round + 1
          };
        }
        if (isResponseSemanticNotFound(resp)) {
          return {
            ...resp,
            ok: false,
            semantic_not_found: true,
            attempted_urls: attempted,
            retry_rounds_used: round + 1
          };
        }
      } catch (error) {
        attempted.push({
          url,
          status: 0,
          ok: false,
          raw_text: String(error && error.message ? error.message : error),
          timeout_ms: timeoutMs,
          round: round + 1
        });
      }
    }

    if (round < rounds - 1 && CURRENT_STATE_FETCH_BACKOFF_MS > 0) {
      await sleep(CURRENT_STATE_FETCH_BACKOFF_MS * (round + 1));
    }
  }

  return {
    ok: false,
    status: attempted.length > 0 ? attempted[attempted.length - 1].status : 0,
    body: null,
    raw_text: attempted.length > 0 ? attempted[attempted.length - 1].raw_text : '',
    last_error: 'Current-state fetch failed for all candidate URLs',
    attempted_urls: attempted,
    retry_rounds_used: rounds
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

function getPatientExistsFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.error === 'not_found' || body.query_status === 'not_found') return false;
  if (typeof body?.patient_exists === 'boolean') return body.patient_exists;
  if (typeof body?.result?.patient_exists === 'boolean') return body.result.patient_exists;
  const fields = getRecordFields(body);
  if (safeString(fields['Patients ID'])) return true;
  return null;
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

function getPhase2BranchMeta(branchKeyOrCode) {
  const normalized = safeString(branchKeyOrCode);
  const byKey = {
    pre_op: {
      branch_key: 'pre_op',
      branch_code: 'PRE',
      registry_section: 'Pre-op Clinical Findings',
      child_summary_key: 'pre_op_clinical_findings',
      table_alias: 'pre_op'
    },
    radiographic: {
      branch_key: 'radiographic',
      branch_code: 'RAD',
      registry_section: 'Radiographic Findings',
      child_summary_key: 'radiographic_findings',
      table_alias: 'radiographic'
    },
    operative: {
      branch_key: 'operative',
      branch_code: 'OP',
      registry_section: 'Operative Findings',
      child_summary_key: 'operative_findings',
      table_alias: 'operative'
    },
    diagnosis: {
      branch_key: 'diagnosis',
      branch_code: 'DX',
      registry_section: 'Diagnosis',
      child_summary_key: 'diagnosis',
      table_alias: 'diagnosis'
    },
    treatment_plan: {
      branch_key: 'treatment_plan',
      branch_code: 'PLAN',
      registry_section: 'Treatment Plan',
      child_summary_key: 'treatment_plan',
      table_alias: 'treatment_plan'
    },
    doctor_reasoning: {
      branch_key: 'doctor_reasoning',
      branch_code: 'DR',
      registry_section: 'Doctor Reasoning',
      child_summary_key: 'doctor_reasoning',
      table_alias: 'doctor_reasoning'
    }
  };
  const byCode = {
    PRE: byKey.pre_op,
    RAD: byKey.radiographic,
    OP: byKey.operative,
    DX: byKey.diagnosis,
    PLAN: byKey.treatment_plan,
    DR: byKey.doctor_reasoning
  };

  return byKey[normalized] || byCode[normalized] || null;
}

function getPhase2RegistryFieldRule(registryRules, branchKeyOrCode, fieldName) {
  const branchMeta = getPhase2BranchMeta(branchKeyOrCode);
  if (!branchMeta?.registry_section || !fieldName) return null;
  const sectionRules = registryRules?.[branchMeta.registry_section];
  if (!sectionRules || typeof sectionRules !== 'object') return null;
  return sectionRules[fieldName] || null;
}

function isStage1PolicyField(branchKeyOrCode, fieldName, registryRules) {
  if (safeString(branchKeyOrCode) === 'visits' && fieldName === 'chief_complaint') {
    return true;
  }

  const fieldRule = getPhase2RegistryFieldRule(registryRules, branchKeyOrCode, fieldName);
  return safeString(fieldRule?.type) === 'multi_select';
}

function getStage1DefaultPolicy(branchKeyOrCode, fieldName) {
  const normalizedBranchKey = safeString(branchKeyOrCode);
  if (normalizedBranchKey === 'visits' && fieldName === 'chief_complaint') {
    return 'replace';
  }
  if (normalizedBranchKey === 'pre_op' && fieldName === 'Symptom') {
    return 'add';
  }
  return 'replace';
}

function getChildIdsBySummaryKey(childrenBody, childSummaryKey) {
  if (!childSummaryKey) return [];

  const direct = childrenBody?.child_link_summary?.[childSummaryKey];
  if (Array.isArray(direct)) return direct.map((v) => safeString(v)).filter(Boolean);

  const nested = childrenBody?.result?.child_link_summary?.[childSummaryKey];
  if (Array.isArray(nested)) return nested.map((v) => safeString(v)).filter(Boolean);

  const alt1 = childrenBody?.[childSummaryKey];
  if (Array.isArray(alt1)) return alt1.map((v) => safeString(v)).filter(Boolean);

  const alt2 = childrenBody?.result?.[childSummaryKey];
  if (Array.isArray(alt2)) return alt2.map((v) => safeString(v)).filter(Boolean);

  return [];
}

function getPreOpChildIds(childrenBody) {
  return getChildIdsBySummaryKey(childrenBody, 'pre_op_clinical_findings');
}

function makeFindingLookupKey(branchKey, toothNumber, recordName) {
  return `${safeString(branchKey)}::${safeString(toothNumber)}::${safeString(recordName)}`;
}

function makePreOpLookupKey(toothNumber, recordName) {
  return makeFindingLookupKey('pre_op', toothNumber, recordName);
}

function findFindingSnapshotMatch(recordEntries, toothNumber, recordName) {
  const entries = Array.isArray(recordEntries) ? recordEntries : [];
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

function findPreOpSnapshotMatch(preOpEntries, toothNumber, recordName) {
  return findFindingSnapshotMatch(preOpEntries, toothNumber, recordName);
}

function createEmptyFindingBranchState() {
  return {
    byTooth: {},
    byLookup: {}
  };
}

function getCurrentStateBranchStore(currentState, branchKey) {
  if (!currentState || !branchKey) {
    return createEmptyFindingBranchState();
  }

  currentState.findingRecordsByBranch ||= {};
  currentState.findingRecordsByBranch[branchKey] ||= createEmptyFindingBranchState();
  return currentState.findingRecordsByBranch[branchKey];
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
  const findings = Array.isArray(transformedPayload?.findings_records)
    ? transformedPayload.findings_records
    : [];
  const touchedFindingRecords = findings.filter((record) => {
    const branchMeta = getPhase2BranchMeta(record?.branch_key || record?.branch_code);
    if (!branchMeta?.branch_key) return false;
    const fields = record?.fields || {};
    return Object.keys(fields).some((key) => !['Record name', 'Visit ID', 'Tooth number'].includes(key));
  });
  const needFindingRecords = touchedFindingRecords.length > 0;

  let patientResp = null;
  if (patientId) {
    patientResp = await fetchPatient(patientId);
  }

  const patientExists = patientResp && patientResp.ok
    ? getPatientExistsFromBody(patientResp.body)
    : null;

  if (patientResp && patientResp.ok && patientExists === false) {
    return {
      ready: false,
      fatal: false,
      patientExists: false,
      reason_code: 'CURRENT_STATE_PATIENT_NOT_FOUND',
      reason_message: 'Current-state patient lookup returned no patient',
      diagnostics: {
        fetch_id: `patient:${patientId}`,
        attempted_urls: patientResp.attempted_urls || []
      },
      visitRecordId: '',
      visitBody: {},
      visitChildrenBody: {},
      patientBody: patientResp.body || {},
      preOpRecordsByTooth: {},
      preOpRecordsByLookup: {},
      findingRecordsByBranch: {}
    };
  }

  const visitResp = await fetchVisitByDate(patientId, visitDate);
  if (!visitResp.ok) {
    return {
      ready: false,
      fatal: symptomTouched,
      patientExists,
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
      preOpRecordsByLookup: {},
      findingRecordsByBranch: {}
    };
  }

  const visitRecordId = getVisitRecordIdFromBody(visitResp.body);
  if (!visitRecordId) {
    return {
      ready: false,
      fatal: symptomTouched,
      patientExists,
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
      preOpRecordsByLookup: {},
      findingRecordsByBranch: {}
    };
  }

  const state = {
    ready: true,
    fatal: false,
    patientExists,
    diagnostics: {},
    visitRecordId,
    patientBody: patientResp && patientResp.ok ? patientResp.body : {},
    visitBody: visitResp.body,
    visitChildrenBody: {},
    preOpRecordsByTooth: {},
    preOpRecordsByLookup: {},
    findingRecordsByBranch: {}
  };

  if (!needFindingRecords) {
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

  const fetchedEntriesByBranch = {};
  const touchedBranchKeys = [...new Set(
    touchedFindingRecords
      .map((record) => getPhase2BranchMeta(record?.branch_key || record?.branch_code)?.branch_key || '')
      .filter(Boolean)
  )];

  for (const branchKey of touchedBranchKeys) {
    const branchMeta = getPhase2BranchMeta(branchKey);
    if (!branchMeta?.child_summary_key || !branchMeta?.table_alias) continue;

    const childIds = getChildIdsBySummaryKey(childrenResp.body, branchMeta.child_summary_key);
    const fetchedEntries = [];

    for (const childRecordId of childIds) {
      const recordResp = await fetchRecord(branchMeta.table_alias, childRecordId);
      if (!recordResp.ok) {
        continue;
      }
      fetchedEntries.push({
        recordId: childRecordId,
        body: recordResp.body
      });
    }

    fetchedEntriesByBranch[branchKey] = fetchedEntries;
  }

  for (const record of touchedFindingRecords) {
    const branchMeta = getPhase2BranchMeta(record?.branch_key || record?.branch_code);
    if (!branchMeta?.branch_key) continue;

    const branchKey = branchMeta.branch_key;
    const branchStore = getCurrentStateBranchStore(state, branchKey);
    const toothNumber = safeString(record?.tooth_number);
    const recordName = safeString(record?.record_name);
    const childLookup = findFindingSnapshotMatch(
      fetchedEntriesByBranch[branchKey] || [],
      toothNumber,
      recordName
    );
    const childRecordId = childLookup.id;

    if (!childRecordId) {
      const unresolvedEntry = {
        recordId: '',
        requestedRecordName: recordName,
        matchedRecordName: '',
        row_resolution: 'unresolved',
        body: null
      };

      branchStore.byLookup[makeFindingLookupKey(branchKey, toothNumber, recordName)] = unresolvedEntry;
      if (
        !branchStore.byTooth[toothNumber] ||
        branchStore.byTooth[toothNumber].row_resolution !== 'matched_existing_row'
      ) {
        branchStore.byTooth[toothNumber] = unresolvedEntry;
      }

      if (branchKey === 'pre_op') {
        state.preOpRecordsByLookup[makePreOpLookupKey(toothNumber, recordName)] = unresolvedEntry;
        if (
          !state.preOpRecordsByTooth[toothNumber] ||
          state.preOpRecordsByTooth[toothNumber].row_resolution !== 'matched_existing_row'
        ) {
          state.preOpRecordsByTooth[toothNumber] = unresolvedEntry;
        }
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

    branchStore.byLookup[makeFindingLookupKey(branchKey, toothNumber, recordName)] = entry;
    if (
      !branchStore.byTooth[toothNumber] ||
      branchStore.byTooth[toothNumber].row_resolution !== 'matched_existing_row'
    ) {
      branchStore.byTooth[toothNumber] = entry;
    }

    if (branchKey === 'pre_op') {
      state.preOpRecordsByLookup[makePreOpLookupKey(toothNumber, recordName)] = entry;
      if (
        !state.preOpRecordsByTooth[toothNumber] ||
        state.preOpRecordsByTooth[toothNumber].row_resolution !== 'matched_existing_row'
      ) {
        state.preOpRecordsByTooth[toothNumber] = entry;
      }
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
    pre_op: {},
    radiographic: {},
    operative: {},
    diagnosis: {},
    treatment_plan: {},
    doctor_reasoning: {}
  };

  for (const record of findings) {
    const branchMeta = getPhase2BranchMeta(record?.branch_key || record?.branch_code);
    if (!branchMeta?.branch_key) continue;

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

    result[branchMeta.branch_key][toothNumber] = {
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
  const hasFindings = Object.values(findingsTouched || {}).some((branchTouched) => Object.keys(branchTouched || {}).length > 0);

  if (hasHeader && hasFindings) return 'mixed';
  if (hasHeader) return 'header_only';
  if (hasFindings) return 'findings_only';
  return 'findings_only';
}

function getStoredFindingEntry(currentState, branchKey, toothNumber, recordName = '') {
  if (safeString(branchKey) === 'pre_op') {
    const exact = currentState?.preOpRecordsByLookup?.[makePreOpLookupKey(toothNumber, recordName)];
    if (exact) return exact;
    return currentState?.preOpRecordsByTooth?.[safeString(toothNumber)] || null;
  }

  const branchStore = currentState?.findingRecordsByBranch?.[safeString(branchKey)];
  const exact = branchStore?.byLookup?.[makeFindingLookupKey(branchKey, toothNumber, recordName)];
  if (exact) return exact;
  return branchStore?.byTooth?.[safeString(toothNumber)] || null;
}

function getStoredFindingField(currentState, branchKey, toothNumber, fieldName, recordName = '') {
  const entry = getStoredFindingEntry(currentState, branchKey, toothNumber, recordName);
  const fields = getRecordFields(entry?.body);
  return fields[fieldName];
}

function getStoredFindingRowResolution(currentState, branchKey, toothNumber, recordName = '') {
  const entry = getStoredFindingEntry(currentState, branchKey, toothNumber, recordName);
  return entry?.row_resolution || 'unresolved';
}

function getStoredPreOpEntry(currentState, toothNumber, recordName = '') {
  return getStoredFindingEntry(currentState, 'pre_op', toothNumber, recordName);
}

function getStoredPreOpField(currentState, toothNumber, fieldName, recordName = '') {
  return getStoredFindingField(currentState, 'pre_op', toothNumber, fieldName, recordName);
}

function getStoredPreOpRowResolution(currentState, toothNumber, recordName = '') {
  return getStoredFindingRowResolution(currentState, 'pre_op', toothNumber, recordName);
}

function buildStage1ItemKey(branchKey, toothNumber, fieldName, usedKeys, recordName = '') {
  const baseKey = `${safeString(branchKey)}.${safeString(toothNumber)}.${safeString(fieldName)}`;
  const candidateKeys = [baseKey];
  if (recordName) {
    candidateKeys.push(`${baseKey}::${safeString(recordName)}`);
  }

  for (const candidate of candidateKeys) {
    if (!usedKeys.has(candidate)) {
      usedKeys.add(candidate);
      return candidate;
    }
  }

  let suffix = 2;
  while (usedKeys.has(`${baseKey}::${suffix}`)) {
    suffix += 1;
  }
  const uniqueKey = `${baseKey}::${suffix}`;
  usedKeys.add(uniqueKey);
  return uniqueKey;
}

function getStage1AllItems(stage1Preview) {
  if (Array.isArray(stage1Preview?.all_items)) {
    return stage1Preview.all_items;
  }
  if (Array.isArray(stage1Preview?.items)) {
    return stage1Preview.items;
  }
  return [];
}

function getStage1InteractiveItems(stage1Preview) {
  if (Array.isArray(stage1Preview?.interactive_items)) {
    return stage1Preview.interactive_items;
  }
  if (Array.isArray(stage1Preview?.items)) {
    return stage1Preview.items;
  }
  return [];
}

function getStage1DisplayOnlyItems(stage1Preview) {
  if (Array.isArray(stage1Preview?.display_only_items)) {
    return stage1Preview.display_only_items;
  }
  return [];
}

function buildPhase1MultiplePreview(transformedPayload, currentState, registryRules) {
  const findings = Array.isArray(transformedPayload?.findings_records)
    ? transformedPayload.findings_records
    : [];
  const allItems = [];
  const usedKeys = new Set();
  const visitFields = getRecordFields(currentState?.visitBody || {});
  const headerTouched = detectHeaderTouchedFields(transformedPayload);
  const incomingChiefComplaint = transformedPayload?.visits?.chief_complaint || '';
  const beforeChiefComplaint = safeString(visitFields['Chief Complaint'] || '');
  const chiefComplaintTouched = headerTouched?.visits?.chief_complaint === true;

  if (chiefComplaintTouched && incomingChiefComplaint !== '') {
    const afterIfKeepCurrent = beforeChiefComplaint;
    const afterIfAdd = mergeChiefComplaintAdd(beforeChiefComplaint, incomingChiefComplaint);
    const afterIfReplace = incomingChiefComplaint;
    const distinctOutcomeCount = new Set([
      JSON.stringify(normalizeComparableValue('visits', 'chief_complaint', afterIfKeepCurrent)),
      JSON.stringify(normalizeComparableValue('visits', 'chief_complaint', afterIfAdd)),
      JSON.stringify(normalizeComparableValue('visits', 'chief_complaint', afterIfReplace))
    ]).size;
    const policyChoiceChangesOutcome = distinctOutcomeCount > 1;
    const defaultPolicy = getStage1DefaultPolicy('visits', 'chief_complaint');
    const defaultAfter = defaultPolicy === 'add'
      ? afterIfAdd
      : defaultPolicy === 'keep_current'
        ? afterIfKeepCurrent
        : afterIfReplace;
    const informationalNoOp = valuesEqual(
      beforeChiefComplaint,
      defaultAfter,
      'visits',
      'chief_complaint'
    );

    if (policyChoiceChangesOutcome) {
      allItems.push({
        key: 'visits.chief_complaint',
        choice_mode: 'keep_add_replace',
        section: 'visits',
        field: 'chief_complaint',
        before: beforeChiefComplaint,
        incoming: incomingChiefComplaint,
        after_if_keep_current: afterIfKeepCurrent,
        default_policy: defaultPolicy,
        after_if_add: afterIfAdd,
        after_if_replace: afterIfReplace,
        write_target_type: 'visit_header',
        merge_mode: 'replace',
        display_only: false,
        requires_selection: true
      });
    } else if (informationalNoOp) {
      allItems.push({
        key: 'visits.chief_complaint',
        choice_mode: 'keep_add_replace',
        section: 'visits',
        field: 'chief_complaint',
        before: beforeChiefComplaint,
        incoming: incomingChiefComplaint,
        after_if_keep_current: afterIfKeepCurrent,
        default_policy: defaultPolicy,
        after_if_add: afterIfAdd,
        after_if_replace: afterIfReplace,
        resolved_policy: defaultPolicy,
        resolved_after: defaultAfter,
        write_target_type: 'visit_header',
        merge_mode: 'no_op',
        display_only: true,
        requires_selection: false,
        no_op: true,
        transparency_only: true,
        transparency_reason: 'informational_no_op'
      });
    }
  }

  for (const record of findings) {
    const branchMeta = getPhase2BranchMeta(record?.branch_key || record?.branch_code);
    if (!branchMeta?.branch_key || branchMeta.branch_key === 'treatment_plan') continue;
    const toothNumber = safeString(record?.tooth_number);
    const recordName = safeString(record?.record_name);
    const fields = record?.fields || {};

    for (const [fieldName, incomingValue] of Object.entries(fields)) {
      if (fieldName === 'Record name' || fieldName === 'Visit ID' || fieldName === 'Tooth number') {
        continue;
      }

      if (!isStage1PolicyField(branchMeta.branch_key, fieldName, registryRules)) {
        continue;
      }

      const fieldRule = getPhase2RegistryFieldRule(registryRules, branchMeta.branch_key, fieldName);
      if (safeString(fieldRule?.type) !== 'multi_select') {
        continue;
      }

      const before = normalizeStringArray(
        getStoredFindingField(currentState, branchMeta.branch_key, toothNumber, fieldName, recordName)
      );
      const incoming = normalizeStringArray(incomingValue);
      const afterIfAdd = mergeMultiSelectAdd(before, incoming);
      const afterIfReplace = deepClone(incoming);
      const rowResolution = getStoredFindingRowResolution(currentState, branchMeta.branch_key, toothNumber, recordName);
      const policyChoiceChangesOutcome = !valuesEqual(
        afterIfAdd,
        afterIfReplace,
        branchMeta.branch_key,
        fieldName
      );
      const defaultPolicy = getStage1DefaultPolicy(branchMeta.branch_key, fieldName);
      const defaultAfter = defaultPolicy === 'add' ? afterIfAdd : afterIfReplace;
      const informationalNoOp = valuesEqual(
        before,
        defaultAfter,
        branchMeta.branch_key,
        fieldName
      );

      if (!policyChoiceChangesOutcome && !informationalNoOp) {
        continue;
      }

      allItems.push({
        key: buildStage1ItemKey(branchMeta.branch_key, toothNumber, fieldName, usedKeys, recordName),
        choice_mode: 'add_or_replace',
        section: branchMeta.registry_section,
        branch: branchMeta.branch_key,
        tooth_number: toothNumber,
        record_name: recordName,
        field: fieldName,
        before,
        incoming,
        default_policy: defaultPolicy,
        after_if_add: afterIfAdd,
        after_if_replace: afterIfReplace,
        resolved_policy: informationalNoOp && !policyChoiceChangesOutcome ? defaultPolicy : '',
        resolved_after: informationalNoOp && !policyChoiceChangesOutcome ? defaultAfter : undefined,
        write_target_type: 'finding_row',
        row_resolution: rowResolution,
        merge_mode: informationalNoOp && !policyChoiceChangesOutcome ? 'no_op' : defaultPolicy,
        current_live_before: before,
        expected_after_if_add: afterIfAdd,
        expected_after_if_replace: afterIfReplace,
        display_only: informationalNoOp && !policyChoiceChangesOutcome,
        requires_selection: !informationalNoOp && policyChoiceChangesOutcome,
        no_op: informationalNoOp && !policyChoiceChangesOutcome,
        transparency_only: informationalNoOp && !policyChoiceChangesOutcome,
        transparency_reason: informationalNoOp && !policyChoiceChangesOutcome ? 'informational_no_op' : ''
      });
    }
  }

  const branchOrder = {
    visits: 0,
    pre_op: 1,
    radiographic: 2,
    operative: 3,
    diagnosis: 4,
    doctor_reasoning: 5,
    treatment_plan: 6
  };

  allItems.sort((a, b) => {
    const aBranch = safeString(a.branch || a.section);
    const bBranch = safeString(b.branch || b.section);
    const branchDiff = (branchOrder[aBranch] ?? 999) - (branchOrder[bBranch] ?? 999);
    if (branchDiff !== 0) return branchDiff;

    const toothDiff = safeString(a.tooth_number).localeCompare(safeString(b.tooth_number), undefined, { numeric: true });
    if (toothDiff !== 0) return toothDiff;

    const fieldDiff = safeString(a.field).localeCompare(safeString(b.field));
    if (fieldDiff !== 0) return fieldDiff;

    return safeString(a.record_name).localeCompare(safeString(b.record_name));
  });

  allItems.forEach((item, index) => {
    item.number = index + 1;
  });

  const interactiveItems = allItems.filter((item) => item.display_only !== true);
  const displayOnlyItems = allItems.filter((item) => item.display_only === true);

  return {
    stage: 'multiple_policy_preview',
    items: interactiveItems,
    all_items: allItems,
    interactive_items: interactiveItems,
    display_only_items: displayOnlyItems,
    prompt: 'Stage 1에서 policy-sensitive 항목을 순서대로 확인합니다.'
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

function extractExistingPhase1PolicyState(input, stage1Preview) {
  const items = getStage1InteractiveItems(stage1Preview);
  const policyState = {};

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (input.phase1_multiple_policy_state && typeof input.phase1_multiple_policy_state === 'object' && !Array.isArray(input.phase1_multiple_policy_state)) {
      for (const item of items) {
        const storedPolicy = safeString(input.phase1_multiple_policy_state[item.key]);
        if (storedPolicy === 'keep_current' || storedPolicy === 'add' || storedPolicy === 'replace') {
          policyState[item.key] = storedPolicy;
        }
      }
    }

    if (Array.isArray(input.replaceOverrides) || Array.isArray(input.addOverrides) || Array.isArray(input.keepCurrentOverrides)) {
      const replaceOverrides = new Set((Array.isArray(input.replaceOverrides) ? input.replaceOverrides : []).map((item) => safeString(item).trim()).filter(Boolean));
      const addOverrides = new Set((Array.isArray(input.addOverrides) ? input.addOverrides : []).map((item) => safeString(item).trim()).filter(Boolean));
      const keepCurrentOverrides = new Set((Array.isArray(input.keepCurrentOverrides) ? input.keepCurrentOverrides : []).map((item) => safeString(item).trim()).filter(Boolean));

      for (const item of items) {
        if (policyState[item.key]) continue;
        if (keepCurrentOverrides.has(item.key)) {
          policyState[item.key] = 'keep_current';
        } else if (addOverrides.has(item.key)) {
          policyState[item.key] = 'add';
        } else if (replaceOverrides.has(item.key)) {
          policyState[item.key] = 'replace';
        }
      }
    }
  }

  return policyState;
}

function normalizeSequentialStage1Policy(rawChoice, item) {
  const token = normalizeChoiceToken(rawChoice);
  if (!token || !item) return '';

  const normalizePolicyWord = (value) => {
    if (item.choice_mode === 'keep_add_replace') {
      if (value === '1' || value === 'keep' || value === 'keep_current') return 'keep_current';
      if (value === '2' || value === 'add') return 'add';
      if (value === '3' || value === 'replace') return 'replace';
      return '';
    }

    if (value === '1' || value === 'add') return 'add';
    if (value === '2' || value === 'replace') return 'replace';
    return '';
  };

  if (!token.includes(' ')) {
    return normalizePolicyWord(token);
  }

  const parts = token.split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return '';

  const [numberPart, policyPart] = parts;
  if (!/^\d+$/.test(numberPart) || Number(numberPart) !== item.number) {
    return '';
  }
  return normalizePolicyWord(policyPart);
}

function buildPhase1DecisionFromPolicyState(stage1Preview, policyState, cursor = 0) {
  const items = getStage1InteractiveItems(stage1Preview);
  const result = {
    replaceOverrides: [],
    addOverrides: [],
    keepCurrentOverrides: [],
    policyState: {},
    phase1_multiple_policy_state: {},
    phase1_multiple_policy_cursor: cursor
  };

  for (const item of items) {
    const selectedPolicy = safeString(policyState?.[item.key]);
    if (!selectedPolicy) continue;

    result.policyState[item.key] = selectedPolicy;
    result.phase1_multiple_policy_state[item.key] = selectedPolicy;

    if (selectedPolicy === 'keep_current') {
      result.keepCurrentOverrides.push(item.key);
    } else if (selectedPolicy === 'add') {
      if (item.default_policy !== 'add') {
        result.addOverrides.push(item.key);
      }
    } else if (selectedPolicy === 'replace') {
      if (item.default_policy !== 'replace') {
        result.replaceOverrides.push(item.key);
      }
    }
  }

  return result;
}

function extractPhase1Stage1Input(input) {
  if (input === undefined || input === null || input === '') {
    return undefined;
  }

  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return input;
  }

  if (input && typeof input === 'object') {
    if (Array.isArray(input.replaceOverrides) || Array.isArray(input.addOverrides)) return input;

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
  const sequentialState = buildSequentialStage1PolicyState(input, stage1Preview);
  return buildPhase1DecisionFromPolicyState(
    stage1Preview,
    sequentialState.policyState,
    sequentialState.cursor
  );
}

function buildSequentialStage1PolicyState(input, stage1Preview) {
  const items = getStage1InteractiveItems(stage1Preview);
  const basePolicyState = extractExistingPhase1PolicyState(input, stage1Preview);
  const policyState = { ...basePolicyState };
  const firstUnresolvedIndex = items.findIndex((item) => !policyState[item.key]);
  let cursor = firstUnresolvedIndex === -1 ? items.length : firstUnresolvedIndex;

  const rawChoice = extractPhase1Stage1Input(input);
  const currentItem = cursor < items.length ? items[cursor] : null;
  const choiceItemKey = input && typeof input === 'object'
    ? safeString(input.phase1_multiple_policy_choice_item_key)
    : '';

  let appliedPolicy = '';
  let appliedItemKey = '';
  let choiceAccepted = false;
  let invalidChoice = false;

  if (rawChoice !== undefined && currentItem) {
    if (!choiceItemKey || choiceItemKey === currentItem.key) {
      appliedPolicy = normalizeSequentialStage1Policy(rawChoice, currentItem);
      if (appliedPolicy) {
        policyState[currentItem.key] = appliedPolicy;
        appliedItemKey = currentItem.key;
        choiceAccepted = true;
        cursor += 1;
        while (cursor < items.length && policyState[items[cursor].key]) {
          cursor += 1;
        }
      } else {
        invalidChoice = true;
      }
    } else {
      invalidChoice = true;
    }
  }

  return {
    policyState,
    cursor,
    currentItem: cursor < items.length ? items[cursor] : null,
    complete: cursor >= items.length,
    appliedPolicy,
    appliedItemKey,
    choiceAccepted,
    invalidChoice
  };
}

function resolveFieldPolicy(changeKey, fieldName, decision) {
  const policyState =
    decision?.policyState && typeof decision.policyState === 'object' && !Array.isArray(decision.policyState)
      ? decision.policyState
      : decision?.phase1_multiple_policy_state && typeof decision.phase1_multiple_policy_state === 'object' && !Array.isArray(decision.phase1_multiple_policy_state)
        ? decision.phase1_multiple_policy_state
        : {};
  const explicitPolicy = safeString(policyState?.[changeKey]);
  if (explicitPolicy === 'keep_current' || explicitPolicy === 'add' || explicitPolicy === 'replace') {
    return explicitPolicy;
  }

  const replaceOverrides = Array.isArray(decision?.replaceOverrides)
    ? decision.replaceOverrides
    : [];
  const addOverrides = Array.isArray(decision?.addOverrides)
    ? decision.addOverrides
    : [];
  const keepCurrentOverrides = Array.isArray(decision?.keepCurrentOverrides)
    ? decision.keepCurrentOverrides
    : [];

  const defaultPolicy = getStage1DefaultPolicy(
    safeString(changeKey).split('.')[0],
    fieldName
  );

  if (fieldName === 'chief_complaint') {
    if (keepCurrentOverrides.includes(changeKey)) {
      return 'keep_current';
    }
    if (addOverrides.includes(changeKey)) {
      return 'add';
    }
    return defaultPolicy;
  }

  if (addOverrides.includes(changeKey)) {
    return 'add';
  }
  if (replaceOverrides.includes(changeKey)) {
    return 'replace';
  }

  return defaultPolicy;
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

function formatStage1VisibleValue(value) {
  if (value === undefined || value === null || value === '') return '(empty)';
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => safeString(entry).trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized.join(', ') : '(empty)';
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function buildPhase1Stage1ItemBlock(item) {
  const isChiefComplaintItem =
    item.key === 'visits.chief_complaint' || item.field === 'chief_complaint';
  const lines = [
    `[${item.number}] ${safeString(item.key || item.field || '')}`,
    `- 상태: ${item.display_only ? '선택 불필요 / 변경 없음' : '선택 필요'}`,
    `- before: ${formatStage1VisibleValue(item.before)}`,
    `- incoming: ${formatStage1VisibleValue(item.incoming)}`
  ];

  if (item.display_only) {
    lines.push(`- resolved policy: ${formatStage1VisibleValue(item.resolved_policy || item.default_policy)}`);
    lines.push(`- final after: ${formatStage1VisibleValue(item.resolved_after)}`);
    if (item.transparency_reason) {
      lines.push(`- note: ${formatStage1VisibleValue(item.transparency_reason)}`);
    }
    return lines.join('\n');
  }

  if (isChiefComplaintItem) {
    lines.push(`- if keep current: ${formatStage1VisibleValue(item.after_if_keep_current ?? item.before)}`);
  }

  lines.push(`- if add: ${formatStage1VisibleValue(item.after_if_add)}`);
  lines.push(`- if replace: ${formatStage1VisibleValue(item.after_if_replace)}`);
  return lines.join('\n');
}

function buildPhase1Stage1VisibleBody(stage1Preview, sequentialState) {
  const currentItem = sequentialState?.currentItem || null;
  const allItems = getStage1AllItems(stage1Preview);
  const interactiveItems = getStage1InteractiveItems(stage1Preview);
  const currentProgress = `${(sequentialState?.cursor || 0) + 1}/${interactiveItems.length || 1}`;
  const currentItemKey = safeString(currentItem?.key || currentItem?.field || '');
  const isChiefComplaintItem =
    currentItem &&
    (currentItem.key === 'visits.chief_complaint' || currentItem.field === 'chief_complaint');
  const intro = sequentialState?.invalidChoice
    ? '기존 방문 업데이트 Stage 1 선택이 유효하지 않았습니다. 현재 항목을 다시 선택해 주세요.'
    : '기존 방문 업데이트 Stage 1 preview입니다. 전체 항목을 먼저 보여드리고, 현재 선택 항목만 입력받습니다.';
  const stage1FullListBlock = [
    '[Stage 1 전체 항목]',
    ...allItems.map((item) => buildPhase1Stage1ItemBlock(item))
  ].join('\n\n');

  if (!currentItem) {
    return [
      intro,
      '',
      stage1FullListBlock
    ].filter(Boolean).join('\n');
  }

  return [
    intro,
    '',
    stage1FullListBlock,
    '',
    '[현재 선택 항목]',
    `현재 항목: ${currentProgress} ${currentItemKey}`,
    '- 상태: 선택 필요',
    `- before: ${formatStage1VisibleValue(currentItem.before)}`,
    `- incoming: ${formatStage1VisibleValue(currentItem.incoming)}`,
    ...(isChiefComplaintItem
      ? [`- if keep current: ${formatStage1VisibleValue(currentItem.after_if_keep_current ?? currentItem.before)}`]
      : []),
    `- if add: ${formatStage1VisibleValue(currentItem.after_if_add)}`,
    `- if replace: ${formatStage1VisibleValue(currentItem.after_if_replace)}`,
    '',
    ...(isChiefComplaintItem ? ['1. keep current', '2. add', '3. replace'] : ['1. add', '2. replace'])
  ].join('\n');
}

function buildPhase1Stage1ArgPatch(sequentialState, currentItem, choiceValue) {
  return {
    phase1_decision: {
      phase1_multiple_policy_state: deepClone(sequentialState?.policyState || {}),
      phase1_multiple_policy_cursor: sequentialState?.cursor || 0,
      phase1_multiple_policy_choice_item_key: currentItem?.key || '',
      phase1_multiple_policy_choice: choiceValue
    }
  };
}

function buildPhase1Stage1UserQuestion(stage1Preview, sequentialState) {
  return buildPhase1Stage1VisibleBody(stage1Preview, sequentialState);
}

function buildPhase1Stage1RequiredInput(stage1Preview, sequentialState) {
  const currentItem = sequentialState?.currentItem || null;
  if (!currentItem) {
    return null;
  }

  const isChiefComplaintItem =
    currentItem.key === 'visits.chief_complaint' || currentItem.field === 'chief_complaint';
  const argPatchExamples = {
    input_1: buildPhase1Stage1ArgPatch(sequentialState, currentItem, 1),
    input_2: buildPhase1Stage1ArgPatch(sequentialState, currentItem, 2),
    ...(isChiefComplaintItem
      ? { input_3: buildPhase1Stage1ArgPatch(sequentialState, currentItem, 3) }
      : {})
  };

  return {
    type: 'single_number_choice',
    field: 'phase1_multiple_policy_choice',
    format: isChiefComplaintItem ? '1_keep_or_2_add_or_3_replace' : '1_add_or_2_replace',
    allowed_input_description: isChiefComplaintItem
      ? '1은 keep current, 2는 add, 3은 replace'
      : '1은 add, 2는 replace',
    examples: isChiefComplaintItem ? ['1', '2', '3'] : ['1', '2'],
    current_item_key: currentItem.key || '',
    arg_patch_template: {
      phase1_decision: {
        phase1_multiple_policy_state: deepClone(sequentialState?.policyState || {}),
        phase1_multiple_policy_cursor: sequentialState?.cursor || 0,
        phase1_multiple_policy_choice_item_key: currentItem?.key || '',
        phase1_multiple_policy_choice: '<type single number>'
      }
    },
    arg_patch_examples: argPatchExamples
  };
}

function buildPhase2RegistryRules() {
  if (buildPhase2RegistryRules.__cache) {
    return buildPhase2RegistryRules.__cache;
  }

  const fs = require('fs');
  const path = require('path');
  const registryPath = path.join(__dirname, 'PHASE2_FIELD_OPTION_REGISTRY.md');
  const requiredSections = [
    'Visits',
    'Pre-op Clinical Findings',
    'Radiographic Findings',
    'Operative Findings',
    'Diagnosis',
    'Treatment Plan',
    'Doctor Reasoning'
  ];
  const requiredSectionSet = new Set(requiredSections);

  const fail = (message) => {
    const errorResult = {
      __load_error: {
        reason_code: 'SELECTABLE_REGISTRY_LOAD_ERROR',
        section: '',
        branch_code: '',
        field: '',
        expected_type: 'registry_markdown',
        received_type: 'unavailable',
        invalid_value: registryPath,
        offending_values: [],
        error: message
      }
    };
    buildPhase2RegistryRules.__cache = errorResult;
    return errorResult;
  };

  let markdown = '';
  try {
    markdown = fs.readFileSync(registryPath, 'utf8');
  } catch (error) {
    return fail(`Failed to read selectable validation registry: ${error.message}`);
  }

  const rules = {};
  let currentSection = '';

  for (const line of markdown.split(/\r?\n/)) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      const heading = headingMatch[1].trim();
      currentSection = requiredSectionSet.has(heading) ? heading : '';
      if (currentSection) {
        rules[currentSection] ||= {};
      }
      continue;
    }

    if (!currentSection) continue;

    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;

    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());

    if (cells.length < 4) continue;
    if (cells[0] === 'Field' && cells[1] === 'Type') continue;
    if (cells.every((cell) => /^-+$/.test(cell.replace(/\s+/g, '')))) continue;

    const [fieldName, fieldType, allowedCell, validationMode] = cells;
    if (!fieldName || !fieldType) {
      return fail(`Malformed registry row in section "${currentSection}"`);
    }

    const normalizedType = fieldType.trim();
    const allowedValues = Array.from(allowedCell.matchAll(/`([^`]+)`/g)).map((match) => match[1]);

    if ((normalizedType === 'single_select' || normalizedType === 'multi_select') && allowedValues.length === 0) {
      return fail(`Missing allowed options for ${currentSection}.${fieldName}`);
    }

    rules[currentSection][fieldName] = {
      type: normalizedType,
      validation_mode: validationMode.trim(),
      allowed: allowedValues
    };
  }

  for (const sectionName of requiredSections) {
    if (!rules[sectionName] || Object.keys(rules[sectionName]).length === 0) {
      return fail(`Missing registry section "${sectionName}"`);
    }
  }

  buildPhase2RegistryRules.__cache = rules;
  return rules;
}

function validateSelectableFieldsAgainstRegistry(transformedPayload, registryRules) {
  if (registryRules?.__load_error) {
    return {
      valid: false,
      ...registryRules.__load_error
    };
  }

  const describeType = (value) => {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  };

  const buildValidationError = ({
    reason_code,
    section,
    branch_code = '',
    field,
    expected_type,
    received_type,
    invalid_value,
    offending_values = []
  }) => {
    let error = `Selectable field validation failed for ${section}.${field}`;

    if (reason_code === 'INVALID_SELECTABLE_FIELD') {
      error = `Unsupported selectable field for ${section}: "${field}"`;
    } else if (reason_code === 'INVALID_SELECTABLE_OPTION') {
      const valueText = offending_values.length > 0
        ? offending_values.join(', ')
        : String(invalid_value);
      error = `Invalid value for ${section}.${field}: "${valueText}"`;
    } else if (reason_code === 'INVALID_MULTISELECT_TYPE') {
      error = `Invalid multi-select type for ${section}.${field}: expected array, received ${received_type}`;
    } else if (reason_code === 'INVALID_SELECTABLE_TYPE') {
      error = `Invalid type for ${section}.${field}: expected ${expected_type}, received ${received_type}`;
    }

    return {
      valid: false,
      reason_code,
      section,
      branch_code,
      field,
      expected_type,
      received_type,
      invalid_value,
      offending_values,
      error
    };
  };

  const validateField = ({ section, branchCode = '', fieldName, fieldValue }) => {
    const sectionRules = registryRules?.[section];
    if (!sectionRules || typeof sectionRules !== 'object') {
      return buildValidationError({
        reason_code: 'SELECTABLE_REGISTRY_LOAD_ERROR',
        section,
        branch_code: branchCode,
        field: fieldName,
        expected_type: 'registry_section',
        received_type: 'missing',
        invalid_value: section,
        offending_values: []
      });
    }

    const fieldRule = sectionRules[fieldName];
    if (!fieldRule) {
      return buildValidationError({
        reason_code: 'INVALID_SELECTABLE_FIELD',
        section,
        branch_code: branchCode,
        field: fieldName,
        expected_type: 'registry-listed field',
        received_type: describeType(fieldValue),
        invalid_value: fieldName,
        offending_values: []
      });
    }

    if (fieldValue === undefined || fieldValue === null) {
      return null;
    }

    if (fieldRule.type === 'multiline_text') {
      return null;
    }

    if (fieldRule.type === 'single_select') {
      if (typeof fieldValue !== 'string') {
        return buildValidationError({
          reason_code: 'INVALID_SELECTABLE_TYPE',
          section,
          branch_code: branchCode,
          field: fieldName,
          expected_type: 'string',
          received_type: describeType(fieldValue),
          invalid_value: fieldValue,
          offending_values: []
        });
      }

      if (fieldValue === '') return null;

      if (!fieldRule.allowed.includes(fieldValue)) {
        return buildValidationError({
          reason_code: 'INVALID_SELECTABLE_OPTION',
          section,
          branch_code: branchCode,
          field: fieldName,
          expected_type: 'single_select option',
          received_type: 'string',
          invalid_value: fieldValue,
          offending_values: [fieldValue]
        });
      }

      return null;
    }

    if (fieldRule.type === 'multi_select') {
      if (!Array.isArray(fieldValue)) {
        return buildValidationError({
          reason_code: 'INVALID_MULTISELECT_TYPE',
          section,
          branch_code: branchCode,
          field: fieldName,
          expected_type: 'array',
          received_type: describeType(fieldValue),
          invalid_value: fieldValue,
          offending_values: []
        });
      }

      const invalidItems = fieldValue.filter((item) => typeof item !== 'string' || !fieldRule.allowed.includes(item));
      if (invalidItems.length > 0) {
        const reasonCode = invalidItems.some((item) => typeof item !== 'string')
          ? 'INVALID_MULTISELECT_TYPE'
          : 'INVALID_SELECTABLE_OPTION';

        return buildValidationError({
          reason_code: reasonCode,
          section,
          branch_code: branchCode,
          field: fieldName,
          expected_type: 'array<string>',
          received_type: 'array',
          invalid_value: invalidItems[0],
          offending_values: invalidItems
        });
      }

      return null;
    }

    if (fieldRule.type === 'number') {
      if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
        return buildValidationError({
          reason_code: 'INVALID_SELECTABLE_TYPE',
          section,
          branch_code: branchCode,
          field: fieldName,
          expected_type: 'number',
          received_type: describeType(fieldValue),
          invalid_value: fieldValue,
          offending_values: []
        });
      }

      return null;
    }

    if (fieldRule.type === 'url') {
      if (typeof fieldValue !== 'string') {
        return buildValidationError({
          reason_code: 'INVALID_SELECTABLE_TYPE',
          section,
          branch_code: branchCode,
          field: fieldName,
          expected_type: 'string',
          received_type: describeType(fieldValue),
          invalid_value: fieldValue,
          offending_values: []
        });
      }

      if (fieldValue === '') return null;
      return null;
    }

    return buildValidationError({
      reason_code: 'SELECTABLE_REGISTRY_LOAD_ERROR',
      section,
      branch_code: branchCode,
      field: fieldName,
      expected_type: 'supported registry type',
      received_type: fieldRule.type,
      invalid_value: fieldRule.type,
      offending_values: []
    });
  };

  const visitsFieldMap = {
    visit_type: 'Visit type',
    chief_complaint: 'Chief Complaint',
    pain_level: 'Pain level'
  };
  const visits = transformedPayload?.visits || {};
  for (const [payloadField, registryField] of Object.entries(visitsFieldMap)) {
    if (!(payloadField in visits)) continue;
    const visitError = validateField({
      section: 'Visits',
      fieldName: registryField,
      fieldValue: visits[payloadField]
    });
    if (visitError) return visitError;
  }

  const findings = Array.isArray(transformedPayload?.findings_records)
    ? transformedPayload.findings_records
    : [];

  const tableMap = {
    'PRE': 'Pre-op Clinical Findings',
    'RAD': 'Radiographic Findings',
    'OP': 'Operative Findings',
    'DX': 'Diagnosis',
    'PLAN': 'Treatment Plan',
    'DR': 'Doctor Reasoning'
  };

  for (const record of findings) {
    const branchCode = safeString(record?.branch_code);
    const tableName = tableMap[branchCode];
    if (!tableName) continue;

    const fields = record?.fields || {};
    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      if (fieldName === 'Record name' || fieldName === 'Visit ID' || fieldName === 'Tooth number') {
        continue;
      }

      const fieldError = validateField({
        section: tableName,
        branchCode,
        fieldName,
        fieldValue
      });
      if (fieldError) return fieldError;
    }
  }

  return { valid: true };
}

function buildPhase1Stage1ChoiceGuide(stage1Preview, sequentialState) {
  const currentItem = sequentialState?.currentItem || null;
  const isChiefComplaintItem =
    currentItem &&
    (currentItem.key === 'visits.chief_complaint' || currentItem.field === 'chief_complaint');
  return {
    next_step_type: 'sender_transform',
    send_ready: false,
    requires_confirmation_args: false,
    requires_choice_args: true,
    confirmation_field_path: '',
    choice_field_path: 'phase1_decision.phase1_multiple_policy_choice',
    accepted_choice_input_type: 'single_number_choice',
    accepted_choice_format: isChiefComplaintItem ? '1_keep_or_2_add_or_3_replace' : '1_add_or_2_replace',
    allowed_input_description: isChiefComplaintItem
      ? '1은 keep current, 2는 add, 3은 replace'
      : '1은 add, 2는 replace',
    choice_examples: isChiefComplaintItem ? ['1', '2', '3'] : ['1', '2'],
    user_input_prompt: buildPhase1Stage1UserQuestion(stage1Preview, sequentialState),
    arg_patch_examples: {
      choice_1: buildPhase1Stage1ArgPatch(sequentialState, currentItem, 1),
      choice_2: buildPhase1Stage1ArgPatch(sequentialState, currentItem, 2),
      ...(isChiefComplaintItem
        ? { choice_3: buildPhase1Stage1ArgPatch(sequentialState, currentItem, 3) }
        : {})
    }
  };
}

function buildNoOpDisplayRules() {
  return {
    must_follow_sender_display_rules: true,
    no_op_field_display: {
      when_current_state_unavailable: {
        exact_user_label: '현재 확인불가',
        render_instruction: 'show_explicitly_as_current_state_unavailable',
        visibility: 'show',
        style_hint: 'neutral_unknown_state'
      },
      when_no_op_true: {
        exact_user_label: '변경 없음',
        render_instruction: 'show_explicitly_as_unchanged',
        visibility: 'show',
        style_hint: 'deemphasize_but_do_not_hide'
      },
      when_no_op_false: {
        exact_user_label: '변경 예정',
        render_instruction: 'show_explicitly_as_change',
        visibility: 'show',
        style_hint: 'emphasize_change'
      }
    },
    assistant_mandatory_rules: [
      'If before is "(current-state unavailable)", display exactly "현재 확인불가".',
      'If no_op=true and before is not "(current-state unavailable)", display exactly "변경 없음".',
      'If no_op=false and before is not "(current-state unavailable)", display exactly "변경 예정".',
      'Do not replace these labels with synonyms or freeform wording.',
      'Do not hide no_op rows unless sender explicitly instructs hide.',
      'Show before/incoming/after together with the exact sender label when available.'
    ]
  };
}

function isCurrentStateUnavailableValue(value) {
  return safeString(value) === '(current-state unavailable)';
}

function computePreviewDisplayLabel(beforeValue, noOp) {
  if (isCurrentStateUnavailableValue(beforeValue)) {
    return '현재 확인불가';
  }
  return noOp ? '변경 없음' : '변경 예정';
}

function isPreviewBaselineReliable(currentState, transformedPayload) {
  if (!currentState || currentState.ready !== true) return false;
  if (currentState.patientExists !== true) return false;

  const requestedPatientId = safeString(transformedPayload?.patients?.patient_id);
  const patientFields = getRecordFields(currentState?.patientBody);
  const currentPatientId = safeString(patientFields['Patients ID']);
  if (!requestedPatientId || !currentPatientId) return false;
  return requestedPatientId == currentPatientId;
}

function buildPhase1Stage2ChoiceGuide(decision = {}) {
  const decisionPatch = {};
  const policyState = decision?.phase1_multiple_policy_state || decision?.policyState;
  if (policyState && typeof policyState === 'object' && !Array.isArray(policyState) && Object.keys(policyState).length > 0) {
    decisionPatch.phase1_multiple_policy_state = deepClone(policyState);
  }
  if (Number.isFinite(decision?.phase1_multiple_policy_cursor)) {
    decisionPatch.phase1_multiple_policy_cursor = decision.phase1_multiple_policy_cursor;
  }

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
    accepted_input_type: 'single_number_choice',
    accepted_input_format: '1_send_now_or_2_cancel',
    allowed_input_description: '1은 진행, 2는 취소',
    allowed_input_examples: ['1', '2'],
    arg_patch_template: {
      phase1_decision: {
        ...decisionPatch,
        phase1_full_preview_confirmation: '<type single number>'
      }
    },
    arg_patch_per_choice: {
      '1': {
        phase1_decision: {
          ...decisionPatch,
          phase1_full_preview_confirmation: 1
        }
      },
      '2': {
        phase1_decision: {
          ...decisionPatch,
          phase1_full_preview_confirmation: 2
        }
      }
    },
    ui_display_rules: buildNoOpDisplayRules()
  };
}

function buildPhase1FullPreview(transformedPayload, currentState, headerTouched, findingsTouched, decision, registryRules) {
  const headerChanges = [];
  const findingsChanges = [];
  const currentStateReliable = isPreviewBaselineReliable(currentState, transformedPayload);
  const patientFields = currentStateReliable ? getRecordFields(currentState?.patientBody) : {};
  const visitFields = currentStateReliable ? getRecordFields(currentState?.visitBody) : {};
  const replaceOverrideAppliedTo = deepClone(decision?.replaceOverrides || []);

  if (headerTouched.patients.birth_year) {
    const before = currentStateReliable ? (patientFields['Birth year'] ?? '(current-state unavailable)') : '(current-state unavailable)';
    const incoming = transformedPayload?.patients?.birth_year || '';
    headerChanges.push({
      section: 'patients',
      field: 'birth_year',
      before,
      incoming,
      policy: 'replace',
      after: incoming,
      no_op: valuesEqual(before, incoming, 'patients', 'birth_year'),
      label: computePreviewDisplayLabel(before, valuesEqual(before, incoming, 'patients', 'birth_year'))
    });
  }

  if (headerTouched.patients.gender) {
    const before = currentStateReliable ? (patientFields['Gender'] ?? '(current-state unavailable)') : '(current-state unavailable)';
    const incoming = transformedPayload?.patients?.gender || '';
    headerChanges.push({
      section: 'patients',
      field: 'gender',
      before,
      incoming,
      policy: 'replace',
      after: incoming,
      no_op: valuesEqual(before, incoming, 'patients', 'gender'),
      label: computePreviewDisplayLabel(before, valuesEqual(before, incoming, 'patients', 'gender'))
    });
  }

  if (headerTouched.visits.chief_complaint) {
    const before = currentStateReliable ? (visitFields['Chief Complaint'] || '') : '(current-state unavailable)';
    const incoming = transformedPayload?.visits?.chief_complaint || '';
    const changeKey = 'visits.chief_complaint';
    const policy = resolveFieldPolicy(changeKey, 'chief_complaint', decision);

    let afterValue;
    if (policy === 'keep_current') {
      afterValue = before;
    } else if (policy === 'add') {
      afterValue = isCurrentStateUnavailableValue(before)
        ? incoming
        : mergeChiefComplaintAdd(before, incoming);
    } else {
      afterValue = incoming;
    }

    const noOp = currentStateReliable
      ? valuesEqual(before, afterValue, 'visits', 'chief_complaint')
      : policy === 'keep_current';

    headerChanges.push({
      section: 'visits',
      field: 'chief_complaint',
      before,
      incoming,
      policy,
      after: afterValue,
      no_op: noOp,
      label: computePreviewDisplayLabel(before, noOp)
    });
  }

  if (headerTouched.visits.pain_level) {
    const before = currentStateReliable ? (visitFields['Pain level'] ?? '') : '(current-state unavailable)';
    const incoming = transformedPayload?.visits?.pain_level ?? '';
    headerChanges.push({
      section: 'visits',
      field: 'pain_level',
      before,
      incoming,
      policy: 'replace',
      after: incoming,
      no_op: valuesEqual(before, incoming, 'visits', 'pain_level'),
      label: computePreviewDisplayLabel(before, valuesEqual(before, incoming, 'visits', 'pain_level'))
    });
  }

  if (headerTouched.visits.visit_type) {
    const before = currentStateReliable ? (visitFields['Visit type'] || '') : '(current-state unavailable)';
    const incoming = transformedPayload?.visits?.visit_type || '';
    headerChanges.push({
      section: 'visits',
      field: 'visit_type',
      before,
      incoming,
      policy: 'replace',
      after: incoming,
      no_op: valuesEqual(before, incoming, 'visits', 'visit_type'),
      label: computePreviewDisplayLabel(before, valuesEqual(before, incoming, 'visits', 'visit_type'))
    });
  }

  const findings = Array.isArray(transformedPayload?.findings_records)
    ? transformedPayload.findings_records
    : [];

  for (const record of findings) {
    const branchCode = safeString(record?.branch_code);
    if (!branchCode) continue;

    const toothNumber = safeString(record?.tooth_number);
    const fields = record?.fields || {};
    const recordName = safeString(record?.record_name);
    const branchKey = safeString(record?.branch_key);

    for (const [fieldName, incomingValue] of Object.entries(fields)) {
      if (fieldName === 'Record name' || fieldName === 'Visit ID' || fieldName === 'Tooth number') {
        continue;
      }

      const fieldRule = getPhase2RegistryFieldRule(registryRules, branchKey, fieldName);
      const storedBeforeValue = currentStateReliable
        ? getStoredFindingField(currentState, branchKey, toothNumber, fieldName, recordName)
        : '(current-state unavailable)';
      const rowResolution = currentStateReliable
        ? getStoredFindingRowResolution(currentState, branchKey, toothNumber, recordName)
        : 'unresolved';
      const pendingRowCreation = currentStateReliable && rowResolution === 'unresolved';
      const beforeValue = pendingRowCreation ? '(new row)' : storedBeforeValue;
      const changeKey = `${branchKey}.${toothNumber}.${fieldName}`;
      const policy = resolveFieldPolicy(changeKey, fieldName, decision);

      let afterValue;
      if (safeString(fieldRule?.type) === 'multi_select' && policy === 'add') {
        afterValue = mergeMultiSelectAdd(
          pendingRowCreation ? undefined : storedBeforeValue,
          incomingValue
        );
      } else if (Array.isArray(incomingValue)) {
        afterValue = deepClone(incomingValue);
      } else {
        afterValue = incomingValue;
      }

      const noOp = pendingRowCreation
        ? false
        : currentStateReliable
          ? valuesEqual(storedBeforeValue, afterValue, branchKey, fieldName)
        : false;

      findingsChanges.push({
        branch: branchKey,
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
        pending_row_creation: pendingRowCreation,
        merge_mode: noOp ? 'no_op' : policy,
        current_live_before: beforeValue,
        expected_after: afterValue,
        label: pendingRowCreation ? '신규 행 생성 예정' : computePreviewDisplayLabel(beforeValue, noOp)
      });
    }
  }

  return {
    route_summary: {
      patient_id: transformedPayload?.patients?.patient_id || '',
      patient_status_claim: transformedPayload?.workflow?.patient_status_claim || '',
      visit_intent_claim: transformedPayload?.workflow?.visit_intent_claim || '',
      doctor_confirmed_correction: transformedPayload?.workflow?.doctor_confirmed_correction,
      correction_applied: transformedPayload?.workflow?.correction_applied || '',
      correction_case: transformedPayload?.workflow?.correction_case || '',
      correction_source: transformedPayload?.workflow?.correction_source || '',
      claim_label: buildPreviewSummary(transformedPayload).claim_label,
      exact_preview_fields: [
        'workflow.patient_status_claim',
        'workflow.visit_intent_claim',
        'workflow.doctor_confirmed_correction',
        'workflow.correction_applied',
        'workflow.correction_case',
        'workflow.correction_source',
        'visits.visit_id',
        'visits.date',
        'visits.visit_type',
        'visits.chief_complaint',
        'visits.pain_level'
      ],
      visit_id: transformedPayload?.visits?.visit_id || '',
      visit_date: transformedPayload?.visits?.date || '',
      route: 'existing_visit_update',
      update_scope: resolveUpdateScope(headerTouched, findingsTouched),
      current_state_reliable: currentStateReliable
    },
    policy_summary: {
      multiple_default_policy: 'field_specific',
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
    },
    ui_display_rules: buildNoOpDisplayRules()
  };
}

function buildSenderExecutionMetadata(headerTouched, stage2Preview, decision) {
  const branchGrouping = {};

  for (const change of stage2Preview.findings_changes || []) {
    const branch = safeString(change.branch);
    branchGrouping[branch] ||= {};

    const toothNumber = safeString(change.tooth_number);
    branchGrouping[branch][toothNumber] ||= {
      record_name: change.record_name || '',
      fields: {}
    };
    branchGrouping[branch][toothNumber].fields[change.field] = !change.no_op;
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

  const findingsUpdateFlags = {};
  for (const [branch, teeth] of Object.entries(branchGrouping)) {
    findingsUpdateFlags[branch] = teeth;
  }

  return {
    route: 'existing_visit_update',
    update_scope: stage2Preview?.route_summary?.update_scope || 'findings_only',
    header_update_flags: headerFlags,
    findings_update_flags: findingsUpdateFlags,
    preview_decision_trace: {
      two_stage_preview_used: true,
      multiple_override_stage_used: true,
      multiple_override_changed_fields: deepClone(decision?.replaceOverrides || []),
      replaceOverrides: deepClone(decision?.replaceOverrides || []),
      addOverrides: deepClone(decision?.addOverrides || []),
      keepCurrentOverrides: deepClone(decision?.keepCurrentOverrides || []),
      phase1_multiple_policy_state: deepClone(decision?.phase1_multiple_policy_state || decision?.policyState || {}),
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
  delete cleaned.phase1_multiple_policy_choice;
  delete cleaned.phase1_multiple_policy_choice_item_key;

  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function buildPhase1ExecutionPayload(transformedPayload, stage2Preview, headerTouched, decision) {
  const finalPayload = deepClone(transformedPayload);
  const findingsByRecordName = {};

  for (const change of stage2Preview.findings_changes || []) {
    const recordName = safeString(change.record_name);
    if (!recordName) continue;

    findingsByRecordName[recordName] ||= {};
    findingsByRecordName[recordName][change.field] = {
      after: change.after,
      no_op: change.no_op
    };
  }

  finalPayload.findings_records = finalPayload.findings_records.map((record) => {
    const recordName = safeString(record?.record_name);
    const patch = findingsByRecordName[recordName];
    if (!patch) return record;

    const nextFields = { ...record.fields };
    for (const [fieldName, fieldPatch] of Object.entries(patch)) {
      if (fieldPatch?.no_op) {
        delete nextFields[fieldName];
      } else {
        nextFields[fieldName] = fieldPatch.after;
      }
    }

    const hasWritableFields = Object.keys(nextFields).some((fieldName) => !['Record name', 'Visit ID', 'Tooth number'].includes(fieldName));
    if (!hasWritableFields) {
      return null;
    }

    return {
      ...record,
      fields: nextFields
    };
  }).filter(Boolean);

  for (const change of stage2Preview.header_changes || []) {
    if (change.section === 'patients' && (change.field === 'birth_year' || change.field === 'gender')) {
      finalPayload.patients = finalPayload.patients || {};
      if (change.no_op) {
        delete finalPayload.patients[change.field];
      } else {
        finalPayload.patients[change.field] = change.after;
      }
      continue;
    }

    if (change.section === 'visits' && (change.field === 'chief_complaint' || change.field === 'pain_level' || change.field === 'visit_type')) {
      finalPayload.visits = finalPayload.visits || {};
      if (change.no_op) {
        delete finalPayload.visits[change.field];
      } else {
        finalPayload.visits[change.field] = change.after;
      }
    }
  }

  finalPayload.sender_execution = buildSenderExecutionMetadata(
    headerTouched,
    stage2Preview,
    decision
  );

  return finalPayload;
}

function isPhase1Stage2NoOp(stage2Preview) {
  const summary = stage2Preview?.execution_summary || {};
  const headerCount = Array.isArray(summary.header_fields_to_update)
    ? summary.header_fields_to_update.length
    : 0;
  const findingsCount = Array.isArray(summary.findings_records_to_update)
    ? summary.findings_records_to_update.length
    : 0;

  return headerCount === 0 && findingsCount === 0;
}


async function buildPhase1TransformEnvelope(payload, transformResult, phase1DecisionRaw) {
  const transformedPayload = transformResult.transformed_payload;
  const headerTouched = detectHeaderTouchedFields(transformedPayload);
  const findingsTouched = detectFindingsTouchedFields(transformedPayload);

  const registryRules = buildPhase2RegistryRules();
  const validationResult = validateSelectableFieldsAgainstRegistry(transformedPayload, registryRules);

  if (!validationResult.valid) {
    return {
      ok: false,
      tool: 'sender_transform',
      request_id: transformResult.request_id,
      status: 'ERROR',
      stage: 'PHASE2_SELECTABLE_VALIDATION_FAILED',
      input_hash: transformResult.input_hash,
      transformed_hash: transformResult.transformed_hash,
      transformed_payload: transformResult.transformed_payload,
      error: {
        code: validationResult.reason_code || 'SELECTABLE_FIELD_VALIDATION_ERROR',
        message: validationResult.error || 'Selectable field validation failed',
        details: {
          reason_code: validationResult.reason_code || 'SELECTABLE_FIELD_VALIDATION_ERROR',
          section: validationResult.section || '',
          branch_code: validationResult.branch_code || '',
          field: validationResult.field || '',
          expected_type: validationResult.expected_type || '',
          received_type: validationResult.received_type || '',
          invalid_value: validationResult.invalid_value,
          offending_values: Array.isArray(validationResult.offending_values)
            ? validationResult.offending_values
            : []
        }
      },
      debug: {
        ...transformResult.debug,
        phase2_validation_applied: true,
        validation_error: validationResult.error,
        validation_details: {
          reason_code: validationResult.reason_code || 'SELECTABLE_FIELD_VALIDATION_ERROR',
          section: validationResult.section || '',
          branch_code: validationResult.branch_code || '',
          field: validationResult.field || '',
          expected_type: validationResult.expected_type || '',
          received_type: validationResult.received_type || '',
          invalid_value: validationResult.invalid_value,
          offending_values: Array.isArray(validationResult.offending_values)
            ? validationResult.offending_values
            : []
        }
      }
    };
  }

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

  const formatVisibleValue = formatStage1VisibleValue;

  const buildStage2HeaderBlock = (change) => [
    `[header] ${safeString(change.section)}.${safeString(change.field)}`,
    `- 상태: ${formatVisibleValue(change.label)}`,
    `- policy: ${formatVisibleValue(change.policy)}`,
    `- before: ${formatVisibleValue(change.before)}`,
    `- incoming: ${formatVisibleValue(change.incoming)}`,
    `- after: ${formatVisibleValue(change.after)}`
  ].join('\n');

  const buildStage2FindingBlock = (change) => {
    const lines = [
      `[finding] ${safeString(change.branch)} tooth ${safeString(change.tooth_number)} ${safeString(change.field)}`,
      `- 상태: ${formatVisibleValue(change.label)}`,
      `- policy: ${formatVisibleValue(change.policy)}`,
      `- before: ${formatVisibleValue(change.before)}`,
      `- incoming: ${formatVisibleValue(change.incoming)}`,
      `- after: ${formatVisibleValue(change.after)}`
    ];

    if (change.pending_row_creation) {
      lines.push('- row: 신규 행 생성 예정');
    }

    return lines.join('\n');
  };

  const stage1Preview = currentState.ready
    ? buildPhase1MultiplePreview(transformedPayload, currentState, registryRules)
    : { stage: 'multiple_policy_preview', items: [], prompt: '' };
  const sequentialStage1 = buildSequentialStage1PolicyState(phase1DecisionRaw, stage1Preview);
  const stage1AllItems = getStage1AllItems(stage1Preview);
  const stage1InteractiveItems = getStage1InteractiveItems(stage1Preview);
  const stage1DisplayOnlyItems = getStage1DisplayOnlyItems(stage1Preview);

  if (stage1InteractiveItems.length > 0 && !sequentialStage1.complete) {
    const stage1Guide = buildPhase1Stage1ChoiceGuide(stage1Preview, sequentialStage1);
    const stage1RequiredInput = buildPhase1Stage1RequiredInput(stage1Preview, sequentialStage1);
    const currentStage1Item = sequentialStage1.currentItem;
    const isChiefComplaintItem =
      currentStage1Item &&
      (currentStage1Item.key === 'visits.chief_complaint' || currentStage1Item.field === 'chief_complaint');
    const stage1CanonicalBody = buildPhase1Stage1VisibleBody(stage1Preview, sequentialStage1);
    const previewBodyMarkdown = stage1CanonicalBody;
    const stage1GuideWithFullBody = {
      ...stage1Guide,
      user_input_prompt: stage1CanonicalBody
    };

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
        stage1_decision: buildPhase1DecisionFromPolicyState(stage1Preview, sequentialStage1.policyState, sequentialStage1.cursor),
        stage1_progress: {
          current_item_key: currentStage1Item?.key || '',
          cursor: sequentialStage1.cursor,
          total_items: stage1InteractiveItems.length,
          total_all_items: stage1AllItems.length,
          total_interactive_items: stage1InteractiveItems.length,
          display_only_item_count: stage1DisplayOnlyItems.length,
          invalid_choice: sequentialStage1.invalidChoice === true,
          choice_accepted: sequentialStage1.choiceAccepted === true
        },
        next_step: stage1GuideWithFullBody
      },
      interaction: {
        mode: 'ask_user',
        ui_kind: 'input',
        user_message: stage1CanonicalBody,
        assistant_question: stage1CanonicalBody,
        preview_body_markdown: previewBodyMarkdown,
        required_user_input: stage1RequiredInput,
        next_step: stage1GuideWithFullBody,
        do_not_ask: []
      },
      execution_contract: {
        contract_version: '1.0',
        mode: 'await_user_choice',
        must_show_message: true,
        user_visible_message: stage1CanonicalBody,
        must_ask_user: true,
        user_question: stage1CanonicalBody,
        accepted_input_type: 'single_number_choice',
        accepted_format: isChiefComplaintItem ? '1_keep_or_2_add_or_3_replace' : '1_add_or_2_replace',
        allowed_input_description: isChiefComplaintItem
          ? '1은 keep current, 2는 add, 3은 replace'
          : '1은 add, 2는 replace',
        allowed_input_examples: isChiefComplaintItem ? ['1', '2', '3'] : ['1', '2'],
        allowed_actions: [
          'show_preview',
          'ask_single_number_choice',
          'resume_stage1_or_build_full_preview'
        ],
        forbidden_actions: [
          'auto_send_without_confirmation'
        ],
        auto_resend_allowed: false,
        stop_after_response: false,
        next_step: stage1GuideWithFullBody
      },
      debug: {
        ...transformResult.debug,
        phase1_applicable: true,
        current_state_ready: true,
        stage1_cursor: sequentialStage1.cursor,
        stage1_invalid_choice: sequentialStage1.invalidChoice === true
      }
    };
  }

  const phase1Decision = buildPhase1DecisionFromPolicyState(
    stage1Preview,
    sequentialStage1.policyState,
    sequentialStage1.cursor
  );
  const stage2Preview = buildPhase1FullPreview(
    transformedPayload,
    currentState,
    headerTouched,
    findingsTouched,
    phase1Decision,
    registryRules
  );
	  const finalExecutionPayload = buildPhase1ExecutionPayload(
	    transformedPayload,
	    stage2Preview,
	    headerTouched,
	    phase1Decision
	  );
  const stage2HeaderSummary = (stage2Preview.header_changes || []).length > 0
    ? (stage2Preview.header_changes || []).map((change) => buildStage2HeaderBlock(change)).join('\n\n')
    : '[header]\n- none';
  const stage2FindingsSummary = (stage2Preview.findings_changes || []).length > 0
    ? (stage2Preview.findings_changes || []).map((change) => buildStage2FindingBlock(change)).join('\n\n')
    : '[finding]\n- none';
  const stage2CanonicalBody = [
    '기존 방문 업데이트 full preview입니다. 아래 내용을 확인한 뒤 숫자로 선택해 주세요.',
    '',
    stage2HeaderSummary,
    '',
    stage2FindingsSummary,
    '',
    '1. 이대로 진행',
    '2. 취소'
  ].join('\n');
  const stage2Guide = buildPhase1Stage2ChoiceGuide(phase1Decision);
  const stage2GuideWithFullBody = {
    ...stage2Guide,
    user_input_prompt: stage2CanonicalBody
  };
	
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
      next_step: stage2GuideWithFullBody
    },
	    interaction: {
	      mode: 'ask_user',
	      ui_kind: 'input',
	      user_message: stage2CanonicalBody,
	      assistant_question: stage2CanonicalBody,
	      required_user_input: {
	        type: 'single_number_choice',
	        field: 'phase1_full_preview_confirmation',
          format: '1_send_now_or_2_cancel',
          allowed_input_description: '1은 진행, 2는 취소',
          examples: ['1', '2'],
          arg_patch_template: stage2Guide.arg_patch_template,
          arg_patch_examples: stage2Guide.arg_patch_per_choice,
          confirmation_value_for_each_choice: stage2Guide.confirmation_value_for_each_choice
      },
      ui_display_rules: buildNoOpDisplayRules(),
      next_step: stage2GuideWithFullBody,
      do_not_ask: []
    },
	    execution_contract: {
	      contract_version: '1.0',
	      mode: 'await_user_choice',
	      must_show_message: true,
	      user_visible_message: stage2CanonicalBody,
	      must_ask_user: true,
	      user_question: stage2CanonicalBody,
	      accepted_input_type: 'single_number_choice',
      allowed_numbers: [1, 2],
      number_meanings: {
        '1': 'send_now',
        '2': 'cancel'
      },
      ui_display_rules: buildNoOpDisplayRules(),
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
      next_step: stage2GuideWithFullBody
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

function getDestinationTableInfo(branchCode) {
  const normalized = safeString(branchCode);
  const map = {
    PRE: { table_key: 'pre_op', table_name: 'Pre-op Clinical Findings' },
    RAD: { table_key: 'radiographic', table_name: 'Radiographic Findings' },
    OP: { table_key: 'operative', table_name: 'Operative Findings' },
    DX: { table_key: 'diagnosis', table_name: 'Diagnosis' },
    PLAN: { table_key: 'treatment_plan', table_name: 'Treatment Plan' },
    DR: { table_key: 'doctor_reasoning', table_name: 'Doctor Reasoning' }
  };
  return map[normalized] || { table_key: '', table_name: '' };
}

function toDisplayValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => safeString(item)).filter(Boolean).join(', ');
  }
  if (value === '') return '(blank)';
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return safeString(value);
}

function pickRepresentativeFieldsForBranch(fields, branchCode) {
  const normalized = safeString(branchCode);
  const preferredKeys = {
    PRE: ['Symptom', 'Visible crack', 'Pulp - cold test', 'existing restorations', 'Existing restoration size'],
    RAD: ['Radiograph type', 'Radiographic caries depth', 'Secondary caries', 'Caries location', 'Periapical lesion'],
    OP: ['Crack confirmed', 'Rubber dam isolation', 'Caries depth (actual)', 'Remaining cusp thickness (mm)', 'Subgingival margin'],
    DX: ['Structural diagnosis', 'Pulp diagnosis', 'Crack severity', 'Restorability', 'Occlusal risk'],
    PLAN: ['Pulp therapy', 'Restoration design', 'Restoration material', 'Implant placement'],
    DR: ['Decision factor', 'Remaining cusp thickness decision', 'Crack progression risk', 'Occlusal risk', 'Reasoning notes']
  }[normalized] || [];

  const reserved = new Set(['Record name', 'Visit ID', 'Tooth number']);
  const output = [];

  for (const key of preferredKeys) {
    if (!reserved.has(key) && fields[key] !== undefined) {
      output.push({ field: key, value: toDisplayValue(fields[key]) });
    }
  }

  for (const [key, value] of Object.entries(fields || {})) {
    if (reserved.has(key)) continue;
    if (preferredKeys.includes(key)) continue;
    output.push({ field: key, value: toDisplayValue(value) });
  }

  return output;
}

function buildPreviewSummary(transformedPayload) {
  const patientStatusClaim = transformedPayload.workflow?.patient_status_claim || '';
  const visitIntentClaim = transformedPayload.workflow?.visit_intent_claim || '';
  const doctorConfirmedCorrection = transformedPayload.workflow?.doctor_confirmed_correction;
  const correctionApplied = transformedPayload.workflow?.correction_applied || '';
  const correctionCase = transformedPayload.workflow?.correction_case || '';
  const correctionSource = transformedPayload.workflow?.correction_source || '';

  const findings = Array.isArray(transformedPayload.findings_records)
    ? transformedPayload.findings_records.map((record, index) => {
        const tableInfo = getDestinationTableInfo(record.branch_code);
        const representative_fields = pickRepresentativeFieldsForBranch(record.fields || {}, record.branch_code);

        return {
          no: index + 1,
          branch_code: record.branch_code || '',
          branch_label: record.branch_label || '',
          destination_table_key: tableInfo.table_key,
          destination_table_name: tableInfo.table_name,
          tooth_number: record.tooth_number || '',
          record_name: record.record_name || '',
          representative_fields,
          entered_field_count: representative_fields.length
        };
      })
    : [];

  return {
    patient_id: transformedPayload.patients?.patient_id || '',
    patient_status_claim: patientStatusClaim,
    visit_intent_claim: visitIntentClaim,
    doctor_confirmed_correction: doctorConfirmedCorrection,
    correction_applied: correctionApplied,
    correction_case: correctionCase,
    correction_source: correctionSource,
    claim_label: buildClaimLabel(patientStatusClaim, visitIntentClaim),
    workflow_snapshot: {
      patient_status_claim: patientStatusClaim,
      visit_intent_claim: visitIntentClaim,
      doctor_confirmed_correction: doctorConfirmedCorrection,
      correction_applied: correctionApplied,
      correction_case: correctionCase,
      correction_source: correctionSource
    },
    exact_preview_fields: [
      'workflow.patient_status_claim',
      'workflow.visit_intent_claim',
      'workflow.doctor_confirmed_correction',
      'workflow.correction_applied',
      'workflow.correction_case',
      'workflow.correction_source',
      'patients.patient_id',
      'patients.birth_year',
      'patients.gender',
      'visits.visit_id',
      'visits.date',
      'visits.visit_type',
      'visits.chief_complaint',
      'visits.pain_level',
      'findings_records[].fields',
      'findings_records[].destination_table'
    ],
    patient_header: {
      destination_table_name: 'Patients',
      patient_id: transformedPayload.patients?.patient_id || '',
      birth_year: toDisplayValue(transformedPayload.patients?.birth_year || ''),
      gender: toDisplayValue(transformedPayload.patients?.gender || '')
    },
    visit_header: {
      destination_table_name: 'Visits',
      visit_id: transformedPayload.visits?.visit_id || '',
      visit_date: transformedPayload.visits?.date || '',
      visit_type: toDisplayValue(transformedPayload.visits?.visit_type || ''),
      chief_complaint: toDisplayValue(transformedPayload.visits?.chief_complaint || ''),
      pain_level: toDisplayValue(
        transformedPayload.visits?.pain_level === '' ? '(blank)' : transformedPayload.visits?.pain_level
      )
    },
    destination_tables: [
      { table_key: 'patients', table_name: 'Patients' },
      { table_key: 'visits', table_name: 'Visits' },
      ...Object.values(
        findings.reduce((acc, item) => {
          if (!item.destination_table_key) return acc;
          acc[item.destination_table_key] ||= {
            table_key: item.destination_table_key,
            table_name: item.destination_table_name
          };
          return acc;
        }, {})
      )
    ],
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
      next_step_on_choice: {
        '1': {
          next_step_type: 'sender_transform',
          must_open_preview_immediately: true,
          send_ready: false,
          reason: 'choice 1 requires corrected existing_visit_update preview before final send'
        },
        '2': {
          next_step_type: 'sender_send',
          send_ready: true,
          reason: 'choice 2 proceeds with new_visit claim as-is'
        }
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
        format: '6_digit_string',
        arg_patch: {
          patients: {
            patient_id: '__USER_INPUT__'
          },
          workflow: {
            patient_recheck_attempted: true
          }
        }
      },
      next_step: {
        next_step_type: 'sender_transform',
        send_ready: false,
        requires_user_input: true,
        must_open_preview_immediately: true,
        must_not_call_sender_send_after_reinput: true,
        input_field_path: 'patients.patient_id',
        set_fields_after_input: {
          'workflow.patient_recheck_attempted': true
        },
        regenerate_fields_after_input: [
          'visits.visit_id',
          'findings_records[].visit_id',
          'findings_records[].record_name'
        ],
        arg_patch_template: {
          patients: {
            patient_id: '__USER_INPUT__'
          },
          workflow: {
            patient_recheck_attempted: true
          }
        }
      },
      next_call_example: {
        use_same_payload: true,
        tool: 'sender_transform',
        patch: {
          patients: {
            patient_id: '__NEW_6_DIGIT_PATIENT_ID__'
          },
          workflow: {
            patient_recheck_attempted: true
          }
        }
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
        'workflow.mode': 'existing_visit_update',
        'workflow.patient_status_claim': 'existing_patient',
        'workflow.visit_intent_claim': 'existing_visit_update',
        'workflow.doctor_confirmed_correction': true,
        'workflow.correction_applied': 'true',
        'workflow.correction_case': 'same_date_existing_visit_possible_update',
        'workflow.correction_source': 'sender_resend_after_correction_required'
      },
      set_fields_on_keep_new_visit_claim: {
        'workflow.doctor_confirmed_correction': false
      },
      next_step_type_on_choice: {
        '1': 'sender_transform',
        '2': 'sender_send'
      },
      choice_1_instruction: {
        next_step_type: 'sender_transform',
        must_open_preview_immediately: true,
        reason: 'corrected existing_visit_update preview required before final send',
        expected_phase1: 'may_apply_if_has_header_or_symptom_touch'
      },
      choice_2_instruction: {
        next_step_type: 'sender_send',
        send_ready: true
      },
      next_call_example_choice_1: {
        use_same_payload: true,
        tool: 'sender_transform',
        patch: {
          workflow: {
            mode: 'existing_visit_update',
            patient_status_claim: 'existing_patient',
            visit_intent_claim: 'existing_visit_update',
            doctor_confirmed_correction: true,
            correction_applied: 'true',
            correction_case: 'same_date_existing_visit_possible_update',
            correction_source: 'sender_resend_after_correction_required'
          }
        }
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
      ],
      required_user_patch_fields: ['patients.patient_id'],
      arg_patch_template: {
        patients: {
          patient_id: '__USER_INPUT__'
        },
        workflow: {
          patient_recheck_attempted: true
        }
      },
      next_call_example: {
        use_same_payload: true,
        tool: 'sender_transform',
        patch: {
          patients: {
            patient_id: '__NEW_6_DIGIT_PATIENT_ID__'
          },
          workflow: {
            patient_recheck_attempted: true
          }
        }
      },
      next_step_type: 'sender_transform',
      must_open_preview_immediately: true,
      must_not_call_sender_send_after_reinput: true
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
      next_step_routing: {
        '1': {
          next_step_type: 'sender_transform',
          must_open_preview_immediately: true,
          send_ready: false,
          mandate: 'MUST NOT CALL sender_send DIRECTLY after choice 1',
          reason: 'semantically corrected existing_visit_update payload requires preview confirmation first',
          corrected_payload_requirements: [
            'workflow.mode = existing_visit_update',
            'workflow.patient_status_claim = existing_patient',
            'workflow.visit_intent_claim = existing_visit_update',
            'workflow.doctor_confirmed_correction = true',
            'corrected payload must pass isExistingVisitUpdatePayload validation',
            'if Phase1 applicable, show Phase1 preview',
            'final detailed preview must appear before send'
          ]
        },
        '2': {
          next_step_type: 'sender_send',
          send_ready: true,
          mandate: 'proceed with new_visit claim unchanged'
        }
      },
      allowed_actions: [
        'ask_single_number_choice',
        'patch_previous_payload',
        'transform_after_user_answer_choice_1',
        'send_after_user_answer_choice_2'
      ],
      forbidden_actions: [
        'ask_patient_id_again',
        'ask_full_json_again',
        'ask_full_briefing_again',
        'ask_findings_again',
        'send_directly_after_choice_1_without_transform'
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
      required_input_field_path: 'patients.patient_id',
      set_fields_after_input: {
        'workflow.patient_recheck_attempted': true
      },
      arg_patch_template: {
        patients: {
          patient_id: '__USER_INPUT__'
        },
        workflow: {
          patient_recheck_attempted: true
        }
      },
      next_call_example: {
        use_same_payload: true,
        tool: 'sender_transform',
        patch: {
          patients: {
            patient_id: '__NEW_6_DIGIT_PATIENT_ID__'
          },
          workflow: {
            patient_recheck_attempted: true
          }
        }
      },
      next_step_type: 'sender_transform',
      must_open_preview_immediately: true,
      must_not_call_sender_send_after_reinput: true,
      regenerate_fields_after_input: [
        'visits.visit_id',
        'findings_records[].visit_id',
        'findings_records[].record_name'
      ],
      allowed_actions: [
        'ask_only_patient_id',
        'patch_previous_payload',
        'open_preview_after_user_answer'
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
      allowed_actions: ['show_stop_message', 'retry_later'],
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
  const interaction = buildInteraction(senderJson);
  const resendPlan = buildResendPlan(senderJson);
  const executionContract = buildExecutionContract(senderJson);
  const isPatientRecheckRequired =
    senderJson.result_type === 'recheck_required' &&
    senderJson.reason_code === 'PATIENT_NOT_FOUND_RECHECK_REQUIRED';

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
    interaction,
    resend_plan: resendPlan,
    execution_contract: executionContract,
    required_reinput_field: isPatientRecheckRequired
      ? 'patients.patient_id'
      : '',
    arg_patch: isPatientRecheckRequired
      ? {
          patients: {
            patient_id: '__USER_INPUT__'
          },
          workflow: {
            patient_recheck_attempted: true
          }
        }
      : null,
    next_call_example: isPatientRecheckRequired
      ? {
          use_same_payload: true,
          tool: 'sender_transform',
          patch: {
            patients: {
              patient_id: '__NEW_6_DIGIT_PATIENT_ID__'
            },
            workflow: {
              patient_recheck_attempted: true
            }
          }
        }
      : null,
    next_step_type: isPatientRecheckRequired ? 'sender_transform' : '',
    must_open_preview_immediately: isPatientRecheckRequired,
    must_not_call_sender_send_after_reinput: isPatientRecheckRequired,
    debug: senderJson.debug || {}
  };
}





function isNewPatientNewVisitPayload(payload) {
  return (
    safeString(payload?.workflow?.patient_status_claim) === 'new_patient' &&
    safeString(payload?.workflow?.visit_intent_claim) === 'new_visit'
  );
}

function parseNewPatientPatientFoundDecision(rawDecision) {
  const decision =
    rawDecision && typeof rawDecision === 'object' && !Array.isArray(rawDecision)
      ? rawDecision.new_patient_patient_found_decision
      : rawDecision;

  const token = normalizeChoiceToken(decision);

  if (
    token === '1' ||
    token === 'switch_existing_new_visit' ||
    token === 'existing_patient_new_visit'
  ) {
    return 'switch_existing_new_visit';
  }

  if (
    token === '2' ||
    token === 'reenter_patient_id' ||
    token === 'reinput_patient_id'
  ) {
    return 'reenter_patient_id';
  }

  if (token === '3' || token === 'cancel') {
    return 'cancel';
  }

  return '';
}

function extractNewPatientPatientFoundReplacementPatientId(rawDecision) {
  if (!rawDecision || typeof rawDecision !== 'object' || Array.isArray(rawDecision)) {
    return '';
  }

  if (parseNewPatientPatientFoundDecision(rawDecision) !== 'reenter_patient_id') {
    return '';
  }

  const direct = safeString(
    rawDecision.new_patient_patient_found_replacement_patient_id ||
    rawDecision.replacement_patient_id
  ).trim();

  if (/^\d{6}$/.test(direct)) {
    return direct;
  }

  const nested = safeString(
    rawDecision.patch?.patients?.patient_id
  ).trim();

  return /^\d{6}$/.test(nested) ? nested : '';
}

function clearNewPatientPatientFoundReentryState(rawDecision) {
  if (!rawDecision || typeof rawDecision !== 'object' || Array.isArray(rawDecision)) {
    return rawDecision;
  }

  const cleaned = deepClone(rawDecision);
  delete cleaned.new_patient_patient_found_decision;
  delete cleaned.new_patient_patient_found_replacement_patient_id;
  delete cleaned.replacement_patient_id;

  if (cleaned.patch && typeof cleaned.patch === 'object' && !Array.isArray(cleaned.patch)) {
    if (cleaned.patch.patients && typeof cleaned.patch.patients === 'object' && !Array.isArray(cleaned.patch.patients)) {
      delete cleaned.patch.patients.patient_id;
      if (Object.keys(cleaned.patch.patients).length === 0) {
        delete cleaned.patch.patients;
      }
    }

    if (Object.keys(cleaned.patch).length === 0) {
      delete cleaned.patch;
    }
  }

  return cleaned;
}

function buildFreshNewPatientPatientFoundReentryArgPatch() {
  return {
    phase1_decision: {
      new_patient_patient_found_decision: 2,
      new_patient_patient_found_replacement_patient_id: '',
      replacement_patient_id: '',
      patch: {
        patients: {
          patient_id: ''
        }
      }
    }
  };
}

function applyNewPatientPatientFoundReplacementPatientId(payload, replacementPatientId) {
  const patched = deepClone(payload);
  patched.patients ||= {};
  patched.patients.patient_id = replacementPatientId;
  return patched;
}

function convertNewPatientConflictToExistingPatientNewVisitPayload(payload) {
  const patched = deepClone(payload);

  patched.workflow ||= {};
  patched.workflow.mode = 'existing_patient_new_visit';
  patched.workflow.patient_status_claim = 'existing_patient';
  patched.workflow.visit_intent_claim = 'new_visit';

  return patched;
}

function isExistingPatientNewVisitPayload(payload) {
  return (
    safeString(payload?.workflow?.mode) === 'existing_patient_new_visit' &&
    safeString(payload?.workflow?.patient_status_claim) === 'existing_patient' &&
    safeString(payload?.workflow?.visit_intent_claim) === 'new_visit'
  );
}

function hasExistingPatientNewVisitPatientHeaderTouch(payload) {
  if (!isExistingPatientNewVisitPayload(payload)) return false;
  const patients = payload?.patients || {};
  return Boolean(
    (patients.birth_year !== undefined && patients.birth_year !== '') ||
    (patients.gender !== undefined && patients.gender !== '')
  );
}

function detectExistingPatientHeaderDiff(currentState, transformedPayload) {
  const fields = getRecordFields(currentState?.patientBody);
  const touched = [];
  const incomingBirthYear = transformedPayload?.patients?.birth_year;
  const incomingGender = transformedPayload?.patients?.gender;

  if (incomingBirthYear !== undefined && incomingBirthYear !== '') {
    const before = fields['Birth year'] ?? '';
    if (!valuesEqual(before, incomingBirthYear, 'patients', 'birth_year')) {
      touched.push({
        section: 'patients',
        field: 'birth_year',
        before,
        incoming: incomingBirthYear,
        after_if_apply: incomingBirthYear,
        after_if_ignore: before,
        destination_table_name: 'Patients'
      });
    }
  }

  if (incomingGender !== undefined && incomingGender !== '') {
    const before = fields['Gender'] ?? '';
    if (!valuesEqual(before, incomingGender, 'patients', 'gender')) {
      touched.push({
        section: 'patients',
        field: 'gender',
        before,
        incoming: incomingGender,
        after_if_apply: incomingGender,
        after_if_ignore: before,
        destination_table_name: 'Patients'
      });
    }
  }

  return touched;
}

function parseExistingPatientNewVisitHeaderDecision(rawDecision) {
  const decision = rawDecision && typeof rawDecision === 'object' && !Array.isArray(rawDecision)
    ? rawDecision.existing_patient_new_visit_header_decision
    : rawDecision;
  const token = normalizeChoiceToken(decision);
  if (token === '1' || token === 'apply' || token === 'update' || token === 'true' || token === 'yes') {
    return 'apply';
  }
  if (token === '2' || token === 'ignore' || token === 'skip' || token === 'false' || token === 'no') {
    return 'ignore';
  }
  return '';
}

function parseNewVisitFinalConfirmation(rawDecision) {
  const decision = rawDecision && typeof rawDecision === 'object' && !Array.isArray(rawDecision)
    ? rawDecision.new_visit_full_preview_confirmation
    : rawDecision;
  const token = normalizeChoiceToken(decision);
  if (token === '1' || token === 'send_now' || token === 'confirm' || token === 'true' || token === 'yes') {
    return 'send_now';
  }
  if (token === '2' || token === 'cancel' || token === 'false' || token === 'no') {
    return 'cancel';
  }
  return '';
}


async function buildNewPatientPatientFoundTransformEnvelope(payload, transformResult, rawDecision) {
  const transformedPayload = deepClone(transformResult.transformed_payload);

  if (!isNewPatientNewVisitPayload(payload)) {
    return null;
  }

  const decision = parseNewPatientPatientFoundDecision(rawDecision);
  const replacementPatientId = extractNewPatientPatientFoundReplacementPatientId(rawDecision);
  const patientId = safeString(transformedPayload?.patients?.patient_id);
  const patientResp = await fetchPatient(patientId);
  const isRelookupAttempt = decision === 'reenter_patient_id' && !!replacementPatientId;
  const isReallyUnavailable = !(patientResp && patientResp.ok) && !patientResp?.semantic_not_found;

  if (isReallyUnavailable) {
    const stopMessage = isRelookupAttempt
      ? `새 patient_id ${patientId || '(blank)'} 로 다시 확인하려 했지만 현재 다시 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.`
      : '현재 다시 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.';

    return {
      ok: false,
      tool: 'sender_transform',
      request_id: transformResult.request_id,
      status: 'ERROR',
      stage: 'NEW_PATIENT_PATIENT_FOUND_CURRENT_STATE_REQUIRED_UNAVAILABLE',
      input_hash: transformResult.input_hash,
      transformed_hash: transformResult.transformed_hash,
      transformed_payload: transformedPayload,
      error: {
        code: 'CURRENT_STATE_REQUIRED_UNAVAILABLE',
        message: isRelookupAttempt
          ? '재입력한 patient_id로 현재 다시 확인할 수 없어 진행을 멈췄습니다.'
          : '현재 환자 존재 여부를 다시 확인할 수 없어 진행을 멈췄습니다.'
      },
      interaction: {
        mode: 'inform',
        ui_kind: 'info',
        user_message: stopMessage,
        assistant_question: '',
        required_user_input: null,
        do_not_ask: []
      },
      execution_contract: {
        contract_version: '1.0',
        mode: 'stop',
        must_show_message: true,
        user_visible_message: stopMessage,
        must_ask_user: false,
        user_question: '',
        accepted_input_type: null,
        allowed_actions: ['show_stop_message', 'retry_later'],
        forbidden_actions: ['auto_send_without_current_state_check'],
        auto_resend_allowed: false,
        stop_after_response: true
      },
      debug: {
        ...transformResult.debug,
        new_patient_patient_found_conflict_flow: true,
        current_state_ready: false,
        current_state_fetch_attempted: true,
        current_state_retry_rounds_used: patientResp?.retry_rounds_used || 0,
        current_state_attempted_urls: patientResp?.attempted_urls || [],
        current_state_last_error: patientResp?.last_error || patientResp?.raw_text || '',
        relookup_attempted: isRelookupAttempt
      }
    };
  }

  const patientExists = getPatientExistsFromBody(patientResp.body);

  if (patientExists !== true) {
    if (isRelookupAttempt) {
      return {
        ok: true,
        tool: 'sender_transform',
        request_id: transformResult.request_id,
        status: transformResult.status,
        stage: 'NEW_PATIENT_PATIENT_FOUND_RELOOKUP_NOT_FOUND_RESOLVED',
        input_hash: transformResult.input_hash,
        transformed_hash: transformResult.transformed_hash,
        transformed_payload: transformedPayload,
        preview_summary: buildPreviewSummary(transformedPayload),
        new_patient_patient_found_conflict: {
          applicable: true,
          resolved: true,
          resolution: 'not_found_after_reenter',
          patient_id: patientId,
          matched_existing_patient: false,
          relookup_result: 'not_found'
        },
        interaction: buildTransformInteraction(),
        execution_contract: buildTransformExecutionContract(),
        debug: {
          ...transformResult.debug,
          new_patient_patient_found_conflict_flow: true,
          relookup_attempted: true,
          relookup_result: 'not_found',
          conflict_resolved: true,
          stale_reentry_state_cleared: true
        }
      };
    }

    return null;
  }

  if (!decision || isRelookupAttempt) {
    const conflictUserMessage = isRelookupAttempt
      ? `재입력한 patient_id ${patientId} 로도 기존 환자가 검색되었습니다.`
      : '신규 환자로 입력되었지만 현재 patient_id로 기존 환자가 검색되었습니다.';

    const conflictPreviewStage = isRelookupAttempt
      ? 'NEW_PATIENT_PATIENT_FOUND_RELOOKUP_FOUND_STAGE1_PREVIEW'
      : 'NEW_PATIENT_PATIENT_FOUND_STAGE1_PREVIEW';

    return {
      ok: true,
      tool: 'sender_transform',
      request_id: transformResult.request_id,
      status: transformResult.status,
      stage: conflictPreviewStage,
      input_hash: transformResult.input_hash,
      transformed_hash: transformResult.transformed_hash,
      transformed_payload: transformedPayload,
      preview_summary: buildPreviewSummary(transformedPayload),
      new_patient_patient_found_conflict: {
        applicable: true,
        stage: 1,
        patient_id: patientId,
        matched_existing_patient: true,
        relookup_result: isRelookupAttempt ? 'found' : '',
        next_step: {
          next_step_type: 'sender_transform',
          send_ready: false,
          requires_choice_args: true,
          choice_field_path: 'phase1_decision.new_patient_patient_found_decision',
          arg_patch_per_choice: {
            '1': {
              phase1_decision: {
                new_patient_patient_found_decision: 1
              }
            },
            '2': buildFreshNewPatientPatientFoundReentryArgPatch(),
            '3': {
              phase1_decision: {
                new_patient_patient_found_decision: 3
              }
            }
          }
        }
      },
      interaction: {
        mode: 'ask_user',
        ui_kind: 'confirmation',
        user_message: conflictUserMessage,
        assistant_question:
          '숫자만 입력해 주세요.\n' +
          '1. 기존 환자 신규 방문으로 수정 후 preview 진행\n' +
          '2. patient_id 다시 입력\n' +
          '3. 취소',
        required_user_input: {
          type: 'single_number_choice',
          field: 'new_patient_patient_found_decision',
          choices: [
            {
              number: 1,
              label: '기존 환자 신규 방문으로 수정 후 preview 진행',
              value: 'switch_existing_new_visit',
              arg_patch: {
                phase1_decision: {
                  new_patient_patient_found_decision: 1
                }
              }
            },
            {
              number: 2,
              label: 'patient_id 다시 입력',
              value: 'reenter_patient_id',
              arg_patch: buildFreshNewPatientPatientFoundReentryArgPatch()
            },
            {
              number: 3,
              label: '취소',
              value: 'cancel',
              arg_patch: {
                phase1_decision: {
                  new_patient_patient_found_decision: 3
                }
              }
            }
          ]
        },
        do_not_ask: [
          'full_json',
          'full_briefing',
          'findings_reentry'
        ]
      },
      execution_contract: {
        contract_version: '1.0',
        mode: 'await_user_choice',
        must_show_message: true,
        user_visible_message: conflictUserMessage,
        must_ask_user: true,
        user_question:
          '1. 기존 환자 신규 방문으로 수정 후 preview 진행\n' +
          '2. patient_id 다시 입력\n' +
          '3. 취소',
        accepted_input_type: 'single_number_choice',
        allowed_numbers: [1, 2, 3],
        number_meanings: {
          '1': 'switch_existing_new_visit',
          '2': 'reenter_patient_id',
          '3': 'cancel'
        },
        allowed_actions: [
          'ask_single_number_choice',
          'patch_previous_payload_or_reinput_patient_id',
          'open_preview_after_user_choice'
        ],
        forbidden_actions: [
          'auto_send_without_resolution'
        ],
        auto_resend_allowed: false,
        stop_after_response: false
      },
      debug: {
        ...transformResult.debug,
        new_patient_patient_found_conflict_flow: true,
        current_state_ready: true,
        matched_existing_patient: true,
        relookup_attempted: isRelookupAttempt,
        relookup_result: isRelookupAttempt ? 'found' : ''
      }
    };
  }

  if (decision === 'cancel') {
    return {
      ok: true,
      tool: 'sender_transform',
      request_id: transformResult.request_id,
      status: 'CANCELLED',
      stage: 'NEW_PATIENT_PATIENT_FOUND_CANCELLED',
      input_hash: transformResult.input_hash,
      transformed_hash: transformResult.transformed_hash,
      transformed_payload: transformedPayload,
      interaction: {
        mode: 'inform',
        ui_kind: 'cancelled',
        user_message: '전송이 취소되었습니다.',
        assistant_question: '',
        required_user_input: null,
        do_not_ask: []
      },
      execution_contract: {
        contract_version: '1.0',
        mode: 'stop',
        must_show_message: true,
        user_visible_message: '전송이 취소되었습니다.',
        must_ask_user: false,
        user_question: '',
        accepted_input_type: null,
        allowed_actions: ['show_stop_message', 'retry_later'],
        forbidden_actions: ['auto_send_without_resolution'],
        auto_resend_allowed: false,
        stop_after_response: true
      },
      debug: {
        ...transformResult.debug,
        new_patient_patient_found_conflict_flow: true,
        conflict_cancelled_by_user: true
      }
    };
  }

  if (decision === 'reenter_patient_id' && !replacementPatientId) {
    return {
      ok: true,
      tool: 'sender_transform',
      request_id: transformResult.request_id,
      status: transformResult.status,
      stage: 'NEW_PATIENT_PATIENT_FOUND_REINPUT_REQUIRED',
      input_hash: transformResult.input_hash,
      transformed_hash: transformResult.transformed_hash,
      transformed_payload: transformedPayload,
      interaction: {
        mode: 'ask_user',
        ui_kind: 'input',
        user_message: '신규 환자로 입력했지만 현재 patient_id로 기존 환자가 검색되었습니다.',
        assistant_question: '수정된 6자리 patient_id만 다시 입력해 주세요.',
        required_user_input: {
          type: 'patient_id',
          field: 'patients.patient_id',
          format: '6_digit_string',
          arg_patch: {
            patients: {
              patient_id: '__USER_INPUT__'
            }
          }
        },
        next_step: {
          next_step_type: 'sender_transform',
          send_ready: false,
          requires_user_input: true,
          must_open_preview_immediately: true,
          must_not_call_sender_send_after_reinput: true,
          input_field_path: 'patients.patient_id',
          regenerate_fields_after_input: [
            'visits.visit_id',
            'findings_records[].visit_id',
            'findings_records[].record_name'
          ],
          arg_patch_template: {
            patients: {
              patient_id: '__USER_INPUT__'
            }
          }
        },
        do_not_ask: [
          'visits.date',
          'visits.chief_complaint',
          'findings_reentry',
          'full_json',
          'full_briefing'
        ]
      },
      execution_contract: {
        contract_version: '1.0',
        mode: 'await_user_input',
        must_show_message: true,
        user_visible_message: '신규 환자로 입력했지만 현재 patient_id로 기존 환자가 검색되었습니다.',
        must_ask_user: true,
        user_question: '수정된 6자리 patient_id만 다시 입력해 주세요.',
        accepted_input_type: 'patient_id',
        accepted_format: '6_digit_string',
        required_input_field_path: 'patients.patient_id',
        arg_patch_template: {
          patients: {
            patient_id: '__USER_INPUT__'
          }
        },
        next_step_type: 'sender_transform',
        must_open_preview_immediately: true,
        must_not_call_sender_send_after_reinput: true,
        regenerate_fields_after_input: [
          'visits.visit_id',
          'findings_records[].visit_id',
          'findings_records[].record_name'
        ],
        allowed_actions: [
          'ask_only_patient_id',
          'patch_previous_payload',
          'open_preview_after_user_answer'
        ],
        forbidden_actions: [
          'auto_send_without_resolution'
        ],
        auto_resend_allowed: false,
        stop_after_response: false
      },
      debug: {
        ...transformResult.debug,
        new_patient_patient_found_conflict_flow: true,
        patient_id_reinput_requested: true
      }
    };
  }

  if (decision === 'switch_existing_new_visit') {
    const patchedInputPayload =
      convertNewPatientConflictToExistingPatientNewVisitPayload(payload);

    const patchedTransformResult = transformCanonicalPayload(patchedInputPayload);
    const downstream = await buildExistingPatientNewVisitTransformEnvelope(
      patchedInputPayload,
      patchedTransformResult,
      rawDecision
    );

    return {
      ...downstream,
      debug: {
        ...(downstream.debug || {}),
        new_patient_patient_found_conflict_flow: true,
        resolved_to_existing_patient_new_visit: true
      }
    };
  }

  return null;
}


async function buildExistingPatientNewVisitTransformEnvelope(payload, transformResult, rawDecision) {
  const transformedPayload = deepClone(transformResult.transformed_payload);
  const patientResp = await fetchPatient(safeString(transformedPayload?.patients?.patient_id));
  const patientExists = patientResp && patientResp.ok ? getPatientExistsFromBody(patientResp.body) : null;
  const currentStateReady = !!(patientResp && patientResp.ok && patientExists === true);
  const headerDiffs = currentStateReady
    ? detectExistingPatientHeaderDiff({ patientBody: patientResp.body }, transformedPayload)
    : [];
  const headerDecision = parseExistingPatientNewVisitHeaderDecision(rawDecision);

  if (headerDiffs.length > 0 && !headerDecision) {
    return {
      ok: true,
      tool: 'sender_transform',
      request_id: transformResult.request_id,
      status: transformResult.status,
      stage: 'EXISTING_PATIENT_NEW_VISIT_STAGE1_PREVIEW',
      input_hash: transformResult.input_hash,
      transformed_hash: transformResult.transformed_hash,
      transformed_payload: transformedPayload,
      preview_summary: buildPreviewSummary(transformedPayload),
      existing_patient_new_visit: {
        applicable: true,
        stage: 1,
        current_state_ready: currentStateReady,
        patient_header_diff_preview: {
          patient_id: transformedPayload?.patients?.patient_id || '',
          destination_table_name: 'Patients',
          items: headerDiffs
        },
        next_step: {
          next_step_type: 'sender_transform',
          send_ready: false,
          requires_choice_args: true,
          choice_field_path: 'phase1_decision.existing_patient_new_visit_header_decision',
          arg_patch_per_choice: {
            '1': { phase1_decision: { existing_patient_new_visit_header_decision: 1 } },
            '2': { phase1_decision: { existing_patient_new_visit_header_decision: 2 } }
          }
        }
      },
      interaction: {
        mode: 'ask_user',
        ui_kind: 'preview_confirmation',
        user_message: '기존 환자 신규 방문 preview 1단계입니다. patient header 차이가 확인되었습니다.',
        assistant_question: '숫자만 입력해 주세요.\n1. patient header 수정도 적용\n2. patient header는 수정하지 않음',
        required_user_input: {
          type: 'single_number_choice',
          field: 'existing_patient_new_visit_header_decision',
          choices: [
            { number: 1, label: 'patient header 수정도 적용', value: 'apply', arg_patch: { phase1_decision: { existing_patient_new_visit_header_decision: 1 } } },
            { number: 2, label: 'patient header는 수정하지 않음', value: 'ignore', arg_patch: { phase1_decision: { existing_patient_new_visit_header_decision: 2 } } }
          ]
        },
        do_not_ask: []
      },
      execution_contract: {
        contract_version: '1.0',
        mode: 'await_user_choice',
        must_show_message: true,
        user_visible_message: '기존 환자 신규 방문 preview 1단계입니다. patient header 차이가 확인되었습니다.',
        must_ask_user: true,
        user_question: '1. patient header 수정도 적용\n2. patient header는 수정하지 않음',
        accepted_input_type: 'single_number_choice',
        allowed_numbers: [1, 2],
        number_meanings: { '1': 'apply', '2': 'ignore' },
        allowed_actions: ['show_preview', 'ask_single_number_choice', 'build_full_preview_after_user_choice'],
        forbidden_actions: ['auto_send_without_confirmation'],
        auto_resend_allowed: false,
        stop_after_response: false
      },
      debug: {
        ...transformResult.debug,
        existing_patient_new_visit_header_flow: true,
        current_state_ready: currentStateReady
      }
    };
  }

  const appliedHeaderFields = headerDecision === 'apply'
    ? headerDiffs.map((item) => `${item.section}.${item.field}`)
    : [];

  transformedPayload.sender_execution = {
    route: 'existing_patient_new_visit',
    patient_header_update_decision: headerDecision || 'not_needed',
    patient_header_update_flags: {
      birth_year: appliedHeaderFields.includes('patients.birth_year'),
      gender: appliedHeaderFields.includes('patients.gender')
    },
    preview_decision_trace: {
      two_stage_preview_used: headerDiffs.length > 0,
      stage1_header_decision: headerDecision || 'not_needed'
    }
  };

  const preview_summary = buildPreviewSummary(transformedPayload);
  preview_summary.existing_patient_new_visit = {
    patient_header_update_decision: headerDecision || 'not_needed',
    destination_table_name: 'Patients',
    header_changes: headerDiffs.map((item) => ({
      field: item.field,
      before: item.before,
      incoming: item.incoming,
      applied: headerDecision === 'apply'
    }))
  };

  return {
    ok: true,
    tool: 'sender_transform',
    request_id: transformResult.request_id,
    status: transformResult.status,
    stage: headerDiffs.length > 0 ? 'EXISTING_PATIENT_NEW_VISIT_STAGE2_PREVIEW' : transformResult.stage,
    input_hash: transformResult.input_hash,
    transformed_hash: sha256(JSON.stringify(transformedPayload)),
    transformed_payload: transformedPayload,
    preview_summary,
    existing_patient_new_visit: {
      applicable: true,
      stage: headerDiffs.length > 0 ? 2 : 0,
      current_state_ready: currentStateReady,
      patient_header_update_decision: headerDecision || 'not_needed',
      patient_header_diff_preview: { items: headerDiffs },
      next_step: {
        next_step_type: 'sender_send',
        send_ready: false,
        requires_confirmation_args: true,
        confirmation_field_path: 'phase1_decision.new_visit_full_preview_confirmation',
        arg_patch_per_choice: {
          '1': { phase1_decision: { existing_patient_new_visit_header_decision: headerDecision === 'apply' ? 1 : 2, new_visit_full_preview_confirmation: 1 } },
          '2': { phase1_decision: { existing_patient_new_visit_header_decision: headerDecision === 'apply' ? 1 : 2, new_visit_full_preview_confirmation: 2 } }
        }
      }
    },
    interaction: {
      mode: 'ask_user',
      ui_kind: 'preview_confirmation',
      user_message: '최종 new visit preview입니다. 아래 내용을 확인한 뒤 숫자로 선택해 주세요.',
      assistant_question: '숫자만 입력해 주세요.\n1. 이대로 전송\n2. 취소',
      required_user_input: {
        type: 'single_number_choice',
        field: 'new_visit_full_preview_confirmation',
        choices: [
          { number: 1, label: '이대로 전송', value: 'send_now', arg_patch: { phase1_decision: { new_visit_full_preview_confirmation: 1 } } },
          { number: 2, label: '취소', value: 'cancel', arg_patch: { phase1_decision: { new_visit_full_preview_confirmation: 2 } } }
        ]
      },
      do_not_ask: []
    },
    execution_contract: {
      contract_version: '1.0',
      mode: 'await_user_choice',
      must_show_message: true,
      user_visible_message: '최종 new visit preview입니다. 아래 내용을 확인한 뒤 숫자로 선택해 주세요.',
      must_ask_user: true,
      user_question: '1. 이대로 전송\n2. 취소',
      accepted_input_type: 'single_number_choice',
      allowed_numbers: [1, 2],
      number_meanings: { '1': 'send_now', '2': 'cancel' },
      allowed_actions: ['show_preview', 'ask_single_number_choice', 'send_after_user_confirms'],
      forbidden_actions: ['auto_send_without_confirmation'],
      auto_resend_allowed: false,
      stop_after_response: false
    },
    debug: {
      ...transformResult.debug,
      existing_patient_new_visit_header_flow: true,
      current_state_ready: currentStateReady,
      patient_header_diff_count: headerDiffs.length
    }
  };
}



async function runTransformTool(args) {
  requireObject(args, 'args');
  requireObject(args.payload, 'args.payload');

  const transformInputPayload = args.payload;
  const result = transformCanonicalPayload(transformInputPayload);

  const registryRules = buildPhase2RegistryRules();
  const validationResult = validateSelectableFieldsAgainstRegistry(result.transformed_payload, registryRules);

  if (!validationResult.valid) {
    return {
      ok: false,
      tool: 'sender_transform',
      request_id: result.request_id,
      status: 'ERROR',
      stage: 'PHASE2_SELECTABLE_VALIDATION_FAILED',
      input_hash: result.input_hash,
      transformed_hash: result.transformed_hash,
      transformed_payload: result.transformed_payload,
      error: {
        code: validationResult.reason_code || 'SELECTABLE_FIELD_VALIDATION_ERROR',
        message: validationResult.error || 'Selectable field validation failed',
        details: {
          reason_code: validationResult.reason_code || 'SELECTABLE_FIELD_VALIDATION_ERROR',
          section: validationResult.section || '',
          branch_code: validationResult.branch_code || '',
          field: validationResult.field || '',
          expected_type: validationResult.expected_type || '',
          received_type: validationResult.received_type || '',
          invalid_value: validationResult.invalid_value,
          offending_values: Array.isArray(validationResult.offending_values)
            ? validationResult.offending_values
            : []
        }
      },
      debug: {
        ...result.debug,
        phase2_validation_applied: true,
        validation_error: validationResult.error,
        validation_details: {
          reason_code: validationResult.reason_code || 'SELECTABLE_FIELD_VALIDATION_ERROR',
          section: validationResult.section || '',
          branch_code: validationResult.branch_code || '',
          field: validationResult.field || '',
          expected_type: validationResult.expected_type || '',
          received_type: validationResult.received_type || '',
          invalid_value: validationResult.invalid_value,
          offending_values: Array.isArray(validationResult.offending_values)
            ? validationResult.offending_values
            : []
        }
      }
    };
  }

  const replacementPatientId = extractNewPatientPatientFoundReplacementPatientId(args.phase1_decision);
  const downstreamPhaseDecision = replacementPatientId
    ? clearNewPatientPatientFoundReentryState(args.phase1_decision)
    : args.phase1_decision;
  const transformInputPayloadWithReplacement =
    isNewPatientNewVisitPayload(transformInputPayload) && replacementPatientId
      ? applyNewPatientPatientFoundReplacementPatientId(transformInputPayload, replacementPatientId)
      : transformInputPayload;

  if (isPhase1ApplicableExistingVisitUpdate(transformInputPayload)) {
    return buildPhase1TransformEnvelope(transformInputPayload, result, args.phase1_decision);
  }

  const newPatientConflictEnvelope =
    await buildNewPatientPatientFoundTransformEnvelope(
      transformInputPayloadWithReplacement,
      result,
      args.phase1_decision
    );

  if (newPatientConflictEnvelope) {
    return newPatientConflictEnvelope;
  }

  if (hasExistingPatientNewVisitPatientHeaderTouch(transformInputPayload)) {
    return buildExistingPatientNewVisitTransformEnvelope(
      transformInputPayload,
      result,
      downstreamPhaseDecision
    );
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

  let effectiveInputPayload = args.payload;
  const replacementPatientId = extractNewPatientPatientFoundReplacementPatientId(args.phase1_decision);
  const downstreamPhaseDecision = replacementPatientId
    ? clearNewPatientPatientFoundReentryState(args.phase1_decision)
    : args.phase1_decision;
  if (isNewPatientNewVisitPayload(effectiveInputPayload) && replacementPatientId) {
    effectiveInputPayload = applyNewPatientPatientFoundReplacementPatientId(
      effectiveInputPayload,
      replacementPatientId
    );
  }

  let transformResult = transformCanonicalPayload(effectiveInputPayload);

  const registryRules = buildPhase2RegistryRules();
  const validationResult = validateSelectableFieldsAgainstRegistry(transformResult.transformed_payload, registryRules);

  if (!validationResult.valid) {
    return {
      ok: false,
      tool: 'sender_send',
      request_id: transformResult.request_id,
      status: 'ERROR',
      stage: 'PHASE2_SELECTABLE_VALIDATION_FAILED',
      result_type: 'selectable_field_validation_error',
      message: validationResult.error || 'Selectable field validation failed',
      write_allowed: false,
      resend_allowed: false,
      reason_code: validationResult.reason_code || 'SELECTABLE_FIELD_VALIDATION_ERROR',
      make_status: '',
      gate_result: 'selectable_field_validation_error',
      data: { same_date_visit_exists: null, suggested_correction: null },
      input_hash: transformResult.input_hash,
      transformed_hash: transformResult.transformed_hash,
      transformed_payload: transformResult.transformed_payload,
      make_response_raw: '',
      make_response_parsed: null,
      transport: {},
      error: {
        code: validationResult.reason_code || 'SELECTABLE_FIELD_VALIDATION_ERROR',
        message: validationResult.error || 'Selectable field validation failed',
        details: {
          reason_code: validationResult.reason_code || 'SELECTABLE_FIELD_VALIDATION_ERROR',
          section: validationResult.section || '',
          branch_code: validationResult.branch_code || '',
          field: validationResult.field || '',
          expected_type: validationResult.expected_type || '',
          received_type: validationResult.received_type || '',
          invalid_value: validationResult.invalid_value,
          offending_values: Array.isArray(validationResult.offending_values)
            ? validationResult.offending_values
            : []
        }
      },
      interaction: {
        mode: 'inform',
        ui_kind: 'error',
        user_message: validationResult.error || 'Selectable field validation failed',
        assistant_question: '',
        required_user_input: null,
        do_not_ask: []
      },
      resend_plan: null,
      execution_contract: {
        contract_version: '1.0',
        mode: 'stop',
        must_show_message: true,
        user_visible_message: validationResult.error || 'Selectable field validation failed',
        must_ask_user: false,
        user_question: '',
        accepted_input_type: null,
        allowed_actions: ['show_error_message'],
        forbidden_actions: ['auto_send_without_validation'],
        auto_resend_allowed: false,
        stop_after_response: true
      },
      debug: {
        ...transformResult.debug,
        phase2_validation_applied: true,
        validation_error: validationResult.error,
        validation_details: {
          reason_code: validationResult.reason_code || 'SELECTABLE_FIELD_VALIDATION_ERROR',
          section: validationResult.section || '',
          branch_code: validationResult.branch_code || '',
          field: validationResult.field || '',
          expected_type: validationResult.expected_type || '',
          received_type: validationResult.received_type || '',
          invalid_value: validationResult.invalid_value,
          offending_values: Array.isArray(validationResult.offending_values)
            ? validationResult.offending_values
            : []
        }
      }
    };
  }

  let outboundPayload = transformResult.transformed_payload;

  if (isNewPatientNewVisitPayload(effectiveInputPayload)) {
    const conflictDecision = parseNewPatientPatientFoundDecision(args.phase1_decision);
    const conflictEnvelope = await buildNewPatientPatientFoundTransformEnvelope(
      effectiveInputPayload,
      transformResult,
      downstreamPhaseDecision
    );

    if (
      conflictEnvelope?.stage ===
      'NEW_PATIENT_PATIENT_FOUND_CURRENT_STATE_REQUIRED_UNAVAILABLE'
    ) {
      return {
        ok: false,
        tool: 'sender_send',
        request_id: transformResult.request_id,
        status: 'ERROR',
        stage: 'NEW_PATIENT_PATIENT_FOUND_CURRENT_STATE_REQUIRED_UNAVAILABLE',
        result_type: 'current_state_required_unavailable',
        message:
          '현재 다시 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.',
        write_allowed: false,
        resend_allowed: false,
        reason_code: 'CURRENT_STATE_REQUIRED_UNAVAILABLE',
        make_status: '',
        gate_result: 'current_state_required_unavailable',
        data: { same_date_visit_exists: null, suggested_correction: null },
        input_hash: transformResult.input_hash,
        transformed_hash:
          conflictEnvelope.transformed_hash || transformResult.transformed_hash,
        transformed_payload:
          conflictEnvelope.transformed_payload || transformResult.transformed_payload,
        make_response_raw: '',
        make_response_parsed: null,
        transport: {},
        interaction: {
          mode: 'inform',
          ui_kind: 'info',
          user_message:
            '현재 다시 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.',
          assistant_question: '',
          required_user_input: null,
          do_not_ask: []
        },
        resend_plan: null,
        execution_contract: {
          contract_version: '1.0',
          mode: 'stop',
          must_show_message: true,
          user_visible_message:
            '현재 다시 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.',
          must_ask_user: false,
          user_question: '',
          accepted_input_type: null,
          allowed_actions: ['show_stop_message', 'retry_later'],
          forbidden_actions: ['auto_send_without_current_state_check'],
          auto_resend_allowed: false,
          stop_after_response: true
        },
        debug: {
          ...(conflictEnvelope.debug || {}),
          send_blocked_until_conflict_resolution: true
        }
      };
    }

    if (
      conflictEnvelope?.stage === 'NEW_PATIENT_PATIENT_FOUND_STAGE1_PREVIEW' ||
      conflictEnvelope?.stage === 'NEW_PATIENT_PATIENT_FOUND_RELOOKUP_FOUND_STAGE1_PREVIEW'
    ) {
      return {
        ok: false,
        tool: 'sender_send',
        request_id: transformResult.request_id,
        status: 'ERROR',
        stage: 'NEW_PATIENT_PATIENT_FOUND_STAGE1_CHOICE_REQUIRED',
        result_type: 'new_patient_patient_found_stage1_choice_required',
        message: '충돌 확인 단계 선택을 먼저 완료해 주세요.',
        write_allowed: false,
        resend_allowed: false,
        reason_code: 'NEW_PATIENT_PATIENT_FOUND_STAGE1_CHOICE_REQUIRED',
        make_status: '',
        gate_result: 'new_patient_patient_found_stage1_choice_required',
        data: { same_date_visit_exists: null, suggested_correction: null },
        input_hash: transformResult.input_hash,
        transformed_hash: conflictEnvelope.transformed_hash || transformResult.transformed_hash,
        transformed_payload: conflictEnvelope.transformed_payload || transformResult.transformed_payload,
        make_response_raw: '',
        make_response_parsed: null,
        transport: {},
        interaction: {
          mode: 'inform',
          ui_kind: 'info',
          user_message: '충돌 확인 단계 선택을 먼저 완료해 주세요.',
          assistant_question: '',
          required_user_input: null,
          do_not_ask: []
        },
        resend_plan: null,
        execution_contract: {
          contract_version: '1.0',
          mode: 'stop',
          must_show_message: true,
          user_visible_message: '충돌 확인 단계 선택을 먼저 완료해 주세요.',
          must_ask_user: false,
          user_question: '',
          accepted_input_type: null,
          allowed_actions: ['show_stop_message'],
          forbidden_actions: ['auto_send_without_resolution'],
          auto_resend_allowed: false,
          stop_after_response: true
        },
        debug: {
          ...(conflictEnvelope.debug || {}),
          send_blocked_until_conflict_choice: true
        }
      };
    }

    if (conflictEnvelope?.stage === 'NEW_PATIENT_PATIENT_FOUND_REINPUT_REQUIRED') {
      return {
        ok: true,
        tool: 'sender_send',
        request_id: transformResult.request_id,
        status: 'SUCCESS',
        stage: 'NEW_PATIENT_PATIENT_FOUND_REINPUT_REQUIRED',
        result_type: 'new_patient_patient_found_reinput_required',
        message: '먼저 수정된 6자리 patient_id를 다시 입력해 주세요.',
        write_allowed: false,
        resend_allowed: true,
        reason_code: 'NEW_PATIENT_PATIENT_FOUND_REINPUT_REQUIRED',
        make_status: '',
        gate_result: 'new_patient_patient_found_reinput_required',
        data: {
          same_date_visit_exists: null,
          suggested_correction: {
            type: 'reenter_patient_id',
            options: ['reenter_patient_id']
          }
        },
        input_hash: transformResult.input_hash,
        transformed_hash:
          conflictEnvelope.transformed_hash || transformResult.transformed_hash,
        transformed_payload:
          conflictEnvelope.transformed_payload || transformResult.transformed_payload,
        make_response_raw: '',
        make_response_parsed: null,
        transport: {},
        interaction: conflictEnvelope.interaction || {
          mode: 'ask_user',
          ui_kind: 'input',
          user_message:
            '신규 환자로 입력했지만 현재 patient_id로 기존 환자가 검색되었습니다.',
          assistant_question: '수정된 6자리 patient_id만 다시 입력해 주세요.',
          required_user_input: {
            type: 'patient_id',
            field: 'patients.patient_id',
            format: '6_digit_string',
            arg_patch: {
              patients: {
                patient_id: '__USER_INPUT__'
              }
            }
          },
          do_not_ask: [
            'visits.date',
            'visits.chief_complaint',
            'findings_reentry',
            'full_json',
            'full_briefing'
          ]
        },
        resend_plan: {
          preserve_clinical_payload: true,
          replace_fields: ['patients.patient_id'],
          set_fields: {},
          regenerate_fields: [
            'visits.visit_id',
            'findings_records[].visit_id',
            'findings_records[].record_name'
          ],
          required_user_patch_fields: ['patients.patient_id'],
          arg_patch_template: {
            patients: {
              patient_id: '__USER_INPUT__'
            }
          },
          next_call_example: {
            use_same_payload: true,
            tool: 'sender_transform',
            patch: {
              patients: {
                patient_id: '__NEW_6_DIGIT_PATIENT_ID__'
              }
            }
          },
          next_step_type: 'sender_transform',
          must_open_preview_immediately: true,
          must_not_call_sender_send_after_reinput: true
        },
        required_reinput_field: 'patients.patient_id',
        arg_patch: {
          patients: {
            patient_id: '__USER_INPUT__'
          }
        },
        next_call_example: {
          use_same_payload: true,
          tool: 'sender_transform',
          patch: {
            patients: {
              patient_id: '__NEW_6_DIGIT_PATIENT_ID__'
            }
          }
        },
        execution_contract: {
          contract_version: '1.0',
          mode: 'await_user_input',
          must_show_message: true,
          user_visible_message:
            '수정된 6자리 patient_id를 다시 입력해 주세요.',
          must_ask_user: true,
          user_question: '수정된 6자리 patient_id만 다시 입력해 주세요.',
          accepted_input_type: 'patient_id',
          accepted_format: '6_digit_string',
          required_input_field_path: 'patients.patient_id',
          arg_patch_template: {
            patients: {
              patient_id: '__USER_INPUT__'
            }
          },
          next_step_type: 'sender_transform',
          must_open_preview_immediately: true,
          must_not_call_sender_send_after_reinput: true,
          regenerate_fields_after_input: [
            'visits.visit_id',
            'findings_records[].visit_id',
            'findings_records[].record_name'
          ],
          allowed_actions: [
            'ask_only_patient_id',
            'patch_previous_payload',
            'open_preview_after_user_answer'
          ],
          forbidden_actions: ['auto_send_without_resolution'],
          auto_resend_allowed: false,
          stop_after_response: false
        },
        debug: {
          ...(conflictEnvelope.debug || {}),
          send_blocked_until_patient_id_reinput: true
        }
      };
    }


    if (conflictEnvelope?.stage === 'NEW_PATIENT_PATIENT_FOUND_RELOOKUP_NOT_FOUND_RESOLVED') {
      return {
        ok: false,
        tool: 'sender_send',
        request_id: transformResult.request_id,
        status: 'ERROR',
        stage: 'NEW_PATIENT_PATIENT_FOUND_RELOOKUP_NOT_FOUND_PREVIEW_REQUIRED',
        result_type: 'new_patient_patient_found_relookup_not_found_preview_required',
        message: '수정된 patient_id 기준 내용을 먼저 확인해 주세요.',
        write_allowed: false,
        resend_allowed: false,
        reason_code: 'NEW_PATIENT_PATIENT_FOUND_RELOOKUP_NOT_FOUND_PREVIEW_REQUIRED',
        make_status: '',
        gate_result: 'new_patient_patient_found_relookup_not_found_preview_required',
        data: { same_date_visit_exists: null, suggested_correction: null },
        input_hash: transformResult.input_hash,
        transformed_hash:
          conflictEnvelope.transformed_hash || transformResult.transformed_hash,
        transformed_payload:
          conflictEnvelope.transformed_payload || transformResult.transformed_payload,
        make_response_raw: '',
        make_response_parsed: null,
        transport: {},
        interaction: {
          mode: 'inform',
          ui_kind: 'info',
          user_message: '수정된 patient_id 기준 내용을 먼저 확인해 주세요.',
          assistant_question: '',
          required_user_input: null,
          do_not_ask: []
        },
        resend_plan: null,
        execution_contract: {
          contract_version: '1.0',
          mode: 'stop',
          must_show_message: true,
          user_visible_message: '수정된 patient_id 기준 내용을 먼저 확인해 주세요.',
          must_ask_user: false,
          user_question: '',
          accepted_input_type: null,
          allowed_actions: ['show_stop_message'],
          forbidden_actions: ['auto_send_without_confirmation'],
          auto_resend_allowed: false,
          stop_after_response: true
        },
        debug: {
          ...(conflictEnvelope.debug || {}),
          send_blocked_until_resolved_preview_is_shown: true,
          stale_reentry_state_cleared: true
        }
      };
    }

    if (conflictEnvelope?.stage === 'NEW_PATIENT_PATIENT_FOUND_CANCELLED') {
      return {
        ok: true,
        tool: 'sender_send',
        request_id: transformResult.request_id,
        status: 'CANCELLED',
        stage: 'NEW_PATIENT_PATIENT_FOUND_CANCELLED',
        result_type: 'cancelled',
        message: '전송이 취소되었습니다.',
        write_allowed: false,
        resend_allowed: false,
        reason_code: '',
        make_status: '',
        gate_result: 'cancelled',
        data: { same_date_visit_exists: null, suggested_correction: null },
        input_hash: transformResult.input_hash,
        transformed_hash: conflictEnvelope.transformed_hash || transformResult.transformed_hash,
        transformed_payload: conflictEnvelope.transformed_payload || transformResult.transformed_payload,
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
          forbidden_actions: ['auto_send_without_resolution'],
          auto_resend_allowed: false,
          stop_after_response: true
        },
        debug: {
          ...(conflictEnvelope.debug || {}),
          send_cancelled_by_user: true
        }
      };
    }

    if (conflictDecision === 'switch_existing_new_visit') {
      effectiveInputPayload =
        convertNewPatientConflictToExistingPatientNewVisitPayload(effectiveInputPayload);

      transformResult = transformCanonicalPayload(effectiveInputPayload);
      outboundPayload = transformResult.transformed_payload;
    }
  }

  if (
    hasExistingPatientNewVisitPatientHeaderTouch(effectiveInputPayload) ||
    isExistingPatientNewVisitPayload(effectiveInputPayload)
  ) {
    const headerDecision = parseExistingPatientNewVisitHeaderDecision(downstreamPhaseDecision);
    const finalConfirmation = parseNewVisitFinalConfirmation(downstreamPhaseDecision);
    const envelope = await buildExistingPatientNewVisitTransformEnvelope(
      effectiveInputPayload,
      transformResult,
      args.phase1_decision
    );

    if (finalConfirmation === 'cancel') {
      return {
        ok: true,
        tool: 'sender_send',
        request_id: transformResult.request_id,
        status: 'CANCELLED',
        stage: 'NEW_VISIT_PREVIEW_CANCELLED',
        result_type: 'cancelled',
        message: '전송이 취소되었습니다.',
        write_allowed: false,
        resend_allowed: false,
        reason_code: '',
        make_status: '',
        gate_result: 'cancelled',
        data: { same_date_visit_exists: null, suggested_correction: null },
        input_hash: transformResult.input_hash,
        transformed_hash: envelope.transformed_hash || transformResult.transformed_hash,
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
          stop_after_response: true
        },
        debug: {
          ...transformResult.debug,
          existing_patient_new_visit_header_flow: true,
          send_cancelled_by_user: true
        }
      };
    }

    if (envelope?.stage === 'EXISTING_PATIENT_NEW_VISIT_STAGE1_PREVIEW') {
      return {
        ok: false,
        tool: 'sender_send',
        request_id: transformResult.request_id,
        status: 'ERROR',
        stage: 'EXISTING_PATIENT_NEW_VISIT_STAGE1_CHOICE_REQUIRED',
        result_type: 'existing_patient_new_visit_stage1_choice_required',
        message: '먼저 patient header 수정 여부를 선택해 주세요.',
        write_allowed: false,
        resend_allowed: false,
        reason_code: 'EXISTING_PATIENT_NEW_VISIT_STAGE1_CHOICE_REQUIRED',
        make_status: '',
        gate_result: 'existing_patient_new_visit_stage1_choice_required',
        data: { same_date_visit_exists: null, suggested_correction: null },
        input_hash: transformResult.input_hash,
        transformed_hash: envelope.transformed_hash || transformResult.transformed_hash,
        transformed_payload: envelope.transformed_payload || transformResult.transformed_payload,
        make_response_raw: '',
        make_response_parsed: null,
        transport: {},
        interaction: {
          mode: 'inform',
          ui_kind: 'info',
          user_message: '먼저 patient header 수정 여부를 선택해 주세요.',
          assistant_question: '',
          required_user_input: null,
          do_not_ask: []
        },
        resend_plan: null,
        execution_contract: {
          contract_version: '1.0',
          mode: 'stop',
          must_show_message: true,
          user_visible_message: '먼저 patient header 수정 여부를 선택해 주세요.',
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
          existing_patient_new_visit_header_flow: true,
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
        stage: 'NEW_VISIT_FINAL_CONFIRMATION_REQUIRED',
        result_type: 'new_visit_final_confirmation_required',
        message: '먼저 최종 확인 선택을 완료해 주세요.',
        write_allowed: false,
        resend_allowed: false,
        reason_code: 'NEW_VISIT_FINAL_CONFIRMATION_REQUIRED',
        make_status: '',
        gate_result: 'new_visit_final_confirmation_required',
        data: { same_date_visit_exists: null, suggested_correction: null },
        input_hash: transformResult.input_hash,
        transformed_hash: envelope.transformed_hash || transformResult.transformed_hash,
        transformed_payload: envelope.transformed_payload || transformResult.transformed_payload,
        make_response_raw: '',
        make_response_parsed: null,
        transport: {},
        arg_patch: {
          phase1_decision: {
            existing_patient_new_visit_header_decision: headerDecision === 'apply' ? 1 : 2,
            new_visit_full_preview_confirmation: 1
          }
        },
        next_call_example: {
          use_same_payload: true,
          phase1_decision: {
            existing_patient_new_visit_header_decision: headerDecision === 'apply' ? 1 : 2,
            new_visit_full_preview_confirmation: 1
          }
        },
        interaction: {
          mode: 'inform',
          ui_kind: 'info',
          user_message: '먼저 최종 확인 선택을 완료해 주세요.',
          assistant_question: '',
          required_user_input: null,
          do_not_ask: []
        },
        resend_plan: null,
        execution_contract: {
          contract_version: '1.0',
          mode: 'stop',
          must_show_message: true,
          user_visible_message: '먼저 최종 확인 선택을 완료해 주세요.',
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
          existing_patient_new_visit_header_flow: true,
          send_blocked_until_final_confirmation: true
        }
      };
    }

    outboundPayload = envelope.transformed_payload || outboundPayload;
  }

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
        message: '먼저 변경 항목 선택을 완료해 주세요.',
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
          user_message: '먼저 변경 항목 선택을 완료해 주세요.',
          assistant_question: '',
          required_user_input: null,
          do_not_ask: []
        },
        resend_plan: null,
        execution_contract: {
          contract_version: '1.0',
          mode: 'stop',
          must_show_message: true,
          user_visible_message: '먼저 변경 항목 선택을 완료해 주세요.',
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

    const isPatientRecheckResumeFlow =
      args?.payload?.workflow?.patient_recheck_attempted === true;

    if (isPatientRecheckResumeFlow && finalConfirmation !== 'send_now') {
      return {
        ...envelope,
        tool: 'sender_send',
        message: '수정된 patient_id 기준 확인 내용입니다. 아래 선택을 완료해 주세요.',
        interaction: {
          ...(envelope.interaction || {}),
          user_message: '수정된 patient_id 기준 확인 내용입니다. 아래 내용을 확인한 뒤 숫자로 선택해 주세요.'
        },
        execution_contract: {
          ...(envelope.execution_contract || {}),
          mode: 'await_user_choice',
          must_show_message: true,
          user_visible_message: '수정된 patient_id 기준 확인 내용입니다. 아래 내용을 확인한 뒤 숫자로 선택해 주세요.',
          must_ask_user: true,
          stop_after_response: false
        },
        debug: {
          ...(envelope.debug || {}),
          phase1_applicable: true,
          recheck_resume_preview_opened_via_sender_send: true
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
        message: '먼저 최종 확인 선택을 완료해 주세요.',
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
        arg_patch: buildPhase1Stage2ChoiceGuide(envelope?.phase1?.stage1_decision).arg_patch_per_choice['1'],
        next_call_example: {
          use_same_payload: true,
          ...buildPhase1Stage2ChoiceGuide(envelope?.phase1?.stage1_decision).arg_patch_per_choice['1']
        },
        next_step: buildPhase1Stage2ChoiceGuide(envelope?.phase1?.stage1_decision),
        interaction: {
          mode: 'inform',
          ui_kind: 'info',
          user_message: '먼저 최종 확인 선택을 완료해 주세요.',
          assistant_question: '',
          required_user_input: null,
          do_not_ask: []
        },
        resend_plan: null,
        execution_contract: {
          contract_version: '1.0',
          mode: 'stop',
          must_show_message: true,
          user_visible_message: '먼저 최종 확인 선택을 완료해 주세요.',
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

    if (isPhase1Stage2NoOp(envelope?.phase1?.stage2_preview)) {
      return {
        ok: true,
        tool: 'sender_send',
        request_id: transformResult.request_id,
        status: 'SUCCESS',
        stage: 'COMPLETED',
        result_type: 'no_op',
        message: '변경 사항이 없어 전송하지 않았습니다.',
        write_allowed: false,
        resend_allowed: false,
        reason_code: 'NO_OP_PREVIEW',
        make_status: '',
        gate_result: 'no_op',
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
          user_message: '변경 사항이 없어 전송하지 않았습니다.',
          assistant_question: '',
          required_user_input: null,
          do_not_ask: []
        },
        resend_plan: null,
        execution_contract: {
          contract_version: '1.0',
          mode: 'complete',
          must_show_message: true,
          user_visible_message: '변경 사항이 없어 전송하지 않았습니다.',
          must_ask_user: false,
          user_question: '',
          accepted_input_type: null,
          allowed_actions: ['finish'],
          forbidden_actions: ['send_no_op_payload'],
          auto_resend_allowed: false,
          stop_after_response: true
        },
        debug: {
          ...(envelope.debug || {}),
          phase1_applicable: true,
          send_skipped_no_op: true,
          no_op_preview: true
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
    version: SENDER_RUNTIME_VERSION,
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
        version: SENDER_RUNTIME_VERSION
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
        version: SENDER_RUNTIME_VERSION,
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
        version: SENDER_RUNTIME_VERSION,
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
