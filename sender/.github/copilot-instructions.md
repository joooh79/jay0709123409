# AI Dental Clinic sender repo instructions

This repository is for the active MCP Sender v2 sender path.

Current runtime shape:
ChatGPT -> warm-up proxy Worker -> single Render sender -> Make

Primary implementation artifacts:
- proxy-worker.js
- mcp_sender_single_render_v1_1_17js
- package.json

Rules:
- Do not invent fields, option values, workflow modes, or JSON keys.
- Do not confuse sender operational protocol with runtime identity.
- Keep preview-first behavior.
- Keep transform-before-send behavior.
- Make the smallest safe change first.
- If uncertain, label findings as confirmed / likely / unverified.

When working on sender logic, read first:
- AI_Dental_Clinic_MCP_Sender_v2_Operational_Protocol.txt
- AI_Dental_Clinic_MCP_Sender_v2_Runtime_Record.txt
- AI_Dental_Clinic_MCP_Sender_v2_Implementation_Reference.txt