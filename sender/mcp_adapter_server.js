#!/usr/bin/env node
'use strict';

/**
 * AI Dental Clinic MCP Adapter Server
 *
 * Thin MCP adapter over existing sender HTTP service.
 *
 * Exposes tools:
 * - sender_health
 * - sender_transform
 * - sender_send
 *
 * Assumes underlying sender server provides:
 * - GET  /health
 * - POST /transform
 * - POST /send
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || process.env.MCP_ADAPTER_PORT || 8790);
const SENDER_BASE_URL =
  process.env.SENDER_BASE_URL || 'http://127.0.0.1:8787';

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
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

function httpRequest(urlString, method = 'GET', body = null) {
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

function normalizeSendOutput(senderJson) {
  return {
    ok: senderJson.status === 'SUCCESS',
    tool: 'sender_send',
    request_id: senderJson.request_id || '',
    status: senderJson.status || '',
    stage: senderJson.stage || '',
    result_type: senderJson.result_type || 'technical_error',
    message: senderJson.message || '',
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
        senderJson.suggested_correction && typeof senderJson.suggested_correction === 'object'
          ? senderJson.suggested_correction
          : null
    },
    input_hash: senderJson.input_hash || '',
    transformed_hash: senderJson.transformed_hash || '',
    transformed_payload: senderJson.transformed_payload || {},
    make_response_raw: senderJson.make_response_raw || '',
    make_response_parsed:
      senderJson.make_response_parsed && typeof senderJson.make_response_parsed === 'object'
        ? senderJson.make_response_parsed
        : null,
    transport:
      senderJson.transport && typeof senderJson.transport === 'object'
        ? senderJson.transport
        : {},
    debug: senderJson.debug || {}
  };
}

function manifest() {
  return {
    name: 'ai-dental-clinic-sender',
    version: '0.1.0',
    description:
      'AI Dental Clinic sender MCP adapter for canonical JSON transform and Make delivery.',
    tools: [
      {
        name: 'sender_health',
        title: 'Sender Health Check',
        description:
          'Check sender service health and basic runtime configuration.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      },
      {
        name: 'sender_transform',
        title: 'Transform Canonical JSON',
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
        title: 'Send Canonical JSON',
        description:
          'Transform canonical dental case JSON into sender-parity payload, send it to the configured Make webhook, and return normalized sender result fields including result_type, message, write_allowed, resend_allowed, reason_code, and parsed Make response.',
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
    ]
  };
}

async function handleToolCall(toolName, args) {
  if (toolName === 'sender_health') {
    const upstream = await httpRequest(`${SENDER_BASE_URL}/health`, 'GET');
    if (!upstream.bodyJson) {
      throw new Error('sender_health returned non-JSON response');
    }
    return normalizeSenderHealth(upstream.bodyJson);
  }

  if (toolName === 'sender_transform') {
    requireObject(args, 'args');
    requireObject(args.payload, 'args.payload');

    const upstream = await httpRequest(
      `${SENDER_BASE_URL}/transform`,
      'POST',
      { payload: args.payload }
    );

    if (!upstream.bodyJson) {
      throw new Error('sender_transform returned non-JSON response');
    }

    return normalizeTransformOutput(upstream.bodyJson);
  }

  if (toolName === 'sender_send') {
    requireObject(args, 'args');
    requireObject(args.payload, 'args.payload');

    const upstream = await httpRequest(
      `${SENDER_BASE_URL}/send`,
      'POST',
      { payload: args.payload }
    );

    if (!upstream.bodyJson) {
      throw new Error('sender_send returned non-JSON response');
    }

    return normalizeSendOutput(upstream.bodyJson);
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'ai-dental-clinic-mcp-adapter',
        version: '0.1.0',
        sender_base_url: SENDER_BASE_URL
      });
    }

    if (req.method === 'GET' && req.url === '/manifest') {
      return sendJson(res, 200, manifest());
    }

    if (req.method === 'POST' && req.url === '/tools/list') {
      return sendJson(res, 200, { tools: manifest().tools });
    }

    if (req.method === 'POST' && req.url === '/tools/call') {
      const body = await parseJsonBody(req);
      requireObject(body, 'body');

      const toolName = body.name;
      const args = body.arguments || {};

      if (typeof toolName !== 'string' || !toolName) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Tool name is required'
        });
      }

      const result = await handleToolCall(toolName, args);

      return sendJson(res, 200, {
        ok: true,
        tool: toolName,
        result
      });
    }

    return sendJson(res, 404, {
      ok: false,
      error: 'Not found',
      endpoints: [
        'GET /health',
        'GET /manifest',
        'POST /tools/list',
        'POST /tools/call'
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
  console.log(`MCP adapter listening on http://${HOST}:${PORT}`);
  console.log(`Sender base URL: ${SENDER_BASE_URL}`);
});
