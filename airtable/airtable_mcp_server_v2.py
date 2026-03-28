import json
import os
from typing import Any

import httpx
from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import PlainTextResponse

WORKER_BASE_URL = os.environ["WORKER_BASE_URL"].rstrip("/")
WORKER_PUBLIC_BASE_URL = os.environ.get("WORKER_PUBLIC_BASE_URL", WORKER_BASE_URL).rstrip("/")
PORT = int(os.environ.get("PORT", "10000"))

mcp = FastMCP("airtable-current-state")


@mcp.custom_route("/health", methods=["GET"])
async def health_check(_request: Request) -> PlainTextResponse:
    return PlainTextResponse("OK")


def build_url(path: str, **params: str) -> str:
    qp = httpx.QueryParams({k: v for k, v in params.items() if v is not None})
    q = str(qp)
    return f"{WORKER_PUBLIC_BASE_URL}{path}?{q}" if q else f"{WORKER_PUBLIC_BASE_URL}{path}"


async def worker_get(path: str, **params: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(f"{WORKER_BASE_URL}{path}", params=params)
        response.raise_for_status()
        return response.json()


def text_result(payload: dict[str, Any]) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]}


def normalize_table_alias(raw: str) -> str:
    value = raw.strip()

    alias_map = {
        "pre_op": "PRE_OP_TABLE",
        "preop": "PRE_OP_TABLE",
        "pre-op": "PRE_OP_TABLE",
        "pre op": "PRE_OP_TABLE",
        "radiographic": "RADIOGRAPHIC_TABLE",
        "rad": "RADIOGRAPHIC_TABLE",
        "operative": "OPERATIVE_TABLE",
        "op": "OPERATIVE_TABLE",
        "diagnosis": "DIAGNOSIS_TABLE",
        "dx": "DIAGNOSIS_TABLE",
        "treatment_plan": "TREATMENT_PLAN_TABLE",
        "treatment-plan": "TREATMENT_PLAN_TABLE",
        "plan": "TREATMENT_PLAN_TABLE",
        "doctor_reasoning": "DOCTOR_REASONING_TABLE",
        "doctor-reasoning": "DOCTOR_REASONING_TABLE",
        "reasoning": "DOCTOR_REASONING_TABLE",
        "dr": "DOCTOR_REASONING_TABLE",
        "patients": "PATIENTS_TABLE",
        "patient": "PATIENTS_TABLE",
        "visits": "VISITS_TABLE",
        "visit": "VISITS_TABLE",
    }

    lowered = value.lower()
    env_key = alias_map.get(lowered)
    if env_key and os.environ.get(env_key):
        return os.environ[env_key].strip()

    return value


def parse_search_query(query: str) -> list[dict[str, str]]:
    query = query.strip()
    results: list[dict[str, str]] = []
    parts = query.split()

    has_date = len(parts) >= 2 and len(parts[1]) == 10 and parts[1].count("-") == 2

    if query.startswith("record:"):
        _, remainder = query.split("record:", 1)
        try:
            table_name, record_id = remainder.split(":", 1)
        except ValueError:
            return results

        table_name = normalize_table_alias(table_name)
        record_id = record_id.strip()

        results.append(
            {
                "id": f"record:{table_name}:{record_id}",
                "title": f"Record {record_id} in {table_name}",
                "url": build_url("/get_record_snapshot", table_name=table_name, record_id=record_id),
            }
        )
        results.append(
            {
                "id": f"exists:{table_name}:{record_id}",
                "title": f"Exists check {record_id} in {table_name}",
                "url": build_url("/check_record_exists", table_name=table_name, record_id=record_id),
            }
        )
        return results

    if len(parts) == 2 and parts[1].startswith("rec"):
        table_name = normalize_table_alias(parts[0])
        record_id = parts[1].strip()

        results.append(
            {
                "id": f"record:{table_name}:{record_id}",
                "title": f"Record {record_id} in {table_name}",
                "url": build_url("/get_record_snapshot", table_name=table_name, record_id=record_id),
            }
        )
        results.append(
            {
                "id": f"exists:{table_name}:{record_id}",
                "title": f"Exists check {record_id} in {table_name}",
                "url": build_url("/check_record_exists", table_name=table_name, record_id=record_id),
            }
        )
        return results

    if query.startswith("rec"):
        visit_id = query
        results.append(
            {
                "id": f"visit:{visit_id}",
                "title": f"Visit {visit_id}",
                "url": build_url("/lookup_visit_current_state", visit_record_id=visit_id),
            }
        )
        results.append(
            {
                "id": f"visit_children:{visit_id}",
                "title": f"Visit children {visit_id}",
                "url": build_url("/lookup_visit_children_state", visit_record_id=visit_id),
            }
        )
        return results

    if has_date:
        patient_id = parts[0]
        visit_date = parts[1]
        results.append(
            {
                "id": f"bundle:{patient_id}:{visit_date}",
                "title": f"Patient {patient_id} bundle on {visit_date}",
                "url": build_url("/get_patient_visit_bundle", patient_id=patient_id, visit_date=visit_date),
            }
        )
        results.append(
            {
                "id": f"visit_by_date:{patient_id}:{visit_date}",
                "title": f"Visit for patient {patient_id} on {visit_date}",
                "url": build_url("/lookup_visit_current_state", patient_id=patient_id, visit_date=visit_date),
            }
        )
        return results

    patient_id = parts[0]
    results.append(
        {
            "id": f"patient:{patient_id}",
            "title": f"Patient {patient_id} current state",
            "url": build_url("/lookup_patient_current_state", patient_id=patient_id),
        }
    )
    return results


@mcp.tool()
async def search(query: str) -> dict[str, Any]:
    query = query.strip()
    results = parse_search_query(query)
    return text_result({"results": results})


@mcp.tool()
async def fetch(id: str) -> dict[str, Any]:
    if id.startswith("patient:"):
        patient_id = id.split(":", 1)[1]
        data = await worker_get("/lookup_patient_current_state", patient_id=patient_id)
        doc = {
            "id": id,
            "title": f"Patient {patient_id} current state",
            "text": json.dumps(data, ensure_ascii=False, indent=2),
            "url": build_url("/lookup_patient_current_state", patient_id=patient_id),
            "metadata": {"source": "airtable_worker", "kind": "patient_current_state"},
        }
        return text_result(doc)

    if id.startswith("bundle:"):
        _, patient_id, visit_date = id.split(":", 2)
        data = await worker_get("/get_patient_visit_bundle", patient_id=patient_id, visit_date=visit_date)
        doc = {
            "id": id,
            "title": f"Patient {patient_id} bundle on {visit_date}",
            "text": json.dumps(data, ensure_ascii=False, indent=2),
            "url": build_url("/get_patient_visit_bundle", patient_id=patient_id, visit_date=visit_date),
            "metadata": {"source": "airtable_worker", "kind": "patient_visit_bundle"},
        }
        return text_result(doc)

    if id.startswith("visit_by_date:"):
        _, patient_id, visit_date = id.split(":", 2)
        data = await worker_get("/lookup_visit_current_state", patient_id=patient_id, visit_date=visit_date)
        doc = {
            "id": id,
            "title": f"Visit for patient {patient_id} on {visit_date}",
            "text": json.dumps(data, ensure_ascii=False, indent=2),
            "url": build_url("/lookup_visit_current_state", patient_id=patient_id, visit_date=visit_date),
            "metadata": {"source": "airtable_worker", "kind": "visit_by_date"},
        }
        return text_result(doc)

    if id.startswith("visit_children:"):
        visit_id = id.split(":", 1)[1]
        data = await worker_get("/lookup_visit_children_state", visit_record_id=visit_id)
        doc = {
            "id": id,
            "title": f"Visit children {visit_id}",
            "text": json.dumps(data, ensure_ascii=False, indent=2),
            "url": build_url("/lookup_visit_children_state", visit_record_id=visit_id),
            "metadata": {"source": "airtable_worker", "kind": "visit_children"},
        }
        return text_result(doc)

    if id.startswith("visit:"):
        visit_id = id.split(":", 1)[1]
        data = await worker_get("/lookup_visit_current_state", visit_record_id=visit_id)
        doc = {
            "id": id,
            "title": f"Visit {visit_id}",
            "text": json.dumps(data, ensure_ascii=False, indent=2),
            "url": build_url("/lookup_visit_current_state", visit_record_id=visit_id),
            "metadata": {"source": "airtable_worker", "kind": "visit_current_state"},
        }
        return text_result(doc)

    if id.startswith("record:"):
        _, table_name, record_id = id.split(":", 2)
        data = await worker_get("/get_record_snapshot", table_name=table_name, record_id=record_id)
        doc = {
            "id": id,
            "title": f"Record {record_id} in {table_name}",
            "text": json.dumps(data, ensure_ascii=False, indent=2),
            "url": build_url("/get_record_snapshot", table_name=table_name, record_id=record_id),
            "metadata": {"source": "airtable_worker", "kind": "record_snapshot"},
        }
        return text_result(doc)

    if id.startswith("exists:"):
        _, table_name, record_id = id.split(":", 2)
        data = await worker_get("/check_record_exists", table_name=table_name, record_id=record_id)
        doc = {
            "id": id,
            "title": f"Exists check {record_id} in {table_name}",
            "text": json.dumps(data, ensure_ascii=False, indent=2),
            "url": build_url("/check_record_exists", table_name=table_name, record_id=record_id),
            "metadata": {"source": "airtable_worker", "kind": "record_exists"},
        }
        return text_result(doc)

    raise ValueError(f"Unsupported fetch id: {id}")


if __name__ == "__main__":
    mcp.run(transport="http", host="0.0.0.0", port=PORT)
