# PHASE2_FIELD_OPTION_REGISTRY

Status: canon-verified from live Airtable schema upload

Primary source:
- airtable_schema.json / airtable_schema_live.json uploaded in current conversation

Usage rule:
- Sender must validate exact field names, exact field types, and exact allowed option values before send.
- For selectable fields:
  - invalid field name -> block in sender_transform
  - invalid single select value -> block in sender_transform
  - invalid multi select item -> block in sender_transform
- Do not coerce unknown option values.
- Do not silently drop invalid selectable values.

## Visits

| Field | Type | Allowed values | Validation mode |
|---|---|---|---|
| Visit type | single_select | `first visit`, `recall`, `emergency` | block |
| Chief Complaint | multiline_text | free text | pass |
| Pain level | number | integer | block_on_type |

## Pre-op Clinical Findings

| Field | Type | Allowed values | Validation mode |
|---|---|---|---|
| Symptom | multi_select | `cold sensitivity`, `bite pain`, `pain on release`, `chewing pain`, `spontaneous pain`, `none` | block |
| Symptom reproducible | single_select | `yes`, `no`, `not tested` | block |
| Visible crack | single_select | `none`, `suspected`, `visible` | block |
| Crack detection method | multi_select | `visual`, `transillumination`, `bite test`, `photo magnification`, `N/A` | block |
| Functional Cusp - involvement | single_select | `yes`, `no`, `uncertain` | block |
| Pulp - EPT | single_select | `positive`, `weak`, `negative`, `not tested` | block |
| Pulp - cold test | single_select | `normal`, `sensitive`, `lingering`, `none`, `not tested` | block |
| existing restorations | single_select | `none`, `composite`, `amalgam`, `gold inlay`, `ceramic inlay/onlay`, `crown` | block |
| Existing restoration size | single_select | `small`, `moderate`, `large` | block |
| Occlusal wear | single_select | `none`, `mild`, `moderate`, `severe` | block |
| Structure estimation - suspected cusp thin? | single_select | `no`, `possible`, `likely` | block |
| Margin estimation - suspected subgingival margin | single_select | `no`, `possible`, `clear` | block |
| Rubber Dam Feasibility | single_select | `easy`, `difficult`, `impossible` | block |

## Radiographic Findings

| Field | Type | Allowed values | Validation mode |
|---|---|---|---|
| Radiograph type | single_select | `bitewing`, `periapical`, `panoramic`, `CBCT` | block |
| Radiographic caries depth | single_select | `none`, `enamel`, `outer dentin`, `middle dentin`, `deep dentin` | block |
| Secondary caries | single_select | `none`, `suspected`, `clear` | block |
| Caries location | multi_select | `mesial`, `distal`, `occlusal`, `cervical`, `root`, `N/A` | block |
| Pulp chamber size | single_select | `large`, `normal`, `narrow`, `very narrow` | block |
| Periapical lesion | single_select | `none`, `suspected`, `present` | block |
| Radiographic fracture sign | single_select | `none`, `possible fracture`, `clear fracture` | block |
| Radiograph link | url | URL string | block_on_type |

## Operative Findings

| Field | Type | Allowed values | Validation mode |
|---|---|---|---|
| Rubber dam isolation | single_select | `isolated`, `difficult but isolated`, `not possible` | block |
| Caries depth (actual) | single_select | `enamel`, `outer dentin`, `middle dentin`, `deep dentin`, `pulp exposure` | block |
| Soft dentin remaining | single_select | `none`, `minimal`, `intentional` | block |
| Crack confirmed | single_select | `none`, `enamel crack`, `dentin crack`, `deep crack`, `split tooth` | block |
| Crack location | multi_select | `mesial marginal ridge`, `distal marginal ridge`, `central groove`, `buccal`, `palatal`, `unknown`, `N/A` | block |
| Remaining cusp thickness (mm) | number | numeric, precision 1 | block_on_type |
| Subgingival margin | single_select | `no`, `supragingival`, `slightly subgingival`, `deep subgingival` | block |
| Deep marginal elevation | single_select | `not needed`, `performed` | block |
| IDS/resin coating | single_select | `none`, `performed` | block |
| Resin core build up type | single_select | `none`, `standard core`, `fiber reinforced core`, `standard resin core` | block |
| Occlusal loading test | single_select | `not performed`, `performed` | block |
| Loading test result | single_select | `complete relief`, `partial relief`, `no change`, `worse`, `N/A` | block |
| Intraoral photo link | url | URL string | block_on_type |

## Diagnosis

| Field | Type | Allowed values | Validation mode |
|---|---|---|---|
| Structural diagnosis | multi_select | `intact tooth`, `primary caries`, `secondary caries`, `cracked tooth`, `cusp fracture`, `split tooth`, `root fracture`, `N/A` | block |
| Pulp diagnosis | single_select | `normal pulp`, `reversible pulpitis`, `irreversible pulpitis`, `necrotic pulp`, `previously treated` | block |
| Crack severity | single_select | `none`, `superficial crack`, `dentin crack`, `deep crack`, `split tooth` | block |
| Occlusion risk | single_select | `normal`, `heavy occlusion`, `bruxism suspected` | block |
| Restorability | single_select | `restorable`, `questionable`, `non-restorable` | block |

## Treatment Plan

| Field | Type | Allowed values | Validation mode |
|---|---|---|---|
| Pulp therapy | single_select | `none`, `VPT`, `RCT` | block |
| Restoration design | single_select | `direct composite`, `inlay`, `onlay`, `overlay`, `crown`, `implant crown`, `extraction` | block |
| Restoration material | single_select | `composite`, `ultimate`, `e.max`, `zirconia`, `gold`, `none` | block |
| Implant placement | single_select | `not planned`, `planned`, `placed` | block |
| Scan file link | url | URL string | block_on_type |

## Doctor Reasoning

| Field | Type | Allowed values | Validation mode |
|---|---|---|---|
| Decision factor | multi_select | `remaining cusp thickness`, `functional cusp involvement`, `crack depth`, `caries depth`, `pulp status`, `occlusion`, `subgingival margin`, `N/A` | block |
| Remaining cusp thickness decision | single_select | `>1.5 mm cusp preserved`, `<1.5 mm cusp coverage` | block |
| Functional cusp involvement | single_select | `yes`, `no` | block |
| Crack progression risk | single_select | `low`, `moderate`, `high` | block |
| Occlusal risk | single_select | `normal`, `heavy occlusion`, `bruxism suspected` | block |
| Reasoning notes | multiline_text | free text | pass |

## Phase 2 sender validation rules

1. Validate exact Airtable field name before shaping outbound field map.
2. Validate exact Airtable field type before preview/send.
3. For `single_select`, value must match one allowed option exactly.
4. For `multi_select`, every item must match one allowed option exactly.
5. For numeric fields, block non-numeric values before send.
6. For free text fields, do not option-validate; preserve existing preview/send rules.
7. Validation failure must stop at `sender_transform` with explicit blocking error.
8. Do not silently filter invalid selectable values.

## Phase 2 default policy seeds

This section is for sender behavior, not Airtable schema truth.

| Field | Default policy | Add-capable |
|---|---|---|
| visits.chief_complaint | replace | yes |
| pre_op.Symptom | add | yes |
| all other selectable fields currently verified | replace | no unless explicitly added later |
