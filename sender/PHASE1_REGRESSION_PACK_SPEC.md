# Phase 1 Regression Pack Specification
## MCP Sender v1.1.17-phase1-closeout

**Document Purpose**: Lock critical phase1 behavior for regression testing.  
**Classification**: Mixed state-sensitive and contract-sensitive cases.  
**Last Updated**: 2026-04-04  
**Runtime Target**: `mcp_sender_single_render_v1_1_17.js`

---

## A. Conflict / Correction Line (Cases RP-01 through RP-06)

### RP-01: New Patient + Patient Found → Initial Conflict Preview
**Type**: CONTRACT-SENSITIVE  
**Trigger**: `new_patient` + `new_visit` + current-state finds matching patient  
**Expected Output**:
- Stage: `NEW_PATIENT_PATIENT_FOUND_STAGE1_PREVIEW`
- Conflict envelope present with `new_patient_patient_found_conflict` block
- Choice field: `phase1_decision.new_patient_patient_found_decision`
- 3 choices available:
  - Choice 1: `switch_existing_new_visit` → existing_patient_new_visit path
  - Choice 2: `reenter_patient_id` → re-lookup mechanism active
  - Choice 3: `cancel` → abort transaction
- **Fail Signal**: Missing conflict envelope, wrong stage name, or choice count ≠ 3

---

### RP-02: Choice 2 + Replacement Patient ID = Not Found → Resolved
**Type**: STATE-SENSITIVE  
**Input Basis**: Choice 2 selected + replacement patient_id provided (not found in current-state)  
**Expected Output**:
- Stage: `NEW_PATIENT_PATIENT_FOUND_RELOOKUP_NOT_FOUND_RESOLVED`
- Return to standard `new_patient_new_visit` preview (no conflict)
- `phase1_decision.new_patient_patient_found_conflict_flow: true`
- Replacement ID cleared from state
- **Fail Signal**: Conflict persists, wrong stage, or still demands re-lookup

---

### RP-03: Choice 2 + Replacement Patient ID = Found → Updated Conflict Preview
**Type**: STATE-SENSITIVE  
**Input Basis**: Choice 2 selected + replacement patient_id found in current-state  
**Expected Output**:
- Stage: `NEW_PATIENT_PATIENT_FOUND_RELOOKUP_FOUND_STAGE1_PREVIEW`
- Conflict envelope re-rendered with updated found patient data
- Same 3-choice structure as RP-01
- No infinite loop: state tracks re-lookup occurred
- **Fail Signal**: Loop detection missing, wrong stage, or conflict removed prematurely

---

### RP-04: Choice 2 + Current-State Unavailable → Safe Stop
**Type**: STATE-SENSITIVE  
**Trigger**: Choice 2 selected + current-state fetch fails or times out  
**Expected Output**:
- Stage: `NEW_PATIENT_PATIENT_FOUND_CURRENT_STATE_REQUIRED_UNAVAILABLE`
- `result_type: 'retry_later'`
- Message: Instructs user to retry later
- No blind proceed forward
- **Fail Signal**: Proceeds without state, result_type ≠ 'retry_later', or missing retry message

---

### RP-05: Same-Date Correction + Choice 1 → Corrected existing_visit_update Preview
**Type**: CONTRACT-SENSITIVE  
**Trigger**: Same-date correction + user selects choice 1  
**Expected Output**:
- Payload fields set:
  - `workflow.mode = 'existing_visit_update'`
  - `workflow.visit_intent_claim = 'existing_visit_update'`
  - `phase1_decision: { confirm_existing_visit_update }`
- Message: 'semantically corrected existing_visit_update payload requires preview confirmation first'
- Next call must re-render as `existing_visit_update` Stage 2 preview
- **Blind resend forbidden**: Caller must see preview before final send
- **Fail Signal**: Missing mode/intent change, skips preview, or allows blind send

---

### RP-06: Same-Date Correction + Choice 2 → Hard-Stop
**Type**: CONTRACT-SENSITIVE  
**Trigger**: Same-date correction + user selects choice 2  
**Expected Output**:
- Transaction halts
- No further state progression allowed
- User must restart workflow
- **Fail Signal**: Proceeds unexpectedly or allows recovery

---

## B. Existing Visit Update Line (Cases RP-07 through RP-09)

### RP-07: Existing Visit Update + No-Op Preview → Send Blocked
**Type**: CONTRACT-SENSITIVE  
**Input Basis**: `existing_visit_update` payload where all changes are no-op (before == incoming)  
**Expected Output**:
- `result_type: 'no_op'`
- Preview rendered with all rows displaying exactly "변경 없음"
- Send blocked via `must_not_call_sender_send_after_reinput: true`
- Message: Instructs user that no changes detected
- **Fail Signal**: result_type ≠ 'no_op', shows "변경 예정", or allows send

---

### RP-08: Existing Visit Update + Real Changes → Preview Required
**Type**: CONTRACT-SENSITIVE  
**Condition**: Header diff exists OR findings diff exists (at least one !no_op)  
**Expected Output**:
- Stage 2 preview rendered
- Display labels used exactly:
  - "변경 없음" (no_op=true)
  - "변경 예정" (no_op=false)
  - "(current-state unavailable)" (state unavailable, placeholder)
- Confirmation: "기존 방문 업데이트 preview입니다. 이 내용대로 적용할까요?"
- User must confirm before send
- **Blind send forbidden**: sender_send route requires prior preview confirmation
- **Fail Signal**: Skips preview, shows wrong labels, or allows blind send

---

### RP-09: Existing Visit Update + Same-Date Correction Confirmation
**Type**: CONTRACT-SENSITIVE  
**Trigger**: Payload claims `visit_intent_claim: 'existing_visit_update'` + `confirm_existing_visit_update` present  
**Expected Output**:
- Two-stage preview complete
- Result confirms merge_mode and execution summary
- `preview_decision_trace.two_stage_preview_used: true`
- Ready for final sender_send call
- **Fail Signal**: Missing trace, incomplete preview, or state clears prematurely

---

## C. Protected Non-Regression Lines (Cases RP-10 through RP-13)

### RP-10: Patient Recheck Required Flag Preserved
**Type**: CONTRACT-SENSITIVE  
**Case**: Any route + patient data changed  
**Expected Output**:
- `is_patient_recheck_required: true` returned in response
- `must_not_call_sender_send_after_reinput: true` when applicable
- Message guides user: confirm patient details before final send
- **Fail Signal**: Flag missing, incorrect value, or guidance absent

---

### RP-11: Patient Recheck Failed Handling
**Type**: STATE-SENSITIVE  
**Trigger**: Patient recheck attempted + current-state mismatch detected  
**Expected Output**:
- Reason message clearly identifies mismatch
- No auto-recovery; user must re-input
- Conflict/correction flow re-engaged as appropriate
- **Fail Signal**: Auto-proceeds past mismatch, vague error message, or state resets

---

### RP-12: Existing Patient New Visit Normal Path
**Type**: CONTRACT-SENSITIVE  
**Case**: `existing_patient` + `new_visit` payload, no conflicts  
**Expected Output**:
- Direct stage2 preview rendered
- No conflict envelope
- `new_patient_patient_found_conflict_flow: false`
- Standard update confirmation
- **Fail Signal**: Conflict appears, wrong stage, or unexpected flow

---

### RP-13: Same-Date Correction Required Normal Entry (Choice 1 Path)
**Type**: CONTRACT-SENSITIVE  
**Case**: Same-date correction + choice 1 selected → existing_visit_update re-entry  
**Expected Output**:
- Payload transitioned to `existing_visit_update` mode
- Preview rendered with two-stage display
- Stage 2 labels locked: "변경 없음", "변경 예정", "(current-state unavailable)"
- No further choice prompts until send confirmed
- **Fail Signal**: Wrong mode, missing labels, or choice prompts reappear

---

## Classification Reference

### STATE-SENSITIVE Cases
Depend on live Airtable / current-state data availability:
- RP-02, RP-03, RP-04 (new_patient choice 2 flows)
- RP-11 (patient recheck mismatch)

**Test Approach**: Mock current-state responses; test both found/not-found/unavailable paths.

### CONTRACT-SENSITIVE Cases
Sender contract meaning must hold regardless of live state:
- RP-01, RP-05, RP-06 (conflict/correction envelope structure)
- RP-07, RP-08, RP-09 (existing_visit_update preview/send blocking)
- RP-10, RP-12, RP-13 (routing and mode preservation)

**Test Approach**: Verify behavior independent of external state; assert exact message text and field names.

---

## Pass Criteria Summary

✅ **Conflict Handling**: RP-01 to RP-06 all produce expected envelopes, stages, and choices  
✅ **Correction Handling**: RP-05/RP-06/RP-13 preserve mode transitions and block blind sends  
✅ **Existing Update Preview**: RP-07/RP-08 enforce preview; RP-09 confirms two-stage completion  
✅ **No-Op Send Block**: RP-07 returns result_type='no_op' with display "변경 없음"  
✅ **Hard-Stop Semantics**: RP-06 halts completely; RP-11 rejects mismatches  
✅ **Recheck Semantics**: RP-10/RP-11 manage patient data integrity pre-send  
✅ **Route Isolation**: RP-12/RP-13 confirm no cross-route interference

---

## Test Execution Order (Recommended)

1. **RP-01** — Basic conflict detection (foundation)
2. **RP-02/RP-03/RP-04** — Choice 2 resolution paths (state sensitivity)
3. **RP-07** — No-op blocking (early safety gate)
4. **RP-05** — Same-date choice 1 transition (complex flow)
5. **RP-08** — Real change preview (core feature)
6. **RP-06, RP-13** — Hard-stop, recheck final paths
7. **RP-09** — Full two-stage confirmation (integration)
8. **RP-10, RP-11, RP-12** — Recheck and isolation (boundary cases)

---

## Version Lock

- **File**: `sender/mcp_sender_single_render_v1_1_17.js`
- **Runtime Constant**: `SENDER_RUNTIME_VERSION = '1.1.17-phase1-closeout'`
- **Locked Behavior**: All items RP-01 through RP-13
- **No Changes Permitted** to routing logic, phase1 decision flow, or preview/send blocking without regression pack update

---

## Notes

- All Korean UI strings are exact matches; localization changes require pack revision.
- `current-state unavailable` is treated as a valid system state, never silently bypassed.
- `must_not_call_sender_send_after_reinput` flag is the final gate; if false, sender_send is safe.
- Two-stage preview (Stage 1 conflict → Stage 2 findings) is sequence-locked; no skipping.
