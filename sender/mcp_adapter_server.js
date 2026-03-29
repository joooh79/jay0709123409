#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || process.env.MCP_ADAPTER_PORT || 8790);
const SENDER_BASE_URL =
  process.env.SENDER_BASE_URL || 'http://127.0.0.1:8787';

const WARM_MAX_ATTEMPTS = Number(process.env.SENDER_WARM_MAX_ATTEMPTS || 8);
const WARM_RETRY_DELAY_MS = Number(process.env.SENDER_WARM_RETRY_DELAY_MS || 2500);
const WARM_REQUEST_TIMEOUT_MS = Number(process.env.SENDER_WARM_REQUEST_TIMEOUT_MS || 12000);

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpRequest(urlString, method = 'GET', body = null, timeoutMs = WARM_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        Accept: 'application/json'
      }
    };

    if (payload) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const transport = url.protocol === 'https:' ? https : http;

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

function requireObject(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function isGarbledText(value) {
  if (typeof value !== 'string') return false;
  return value.includes('�');
}

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

function extractBestMessage(senderJson) {
  const topLevelMessage = safeString(senderJson.message);

  const parsedMessage =
    senderJson.make_response_parsed &&
    typeof senderJson.make_response_parsed === 'object'
      ? safeString(senderJson.make_response_parsed.message)
      : '';

  if (parsedMessage && !isGarbledText(parsedMessage)) {
    return parsedMessage;
  }

  if (topLevelMessage && !isGarbledText(topLevelMessage)) {
    return topLevelMessage;
  }

  const raw = safeString(senderJson.make_response_raw);

  if (raw) {
    try {
      const reparsed = JSON.parse(raw);
      const rawMessage = safeString(reparsed.message);

      if (rawMessage) {
        return rawMessage;
      }
    } catch {
      // ignore
    }
  }

  return parsedMessage || topLevelMessage || '';
}

function normalizeSenderHealth(senderJson) {
  return {
    ok: !!senderJson.ok,
    service: senderJson.service || 'unknown',
    version: senderJson.version || '',
    enable_network_send: !!senderJson.enable_network_send,
    webhook_url: senderJson.webhook_url || ''
  };
}

function normalizeTransformOutput(senderJson) {
  return {
    ok: senderJson.status === 'SUCCESS',
    tool: 'sender_transform',
    request_id: senderJson.request_id || '',
    status: senderJson.status || '',
    stage: senderJson.stage || '',
    input_hash: senderJson.input_hash || '',
    transformed_hash: senderJson.transformed_hash || '',
    transformed_payload: senderJson.transformed_payload || {},
    debug: senderJson.debug || {}
  };
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
      do_not_ask: [
        'full_json',
        'full_briefing',
        'retry'
      ]
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
      replace_fields: [
        'patients.patient_id'
      ],
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
    debug: senderJson.debug || {}
  };
}

function toolDefinitions() {
  return [
    {
      name: 'sender_health',
      description: 'Check sender service health and basic runtime configuration.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: 'sender_transform',
      description:
        'Transform canonical dental case JSON into sender-parity payload for preview and validation. Does not execute downstream write.',
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
        'Transform canonical dental case JSON into sender-parity payload, send it to the configured Make webhook, and return normalized sender result fields including interaction and resend_plan for consistent operational handling.',
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

function isLikelyRenderLoadingPage(upstream) {
  const contentType = String(upstream.headers?.['content-type'] || '').toLowerCase();
  const bodyText = String(upstream.bodyText || '').toLowerCase();

  if (contentType.includes('text/html')) return true;
  if (bodyText.includes('render') && bodyText.includes('application loading')) return true;
  if (bodyText.includes('service waking up')) return true;
  if (bodyText.includes('allocating compute resources')) return true;

  return false;
}

function isHealthySenderHealthResponse(upstream) {
  return !!(
    upstream &&
    upstream.statusCode >= 200 &&
    upstream.statusCode < 300 &&
    upstream.bodyJson &&
    upstream.bodyJson.ok === true
  );
}

async function ensureSenderReady() {
  let lastError = null;
  let lastUpstream = null;

  for (let attempt = 1; attempt <= WARM_MAX_ATTEMPTS; attempt += 1) {
    try {
      const upstream = await httpRequest(`${SENDER_BASE_URL}/health`, 'GET');
      lastUpstream = upstream;

      if (isHealthySenderHealthResponse(upstream)) {
        return {
          ok: true,
          attempts: attempt,
          upstream
        };
      }

      if (isLikelyRenderLoadingPage(upstream)) {
        lastError = new Error(
          `Sender still warming up (attempt ${attempt}/${WARM_MAX_ATTEMPTS})`
        );
      } else if (!upstream.bodyJson) {
        lastError = new Error(
          `Sender health returned non-JSON response (attempt ${attempt}/${WARM_MAX_ATTEMPTS})`
        );
      } else {
        lastError = new Error(
          `Sender health not ready yet (attempt ${attempt}/${WARM_MAX_ATTEMPTS})`
        );
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < WARM_MAX_ATTEMPTS) {
      await sleep(WARM_RETRY_DELAY_MS);
    }
  }

  const detail =
    lastUpstream && !lastUpstream.bodyJson
      ? {
          statusCode: lastUpstream.statusCode,
          contentType: lastUpstream.headers?.['content-type'] || '',
          bodyPreview: String(lastUpstream.bodyText || '').slice(0, 300)
        }
      : null;

  const error = new Error(
    `Sender warm-check failed after ${WARM_MAX_ATTEMPTS} attempts: ${lastError ? lastError.message : 'unknown error'}`
  );
  error.detail = detail;
  throw error;
}

async function callSenderJson(path, method, body = null) {
  await ensureSenderReady();

  const upstream = await httpRequest(`${SENDER_BASE_URL}${path}`, method, body);

  if (upstream.bodyJson) {
    return upstream;
  }

  const contentType = upstream.headers?.['content-type'] || '';
  const preview = String(upstream.bodyText || '').slice(0, 300);

  throw new Error(
    `Sender endpoint ${path} returned non-JSON response. status=${upstream.statusCode}, contentType=${contentType}, bodyPreview=${preview}`
  );
}

async function handleToolCall(toolName, args) {
  if (toolName === 'sender_health') {
    const warm = await ensureSenderReady();
    return normalizeSenderHealth(warm.upstream.bodyJson);
  }

  if (toolName === 'sender_transform') {
    requireObject(args, 'args');
    requireObject(args.payload, 'args.payload');

    const upstream = await callSenderJson(
      '/transform',
      'POST',
      { payload: args.payload }
    );

    return normalizeTransformOutput(upstream.bodyJson);
  }

  if (toolName === 'sender_send') {
    requireObject(args, 'args');
    requireObject(args.payload, 'args.payload');

    const upstream = await callSenderJson(
      '/send',
      'POST',
      { payload: args.payload }
    );

    return normalizeSendOutput(upstream.bodyJson);
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
        version: '0.3.0'
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
        error.detail || null
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
        version: '0.3.0',
        sender_base_url: SENDER_BASE_URL,
        warm_config: {
          max_attempts: WARM_MAX_ATTEMPTS,
          retry_delay_ms: WARM_RETRY_DELAY_MS,
          request_timeout_ms: WARM_REQUEST_TIMEOUT_MS
        }
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
        version: '0.3.0',
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
  console.log(`Sender base URL: ${SENDER_BASE_URL}`);
  console.log(
    `Warm config: attempts=${WARM_MAX_ATTEMPTS}, delayMs=${WARM_RETRY_DELAY_MS}, timeoutMs=${WARM_REQUEST_TIMEOUT_MS}`
  );
});
