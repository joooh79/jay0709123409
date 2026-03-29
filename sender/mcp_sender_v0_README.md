# MCP Sender v0

Minimal prototype server for AI Dental Clinic sender-role replacement testing.

## What it does
- Accepts canonical JSON
- Normalizes into findings_records[] payload expected by current Make scenario
- Can transform only or live-send to the current Make webhook
- Saves audit JSON for every request

## Endpoints
- `GET /health`
- `POST /transform`
- `POST /send`

## Start
```bash
node mcp_sender_v0.js
```

Optional env:
```bash
export MCP_SENDER_PORT=8787
export MCP_SENDER_HOST=127.0.0.1
export MCP_SENDER_ENABLE_NETWORK_SEND=false
export MCP_SENDER_WEBHOOK_URL='https://hook.eu1.make.com/38cx9ls57f7k3akd6us4hwchrtwfl050'
export MCP_SENDER_AUDIT_DIR='./mcp_sender_audit'
```

## Input envelope
```json
{
  "request_id": "req-001",
  "timestamp": "2026-03-29T12:00:00Z",
  "source": "CPL_AI",
  "payload": {
    "workflow": {
      "mode": "existing_visit_update",
      "patient_status_claim": "existing_patient",
      "visit_intent_claim": "existing_visit_update",
      "target_visit_date": "2026-04-10",
      "target_visit_id": "",
      "target_visit_clue": "",
      "uncertainty_note": ""
    },
    "patients": {
      "patient_id": "910001",
      "birth_year": "1985",
      "gender": "Male"
    },
    "visits": {
      "visit_id": "VISIT-910001-20260410",
      "date": "2026-04-10",
      "visit_type": "emergency",
      "chief_complaint": "mcp sender v0 baseline",
      "pain_level": 0
    },
    "findings_present": {
      "pre_op": true,
      "radiographic": false,
      "operative": false,
      "diagnosis": false,
      "treatment_plan": false,
      "doctor_reasoning": false
    },
    "findings_records": [
      {
        "branch_key": "pre_op",
        "branch_code": "PRE",
        "branch_label": "Pre-op Clinical Findings",
        "visit_id": "VISIT-910001-20260410",
        "tooth_number": "36",
        "record_name": "VISIT-910001-20260410-36-PRE",
        "fields": {
          "Record name": "VISIT-910001-20260410-36-PRE",
          "Visit ID": "VISIT-910001-20260410",
          "Tooth number": "36",
          "Symptom": ["bite pain"],
          "Symptom reproducible": "yes",
          "Visible crack": "visible"
        }
      }
    ],
    "record_name_rule": "",
    "record_name_generation_source": ""
  }
}
```

## Transform only
```bash
curl -s http://127.0.0.1:8787/transform \
  -H 'Content-Type: application/json' \
  --data @sample_request.json
```

## Live send
Set `MCP_SENDER_ENABLE_NETWORK_SEND=true`, then:
```bash
curl -s http://127.0.0.1:8787/send \
  -H 'Content-Type: application/json' \
  --data @sample_request.json
```

## Notes
- `/send` is disabled by default for safety.
- Every request writes one audit JSON file.
- This is a prototype sender-role replacement candidate only.

