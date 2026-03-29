#!/usr/bin/env node
'use strict';

/**
 * MCP Sender v0
 *
 * findings_records parity patch + Make response surfacing + sender result_type
 *
 * Goal:
 * - Keep current Make scenario unchanged
 * - Keep Cloudflare Worker unchanged
 * - Accept findings_records-based canonical sender input
 * - Match current sender.html outbound preview behavior
 * - Surface Make webhook response fields directly in MCP /send output
 * - Add sender-side normalized result_type for UI/client branching
 *
 * Endpoints:
 * - GET /health
 * - POST /transform
 * - POST /send
 *
 * No external dependencies.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || process.env.MCP_SENDER_PORT || 8787);
const WEBHOOK_URL =
  process.env.MCP_SENDER_WEBHOOK_URL ||
  'https://hook.eu1.make.com/38cx9ls57f7k3akd6us4hwchrtwfl050';
const AUDIT_DIR =
  process.env.MCP_SENDER_AUDIT_DIR ||
  path.join(process.cwd(), 'mcp_sender_audit');
const ENABLE_NETWORK_SEND =
  (process.env.MCP_SENDER_ENABLE_NETWORK_SEND || 'false').toLowerCase() === 'true';

fs.mkdirSync(AUDIT_DIR, { recursive: true });

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function notBlank(v) {
  return v !== '' && v !== null && v !== undefined;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
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

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = JSON.stringify(body);

    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const transport = url.protocol === 'https:' ? https : http;

    const request = transport.request(options, (response) => {
      let responseData = '';

      response.on('data', (chunk) => {
        responseData += chunk;
      });

      response.on('end', () => {
        resolve({
          statusCode: response.statusCode || 0,
          headers: response.headers,
          bodyText: responseData
        });
      });
    });

    request.on('error', reject);
    request.write(data);
    request.end();
  });
}

function writeAudit(record) {
  const filename = `${record.timestamp.replace(/[:.]/g, '-')}_${record.request_id}.json`;
  fs.writeFileSync(path.join(AUDIT_DIR, filename), JSON.stringify(record, null, 2));
}

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body, null, 2);

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data)
  });

  res.end(data);
}

function normalizeEnvelope(requestBody) {
  if (isPlainObject(requestBody.payload)) {
    return {
      request_id: requestBody.request_id || crypto.randomUUID(),
      timestamp: requestBody.timestamp || nowIso(),
      source: requestBody.source || 'CPL_AI',
      payload: requestBody.payload,
      mode: requestBody.mode || 'transform'
    };
  }

  return {
    request_id: requestBody.request_id || crypto.randomUUID(),
    timestamp: requestBody.timestamp || nowIso(),
    source: requestBody.source || 'CPL_AI',
    payload: requestBody,
    mode: requestBody.mode || 'transform'
  };
}

function ensureFindingsRecordsShape(payload) {
  if (!isPlainObject(payload.workflow)) {
    throw new Error("payload.workflow missing or invalid");
  }

  if (!isPlainObject(payload.patients)) {
    throw new Error("payload.patients missing or invalid");
  }

  if (!isPlainObject(payload.visits)) {
    throw new Error("payload.visits missing or invalid");
  }

  if (!isPlainObject(payload.findings_present)) {
    throw new Error("payload.findings_present missing or invalid");
  }

  if (!Array.isArray(payload.findings_records)) {
    throw new Error("payload.findings_records missing or invalid");
  }

  if (payload.findings_records.length === 0) {
    throw new Error("findings_records must not be empty");
  }
}

function normalizeFindingsRecordsPayload(payload) {
  ensureFindingsRecordsShape(payload);

  return {
    workflow: {
      mode: '',
      patient_status_claim: payload.workflow.patient_status_claim || '',
      visit_intent_claim: payload.workflow.visit_intent_claim || '',
      target_visit_date: payload.workflow.target_visit_date || '',
      target_visit_id: payload.workflow.target_visit_id || '',
      target_visit_clue: payload.workflow.target_visit_clue || '',
      uncertainty_note: payload.workflow.uncertainty_note || '',
      patient_recheck_attempted: payload.workflow.patient_recheck_attempted ?? '',
      doctor_confirmed_correction: payload.workflow.doctor_confirmed_correction ?? ''
    },

    patients: {
      patient_id: payload.patients.patient_id || '',
      birth_year: payload.patients.birth_year ?? '',
      gender: payload.patients.gender || ''
    },

    visits: {
      visit_id: payload.visits.visit_id || '',
      date: payload.visits.date || '',
      visit_type: payload.visits.visit_type || '',
      chief_complaint: payload.visits.chief_complaint || '',
      pain_level: Number(payload.visits.pain_level || 0)
    },

    findings_present: payload.findings_present,
    findings_records: payload.findings_records,

    record_name_rule:
      payload.record_name_rule && String(payload.record_name_rule).trim() !== ''
        ? payload.record_name_rule
        : '{Visit ID}-{Tooth number}-{BRANCH CODE}',

    record_name_generation_source:
      payload.record_name_generation_source &&
      String(payload.record_name_generation_source).trim() !== ''
        ? payload.record_name_generation_source
        : 'sender_deterministic'
  };
}

function tryParseJson(text) {
  if (!notBlank(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildMakeResponseSurface(transportResult) {
  const raw = transportResult && typeof transportResult.bodyText === 'string'
    ? transportResult.bodyText
    : '';

  const parsed = tryParseJson(raw);

  if (!parsed || !isPlainObject(parsed)) {
    return {
      make_response_raw: raw,
      make_response_parsed: null,
      surfaced: {
        status: '',
        gate_result: '',
        correction_needed: null,
        hard_stop: null,
        reason_code: '',
        message: '',
        write_allowed: null,
        resend_allowed: null,
        same_date_visit_exists: null,
        suggested_correction: null
      }
    };
  }

  return {
    make_response_raw: raw,
    make_response_parsed: parsed,
    surfaced: {
      status: parsed.status ?? '',
      gate_result: parsed.gate_result ?? '',
      correction_needed: parsed.correction_needed ?? null,
      hard_stop: parsed.hard_stop ?? null,
      reason_code: parsed.reason_code ?? '',
      message: parsed.message ?? '',
      write_allowed: parsed.write_allowed ?? null,
      resend_allowed: parsed.resend_allowed ?? null,
      same_date_visit_exists: parsed.same_date_visit_exists ?? null,
      suggested_correction: parsed.suggested_correction ?? null
    }
  };
}

function buildSenderResultType(status, stage, makeSurfaced) {
  if (status !== 'SUCCESS' || stage === 'TRANSPORT') {
    return 'technical_error';
  }

  if (makeSurfaced.hard_stop === true || makeSurfaced.gate_result === 'hard_stop') {
    return 'hard_stop';
  }

  if (makeSurfaced.reason_code === 'PATIENT_NOT_FOUND_RECHECK_REQUIRED') {
    return 'recheck_required';
  }

  if (makeSurfaced.gate_result === 'correction_required') {
    return 'correction_required';
  }

  if (makeSurfaced.gate_result === 'normal_pass' && makeSurfaced.write_allowed === true) {
    return 'success';
  }

  return 'technical_error';
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'mcp-sender-v0',
        version: '0.4.0-findings-records-parity-make-response-result-type',
        enable_network_send: ENABLE_NETWORK_SEND,
        webhook_url: WEBHOOK_URL
      });
    }

    if (req.method === 'POST' && req.url === '/transform') {
      const envelope = normalizeEnvelope(await parseJsonBody(req));
      const transformedPayload = normalizeFindingsRecordsPayload(envelope.payload);

      const inputHash = sha256(JSON.stringify(envelope.payload));
      const transformedHash = sha256(JSON.stringify(transformedPayload));

      const responseBody = {
        request_id: envelope.request_id,
        status: 'SUCCESS',
        stage: 'TRANSFORM',
        input_hash: inputHash,
        transformed_hash: transformedHash,
        transformed_payload: transformedPayload,
        debug: {
          validation_passed: true,
          contract_valid: true,
          transformation_applied: true,
          parity_mode: 'findings_records'
        }
      };

      writeAudit({
        request_id: envelope.request_id,
        timestamp: envelope.timestamp,
        source: envelope.source,
        endpoint: req.url,
        input_hash: inputHash,
        transformed_hash: transformedHash,
        payload: envelope.payload,
        transformed_payload: transformedPayload,
        transport: null,
        status: 'SUCCESS',
        stage: 'TRANSFORM'
      });

      return sendJson(res, 200, responseBody);
    }

    if (req.method === 'POST' && req.url === '/send') {
      const envelope = normalizeEnvelope(await parseJsonBody(req));
      const transformedPayload = normalizeFindingsRecordsPayload(envelope.payload);

      const inputHash = sha256(JSON.stringify(envelope.payload));
      const transformedHash = sha256(JSON.stringify(transformedPayload));

      let transportResult = null;
      let status = 'SUCCESS';
      let stage = 'COMPLETED';

      if (!ENABLE_NETWORK_SEND) {
        status = 'FAILED';
        stage = 'TRANSPORT';
        transportResult = {
          statusCode: 0,
          headers: {},
          bodyText:
            'Network send disabled. Set MCP_SENDER_ENABLE_NETWORK_SEND=true to allow live webhook POST.'
        };
      } else {
        transportResult = await postJson(WEBHOOK_URL, transformedPayload);

        if (transportResult.statusCode < 200 || transportResult.statusCode >= 300) {
          status = 'FAILED';
          stage = 'TRANSPORT';
        }
      }

      const makeSurface = buildMakeResponseSurface(transportResult);
      const resultType = buildSenderResultType(status, stage, makeSurface.surfaced);

      const responseBody = {
        request_id: envelope.request_id,
        status,
        stage,
        result_type: resultType,

        input_hash: inputHash,
        transformed_hash: transformedHash,
        transformed_payload: transformedPayload,

        transport: transportResult,

        make_response_raw: makeSurface.make_response_raw,
        make_response_parsed: makeSurface.make_response_parsed,

        message: makeSurface.surfaced.message,
        make_status: makeSurface.surfaced.status,
        gate_result: makeSurface.surfaced.gate_result,
        correction_needed: makeSurface.surfaced.correction_needed,
        hard_stop: makeSurface.surfaced.hard_stop,
        reason_code: makeSurface.surfaced.reason_code,
        write_allowed: makeSurface.surfaced.write_allowed,
        resend_allowed: makeSurface.surfaced.resend_allowed,
        same_date_visit_exists: makeSurface.surfaced.same_date_visit_exists,
        suggested_correction: makeSurface.surfaced.suggested_correction,

        debug: {
          validation_passed: true,
          contract_valid: true,
          transformation_applied: true,
          webhook_sent: ENABLE_NETWORK_SEND && status === 'SUCCESS',
          parity_mode: 'findings_records',
          make_response_parsed: !!makeSurface.make_response_parsed
        }
      };

      writeAudit({
        request_id: envelope.request_id,
        timestamp: envelope.timestamp,
        source: envelope.source,
        endpoint: req.url,
        input_hash: inputHash,
        transformed_hash: transformedHash,
        payload: envelope.payload,
        transformed_payload: transformedPayload,
        transport: transportResult,
        make_response_raw: makeSurface.make_response_raw,
        make_response_parsed: makeSurface.make_response_parsed,
        surfaced_make_fields: makeSurface.surfaced,
        result_type: resultType,
        status,
        stage
      });

      return sendJson(res, 200, responseBody);
    }

    return sendJson(res, 404, {
      error: 'Not found',
      endpoints: ['GET /health', 'POST /transform', 'POST /send']
    });
  } catch (error) {
    return sendJson(res, 400, {
      status: 'REJECTED',
      stage: 'VALIDATION',
      result_type: 'technical_error',
      error: error.message
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MCP Sender v0 listening on http://${HOST}:${PORT}`);
  console.log(`Audit directory: ${AUDIT_DIR}`);
  console.log(`Network send enabled: ${ENABLE_NETWORK_SEND}`);
  console.log(`Parity mode: findings_records`);
  console.log(`Make response surfacing: enabled`);
  console.log(`Sender result_type: enabled`);
});
