# AI Dental Clinic MCP Adapter

This folder contains the sender core and the MCP adapter layer for ChatGPT MCP integration.

## Files

- `mcp_sender_v0.js`
  - HTTP sender core
  - endpoints:
    - `GET /health`
    - `POST /transform`
    - `POST /send`

- `mcp_adapter_server.js`
  - thin MCP adapter over the sender HTTP core
  - endpoints:
    - `GET /health`
    - `GET /manifest`
    - `POST /tools/list`
    - `POST /tools/call`

- `mcp_manifest.json`
  - MCP tool manifest draft

## Architecture

ChatGPT MCP
-> `mcp_adapter_server.js`
-> `mcp_sender_v0.js`
-> Make webhook
-> Airtable

## Environment variables

### sender core
- `PORT=8787`
- `MCP_SENDER_PORT=8787`
- `MCP_SENDER_WEBHOOK_URL=https://hook.eu1.make.com/...`
- `MCP_SENDER_AUDIT_DIR=./mcp_sender_audit`
- `MCP_SENDER_ENABLE_NETWORK_SEND=true`

### MCP adapter
- `PORT=8790`
- `MCP_ADAPTER_PORT=8790`
- `SENDER_BASE_URL=http://127.0.0.1:8787`

## Run locally

### 1. start sender core
```bash
node sender/mcp_sender_v0.js
