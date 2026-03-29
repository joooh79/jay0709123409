#!/usr/bin/env node
'use strict';

/**
 * MCP Sender v1 (HTML parity)
 *
 * Goal:
 * - Replicate AI_Dental_Clinic_JSON_Sender.html behavior in headless server form
 * - Keep Make scenario unchanged
 * - Keep Cloudflare Worker as thin proxy
 *
 * Endpoints:
 * - GET  /health
 * - POST /transform
 * - POST /send
 *
 * Notes:
 * - /transform returns the same fragment-style payload shape used by sender.html preview
 * - /send posts that same transformed payload to the Make webhook
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

const ALLOWED_MODES = new Set([
  'new_patient_new_visit',
  'existing_patient_new_visit',
  'existing_visit_update'
]);

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

function addFieldHtmlParity(obj, key, value) {
  if (Array.isArray(value)) {
    const arr = value.filter(notBlank);
    if (arr.length) obj[key] = arr;
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isNaN(value) && value !== 0) obj[key] = value;
    return;
  }

  if (notBlank(value)) obj[key] = value;
}

function fragHtmlParity(obj) {
  const s = JSON.stringify(obj);
  return s === '{}' ? '' : s.slice(1, -1);
}

function requireTopLevelSectionsHtmlParity(input) {
  const required = [
    'workflow',
    'patients',
    'visits',
    'pre_op',
    'radiographic',
    'operative',
    'diagnosis',
    'treatment_plan',
    'doctor_reasoning'
  ];

  for (const key of required) {
    if (!isPlainObject(input[key])) {
      throw new Error(`canonical JSON structure error: '${key}' section missing or invalid`);
    }
  }
}

function validateWorkflowHtmlParity(workflow) {
  if (!ALLOWED_MODES.has(workflow.mode)) {
    throw new Error('workflow.mode error');
  }
}

/**
 * Branch builders
 * These map canonical JSON fields to the exact fragment labels used by sender.html.
 */

function buildPreOpFields(pre) {
  const out = {};
  addFieldHtmlParity(out, 'Symptom', [
    pre.symptom_1,
    pre.symptom_2,
    pre.symptom_3,
    pre.symptom_4
  ]);
  addFieldHtmlParity(out, 'Symptom reproducible', pre.symptom_reproducible);
  addFieldHtmlParity(out, 'Visible crack', pre.visible_crack);
  addFieldHtmlParity(out, 'Crack detection method', [
    pre.crack_detection_method_1,
    pre.crack_detection_method_2,
    pre.crack_detection_method_3
  ]);
  addFieldHtmlParity(out, 'Pulp - cold test', pre.pulp_cold_test);
  addFieldHtmlParity(out, 'Pulp - EPT', pre.pulp_ept);
  addFieldHtmlParity(out, 'Functional Cusp - involvement', pre.functional_cusp_involvement);
  addFieldHtmlParity(out, 'existing restorations', pre.existing_restorations);
  addFieldHtmlParity(out, 'Existing restoration size', pre.existing_restoration_size);
  addFieldHtmlParity(out, 'Occlusal wear', pre.occlusal_wear);
  addFieldHtmlParity(
    out,
    'Structure estimation - suspected cusp thin?',
    pre.structure_estimate_suspected_cusp_thin
  );
  addFieldHtmlParity(
    out,
    'Margin estimation - suspected subgingival margin',
    pre.suspected_subgingival_margin
  );
  addFieldHtmlParity(out, 'Rubber Dam Feasibility', pre.rubber_dam_feasibility);
  return out;
}

function buildRadiographicFields(rad) {
  const out = {};
  addFieldHtmlParity(out, 'Radiograph type', rad.radiograph_type);
  addFieldHtmlParity(out, 'Radiographic caries depth', rad.radiographic_caries_depth);
  addFieldHtmlParity(out, 'Secondary caries', rad.secondary_caries);
  addFieldHtmlParity(out, 'Caries location', [
    rad.caries_location_1,
    rad.caries_location_2,
    rad.caries_location_3
  ]);
  addFieldHtmlParity(out, 'Pulp chamber size', rad.pulp_chamber_size);
  addFieldHtmlParity(out, 'Periapical lesion', rad.periapical_lesion);
  addFieldHtmlParity(out, 'Radiographic fracture sign', rad.radiographic_fracture_sign);
  addFieldHtmlParity(out, 'Radiograph link', rad.xray_link);
  return out;
}

function buildOperativeFields(op) {
  const out = {};
  addFieldHtmlParity(out, 'Rubber dam isolation', op.rubber_dam_isolation);
  addFieldHtmlParity(out, 'Caries depth (actual)', op.caries_depth_actual);
  addFieldHtmlParity(out, 'Soft dentin remaining', op.soft_dentin_remaining);
  addFieldHtmlParity(out, 'Crack confirmed', op.crack_confirmed);
  addFieldHtmlParity(out, 'Crack location', [
    op.crack_location_1,
    op.crack_location_2,
    op.crack_location_3
  ]);

  const cuspThickness = Number(op.remaining_cusp_thickness_mm);
  if (!Number.isNaN(cuspThickness) && cuspThickness !== 0) {
    out['Remaining cusp thickness (mm)'] = cuspThickness;
  }

  addFieldHtmlParity(out, 'Subgingival margin', op.subgingival_margin);
  addFieldHtmlParity(out, 'Deep marginal elevation', op.deep_margin_elevation);
  addFieldHtmlParity(out, 'IDS/resin coating', op.ids_resin_coating);
  addFieldHtmlParity(out, 'Resin core build up type', op.core_build_up);
  addFieldHtmlParity(out, 'Occlusal loading test', op.occlusal_loading_test);
  addFieldHtmlParity(out, 'Loading test result', op.loading_test_result);
  addFieldHtmlParity(out, 'Intraoral photo link', op.intraoral_photo_link);
  return out;
}

function buildDiagnosisFields(dx) {
  const out = {};
  addFieldHtmlParity(out, 'Structural diagnosis', [
    dx.structural_diagnosis_1,
    dx.structural_diagnosis_2,
    dx.structural_diagnosis_3
  ]);
  addFieldHtmlParity(out, 'Pulp diagnosis', dx.pulp_diagnosis);
  addFieldHtmlParity(out, 'Crack severity', dx.crack_severity);
  addFieldHtmlParity(out, 'Occlusal risk', dx.occlusal_risk);
  addFieldHtmlParity(out, 'Restorability', dx.restorability);
  return out;
}

function buildTreatmentPlanFields(tx) {
  const out = {};
  addFieldHtmlParity(out, 'Pulp therapy', tx.pulp_therapy);
  addFieldHtmlParity(out, 'Restoration design', tx.restoration_design);
  addFieldHtmlParity(out, 'Restoration material', tx.restoration_material);
  addFieldHtmlParity(out, 'Implant placement', tx.implant_placement);
  addFieldHtmlParity(out, 'Scan file link', tx.scan_stl_link);
  return out;
}

function buildDoctorReasoningFields(rs) {
  const out = {};
  addFieldHtmlParity(out, 'Decision factor', [
    rs.decision_factor_1,
    rs.decision_factor_2,
    rs.decision_factor_3,
    rs.decision_factor_4,
    rs.decision_factor_5,
    rs.decision_factor_6
  ]);
  addFieldHtmlParity(
    out,
    'Remaining cusp thickness decision',
    rs.remaining_cusp_thickness_decision
  );
  addFieldHtmlParity(out, 'Functional cusp involvement', rs.functional_cusp_involvement);
  addFieldHtmlParity(out, 'Crack progression risk', rs.crack_progression_risk);
  addFieldHtmlParity(out, 'Occlusal risk', rs.occlusal_risk);
  addFieldHtmlParity(out, 'Reasoning notes', rs.reasoning_notes);
  return out;
}

function buildFragmentPayloadFromCanonicalJson(input) {
  requireTopLevelSectionsHtmlParity(input);
  validateWorkflowHtmlParity(input.workflow);

  const preFields = buildPreOpFields(input.pre_op);
  const radFields = buildRadiographicFields(input.radiographic);
  const opFields = buildOperativeFields(input.operative);
  const dxFields = buildDiagnosisFields(input.diagnosis);
  const txFields = buildTreatmentPlanFields(input.treatment_plan);
  const rsFields = buildDoctorReasoningFields(input.doctor_reasoning);

  const hasAnyFinding =
    Object.keys(preFields).length > 0 ||
    Object.keys(radFields).length > 0 ||
    Object.keys(opFields).length > 0 ||
    Object.keys(dxFields).length > 0 ||
    Object.keys(txFields).length > 0 ||
    Object.keys(rsFields).length > 0;

  if (!hasAnyFinding) {
    throw new Error('send blocked: at least one finding section must contain real data');
  }

  return {
    workflow: input.workflow,
    patients: input.patients,
    visits: input.visits,
    pre_op_fields_json: fragHtmlParity(preFields),
    radiographic_fields_json: fragHtmlParity(radFields),
    operative_fields_json: fragHtmlParity(opFields),
    diagnosis_fields_json: fragHtmlParity(dxFields),
    treatment_plan_fields_json: fragHtmlParity(txFields),
    doctor_reasoning_fields_json: fragHtmlParity(rsFields)
  };
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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'mcp-sender-v1',
        mode: 'html-parity',
        enable_network_send: ENABLE_NETWORK_SEND,
        webhook_url: WEBHOOK_URL
      });
    }

    if (req.method === 'POST' && req.url === '/transform') {
      const envelope = normalizeEnvelope(await parseJsonBody(req));
      const transformedPayload = buildFragmentPayloadFromCanonicalJson(envelope.payload);
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
          transformation_applied: true
        }
      };

      writeAudit({
        request_id: envelope.request_id,
        timestamp: envelope.timestamp,
        source: envelope.source,
        endpoint: req.url,
        mode: 'html-parity',
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
      const transformedPayload = buildFragmentPayloadFromCanonicalJson(envelope.payload);
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

      const responseBody = {
        request_id: envelope.request_id,
        status,
        stage,
        input_hash: inputHash,
        transformed_hash: transformedHash,
        transformed_payload: transformedPayload,
        transport: transportResult,
        debug: {
          validation_passed: true,
          contract_valid: true,
          transformation_applied: true,
          webhook_sent: req.url === '/send' && ENABLE_NETWORK_SEND && status === 'SUCCESS'
        }
      };

      writeAudit({
        request_id: envelope.request_id,
        timestamp: envelope.timestamp,
        source: envelope.source,
        endpoint: req.url,
        mode: 'html-parity',
        input_hash: inputHash,
        transformed_hash: transformedHash,
        payload: envelope.payload,
        transformed_payload: transformedPayload,
        transport: transportResult,
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
      error: error.message
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MCP Sender v1 listening on http://${HOST}:${PORT}`);
  console.log(`Audit directory: ${AUDIT_DIR}`);
  console.log(`Network send enabled: ${ENABLE_NETWORK_SEND}`);
  console.log(`Mode: html-parity`);
});
