#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || '';

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
      pain_level:
        typeof payload.visits.pain_level === 'number'
          ? payload.visits.pain_level
          : Number(payload.visits.pain_level || 0)
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
    message = 'Webhook accepted. Downstream write confirmation JSON was not returned.';
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
      ui_kind: 'info',
      user_message:
        'Webhook accepted 상태입니다. Downstream write confirmation JSON은 반환되지 않았습니다.',
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
        '같은 날짜에 이미 등록된 방문 기록이 있습니다. 지금 하려는 입력이 새 방문을 새로 등록하는 것인지, 아니면 이미 등록된 그 방문 기록에 내용을 이어서 추가/수정하는 것인지 확인이 필요합니다.',
      assistant_question: '기존 기록에 이어서 수정/추가로 진행할까요?',
      required_user_input: {
        type: 'choice',
        field: 'workflow.doctor_confirmed_correction',
        choices: [
          {
            label: '기존 기록에 이어서 수정/추가',
            value: 'confirm_existing_visit_update'
          },
          {
            label: '새 방문으로 새로 등록 유지',
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
        '같은 날짜에 이미 등록된 방문 기록이 있는데도 새 방문으로 새로 등록을 유지하려고 했기 때문에 자동 진행이 중단되었습니다. 수동 확인이 필요합니다.',
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
      mode: 'inform',
      must_show_message: true,
      user_visible_message:
        'Webhook accepted 상태입니다. Downstream write confirmation JSON은 반환되지 않았습니다.',
      must_ask_user: false,
      user_question: '',
      accepted_input_type: null,
      allowed_actions: ['show_message', 'optional_postcheck'],
      forbidden_actions: [],
      auto_resend_allowed: false,
      stop_after_response: false
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
        '같은 날짜에 이미 등록된 방문 기록이 있습니다. 지금 하려는 입력이 새 방문을 새로 등록하는 것인지, 아니면 이미 등록된 그 방문 기록에 내용을 이어서 추가/수정하는 것인지 확인이 필요합니다.',
      must_ask_user: true,
      user_question: '기존 기록에 이어서 수정/추가로 진행할까요?',
      accepted_input_type: 'choice',
      accepted_choices: [
        {
          label: '기존 기록에 이어서 수정/추가',
          value: 'confirm_existing_visit_update'
        },
        {
          label: '새 방문으로 새로 등록 유지',
          value: 'keep_new_visit_claim'
        }
      ],
      allowed_actions: [
        'ask_single_confirmation_question',
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
  return {
    ok: result.status === 'SUCCESS',
    tool: 'sender_transform',
    request_id: result.request_id,
    status: result.status,
    stage: result.stage,
    input_hash: result.input_hash,
    transformed_hash: result.transformed_hash,
    transformed_payload: result.transformed_payload,
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
  const transport = await httpRequest(
    MAKE_WEBHOOK_URL,
    'POST',
    transformResult.transformed_payload,
    45000
  );

  return buildSendEnvelope(transformResult, transport);
}

function runHealthTool() {
  return {
    ok: true,
    service: 'mcp-sender-v1-render-single',
    version: '1.0.0',
    enable_network_send: !!MAKE_WEBHOOK_URL,
    webhook_url: MAKE_WEBHOOK_URL || ''
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
        'Transform canonical dental case JSON into findings_records-parity payload for preview and validation. No downstream write.',
      inputSchema: {
        type: 'object',
        properties: {
          payload: {
            type: 'object',
            description: 'Canonical sender input payload'
          }
        },
        required: ['payload'],
        additionalProperties: false
      }
    },
    {
      name: 'sender_send',
      description:
        'Transform canonical dental case JSON, send it to Make webhook, and return normalized result including interaction, resend_plan, and execution_contract.',
      inputSchema: {
        type: 'object',
        properties: {
          payload: {
            type: 'object',
            description: 'Canonical sender input payload'
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
