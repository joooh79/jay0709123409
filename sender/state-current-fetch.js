/**
 * AI Dental Clinic - Airtable Current State REST Shim Worker
 *
 * Purpose:
 * - Provide sender-friendly plain HTTP REST read endpoints for current-state fetches
 * - Keep existing MCP /mcp worker untouched
 * - Support minimum fetch ids needed by sender Phase 1:
 *   - patient:{patient_id}
 *   - visit_by_date:{patient_id}:{visit_date}
 *   - visit_children:{visit_record_id}
 *   - record:{table_alias}:{record_id}
 *
 * Deploy this as a separate Cloudflare Worker.
 *
 * Required env:
 * - AIRTABLE_API_KEY
 * - AIRTABLE_BASE_ID   (example current live base: appsqb5C1zdWgNoGK)
 *
 * Optional env:
 * - TABLE_PATIENTS
 * - TABLE_VISITS
 * - TABLE_PRE_OP
 * - TABLE_RADIOGRAPHIC
 * - TABLE_OPERATIVE
 * - TABLE_DIAGNOSIS
 * - TABLE_TREATMENT_PLAN
 * - TABLE_DOCTOR_REASONING
 *
 * Default table ids are filled from current live worker server_info.
 */

const DEFAULT_TABLES = {
  patients: "tblIyGg4l12g1rrIM",
  visits: "tbl1xMzymLiR5iJMZ",
  pre_op: "tbl0EggLYPLBBqOec",
  radiographic: "tblxP2Yzs3w60wrQm",
  operative: "tbl5fFBUAL1Gnf0ET",
  diagnosis: "tblsLLWCAzxh64H0J",
  treatment_plan: "tbld4ds39j8AEzUEy",
  doctor_reasoning: "tblyZ7pX14CnIA1vU",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
      "cache-control": "no-store",
    },
  });
}

function getTableIds(env) {
  return {
    patients: env.TABLE_PATIENTS || DEFAULT_TABLES.patients,
    visits: env.TABLE_VISITS || DEFAULT_TABLES.visits,
    pre_op: env.TABLE_PRE_OP || DEFAULT_TABLES.pre_op,
    radiographic: env.TABLE_RADIOGRAPHIC || DEFAULT_TABLES.radiographic,
    operative: env.TABLE_OPERATIVE || DEFAULT_TABLES.operative,
    diagnosis: env.TABLE_DIAGNOSIS || DEFAULT_TABLES.diagnosis,
    treatment_plan: env.TABLE_TREATMENT_PLAN || DEFAULT_TABLES.treatment_plan,
    doctor_reasoning: env.TABLE_DOCTOR_REASONING || DEFAULT_TABLES.doctor_reasoning,
  };
}

function getBaseId(env) {
  return env.AIRTABLE_BASE_ID || "appsqb5C1zdWgNoGK";
}

function getAuthHeaders(env) {
  if (!env.AIRTABLE_API_KEY) {
    throw new Error("AIRTABLE_API_KEY is not configured");
  }
  return {
    Authorization: `Bearer ${env.AIRTABLE_API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function airtableGet(env, path, searchParams = {}) {
  const url = new URL(`https://api.airtable.com/v0/${getBaseId(env)}/${path}`);
  Object.entries(searchParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: getAuthHeaders(env),
  });

  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  return {
    ok: res.ok,
    status: res.status,
    body,
  };
}

async function getRecord(env, tableId, recordId) {
  return airtableGet(env, `${tableId}/${recordId}`);
}

async function searchOne(env, tableId, formula) {
  return airtableGet(env, tableId, {
    filterByFormula: formula,
    maxRecords: "1",
  });
}

function normalizePatientRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    createdTime: record.createdTime,
    fields: record.fields || {},
  };
}

function normalizeVisitRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    createdTime: record.createdTime,
    fields: record.fields || {},
  };
}

function childAliasesFromVisitFields(fields) {
  return {
    pre_op_clinical_findings: Array.isArray(fields["Pre-op Clinical Findings"]) ? fields["Pre-op Clinical Findings"] : [],
    radiographic_findings: Array.isArray(fields["Radiographic Findings"]) ? fields["Radiographic Findings"] : [],
    operative_findings: Array.isArray(fields["Operative Findings"]) ? fields["Operative Findings"] : [],
    diagnosis: Array.isArray(fields["Diagnosis"]) ? fields["Diagnosis"] : [],
    treatment_plan: Array.isArray(fields["Treatment Plan"]) ? fields["Treatment Plan"] : [],
    doctor_reasoning: Array.isArray(fields["Doctor Reasoning"]) ? fields["Doctor Reasoning"] : [],
  };
}

function childCounts(summary) {
  return Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
}

async function handlePatientFetch(env, patientId) {
  const tables = getTableIds(env);
  const formula = `{Patients ID} = "${patientId}"`;
  const resp = await searchOne(env, tables.patients, formula);

  if (!resp.ok) {
    return json({ ok: false, id: `patient:${patientId}`, error: "airtable_error", detail: resp.body }, resp.status);
  }

  const record = resp.body.records?.[0];
  if (!record) {
    return json({ ok: false, id: `patient:${patientId}`, error: "not_found" }, 404);
  }

  return json({
    ok: true,
    id: `patient:${patientId}`,
    result: {
      record: normalizePatientRecord(record),
    },
  });
}

async function handleVisitByDateFetch(env, patientId, visitDate) {
  const tables = getTableIds(env);
  const formula = `AND(DATETIME_FORMAT({Date}, 'YYYY-MM-DD') = "${visitDate}", {Visit ID} = "VISIT-${patientId}-${visitDate.replaceAll("-", "")}")`;

  // First try by Visit ID pattern + Date.
  let resp = await searchOne(env, tables.visits, formula);

  // Fallback by Date only then inspect Patient link later if needed.
  if (resp.ok && !(resp.body.records?.length)) {
    resp = await searchOne(env, tables.visits, `DATETIME_FORMAT({Date}, 'YYYY-MM-DD') = "${visitDate}"`);
  }

  if (!resp.ok) {
    return json({ ok: false, id: `visit_by_date:${patientId}:${visitDate}`, error: "airtable_error", detail: resp.body }, resp.status);
  }

  const record = resp.body.records?.[0];
  if (!record) {
    return json({ ok: false, id: `visit_by_date:${patientId}:${visitDate}`, error: "not_found" }, 404);
  }

  return json({
    ok: true,
    id: `visit_by_date:${patientId}:${visitDate}`,
    result: {
      record: normalizeVisitRecord(record),
    },
  });
}

async function handleVisitChildrenFetch(env, visitRecordId) {
  const tables = getTableIds(env);
  const visitResp = await getRecord(env, tables.visits, visitRecordId);

  if (!visitResp.ok) {
    return json({ ok: false, id: `visit_children:${visitRecordId}`, error: "visit_not_found", detail: visitResp.body }, visitResp.status);
  }

  const visitRecord = visitResp.body;
  const fields = visitRecord.fields || {};
  const summary = childAliasesFromVisitFields(fields);

  return json({
    ok: true,
    id: `visit_children:${visitRecordId}`,
    result: {
      visit_record_id: visitRecordId,
      records: [],
      child_link_summary: summary,
      child_link_counts: childCounts(summary),
    },
  });
}

async function handleRecordFetch(env, tableAlias, recordId) {
  const tables = getTableIds(env);
  const tableId = tables[tableAlias];

  if (!tableId) {
    return json({ ok: false, id: `record:${tableAlias}:${recordId}`, error: "unknown_table_alias" }, 400);
  }

  const resp = await getRecord(env, tableId, recordId);
  if (!resp.ok) {
    return json({ ok: false, id: `record:${tableAlias}:${recordId}`, error: "not_found", detail: resp.body }, resp.status);
  }

  return json({
    ok: true,
    id: `record:${tableAlias}:${recordId}`,
    result: {
      record: {
        id: resp.body.id,
        createdTime: resp.body.createdTime,
        fields: resp.body.fields || {},
      },
    },
  });
}

async function handleSearch(env, query) {
  // Minimal convenience search for diagnostics. Not required by sender.
  const tables = getTableIds(env);

  // patient_id + visit_date heuristic: "910001 2026-04-10"
  const pairMatch = query.match(/(\d{6})\s+(\d{4}-\d{2}-\d{2})/);
  if (pairMatch) {
    const [, patientId, visitDate] = pairMatch;
    return handleVisitByDateFetch(env, patientId, visitDate);
  }

  // six-digit patient_id heuristic
  const patientMatch = query.match(/\b(\d{6})\b/);
  if (patientMatch) {
    const [, patientId] = patientMatch;
    return handlePatientFetch(env, patientId);
  }

  // record id heuristic
  const recMatch = query.match(/\b(rec[a-zA-Z0-9]+)\b/);
  if (recMatch) {
    const [, recordId] = recMatch;
    for (const alias of Object.keys(tables)) {
      const resp = await getRecord(env, tables[alias], recordId);
      if (resp.ok && resp.body?.id) {
        return json({
          ok: true,
          query,
          result: {
            id: `record:${alias}:${recordId}`,
            table_alias: alias,
            record_id: recordId,
          },
        });
      }
    }
  }

  return json({
    ok: false,
    query,
    error: "search_not_supported_for_query",
  }, 400);
}

function parseFetchId(id) {
  if (!id) return null;

  if (id.startsWith("patient:")) {
    return { kind: "patient", patientId: id.slice("patient:".length) };
  }

  if (id.startsWith("visit_by_date:")) {
    const [, patientId, visitDate] = id.split(":");
    return { kind: "visit_by_date", patientId, visitDate };
  }

  if (id.startsWith("visit_children:")) {
    return { kind: "visit_children", visitRecordId: id.slice("visit_children:".length) };
  }

  if (id.startsWith("record:")) {
    const parts = id.split(":");
    return {
      kind: "record",
      tableAlias: parts[1],
      recordId: parts.slice(2).join(":"),
    };
  }

  return null;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,OPTIONS",
            "access-control-allow-headers": "content-type,authorization",
          },
        });
      }

      if (url.pathname === "/" || url.pathname === "/health") {
        return json({
          ok: true,
          service: "airtable-current-state-rest-shim",
          now: new Date().toISOString(),
          base_id: getBaseId(env),
          table_ids: getTableIds(env),
        });
      }

      if (url.pathname === "/api/fetch") {
        const id = url.searchParams.get("id");
        const parsed = parseFetchId(id);

        if (!parsed) {
          return json({ ok: false, error: "invalid_fetch_id", id }, 400);
        }

        switch (parsed.kind) {
          case "patient":
            return handlePatientFetch(env, parsed.patientId);
          case "visit_by_date":
            return handleVisitByDateFetch(env, parsed.patientId, parsed.visitDate);
          case "visit_children":
            return handleVisitChildrenFetch(env, parsed.visitRecordId);
          case "record":
            return handleRecordFetch(env, parsed.tableAlias, parsed.recordId);
          default:
            return json({ ok: false, error: "unsupported_fetch_kind", id }, 400);
        }
      }

      if (url.pathname === "/api/search") {
        const query = url.searchParams.get("query") || "";
        return handleSearch(env, query);
      }

      return json({ ok: false, error: "not_found", path: url.pathname }, 404);
    } catch (error) {
      return json({
        ok: false,
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  },
};
