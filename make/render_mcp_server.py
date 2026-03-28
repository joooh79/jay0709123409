import json
import os
from typing import Any, Dict, List

import httpx
from fastmcp import FastMCP

WORKER_BASE_URL = os.environ["WORKER_BASE_URL"].rstrip("/")
WORKER_SHARED_SECRET = os.environ.get("WORKER_SHARED_SECRET", "")
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("REQUEST_TIMEOUT_SECONDS", "20"))

mcp = FastMCP("make-live-current-state")


async def worker_get(path: str, params: Dict[str, Any] | None = None) -> Dict[str, Any]:
    headers = {}
    if WORKER_SHARED_SECRET:
        headers["x-inspector-key"] = WORKER_SHARED_SECRET

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        response = await client.get(f"{WORKER_BASE_URL}{path}", params=params, headers=headers)
        response.raise_for_status()
        return response.json()


def search_results_for_query(query: str, module_index: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    q = query.lower().strip()
    results: List[Dict[str, str]] = []

    keyword_map = {
        "details": ("/make/live/details", "Make Live Details"),
        "blueprint": ("/make/live/blueprint", "Make Live Blueprint"),
        "interface": ("/make/live/interface", "Make Live Interface"),
        "logs": ("/make/live/logs", "Make Live Logs"),
        "module index": ("/make/live/module-index", "Make Live Module Index"),
        "module-index": ("/make/live/module-index", "Make Live Module Index"),
        "hook": ("/make/live/hook-log-detail", "Make Hook Log Detail (requires id)"),
    }

    for key, (path, title) in keyword_map.items():
        if key in q:
            results.append({
                "id": path,
                "title": title,
                "url": f"{WORKER_BASE_URL}{path}",
            })

    for module in module_index:
        haystack = " ".join([
            str(module.get("id", "")),
            str(module.get("name", "")),
            str(module.get("moduleType", "")),
            str(module.get("appName", "")),
        ]).lower()
        if q and q in haystack:
            module_id = module["id"]
            results.append({
                "id": f"module:{module_id}",
                "title": f"Module {module_id} - {module.get('name') or module.get('moduleType')}",
                "url": f"{WORKER_BASE_URL}/make/live/module-logs?module_ref={module_id}",
            })

    if not results:
        results.extend([
            {
                "id": "/make/live/details",
                "title": "Make Live Details",
                "url": f"{WORKER_BASE_URL}/make/live/details",
            },
            {
                "id": "/make/live/logs",
                "title": "Make Live Logs",
                "url": f"{WORKER_BASE_URL}/make/live/logs",
            },
            {
                "id": "/make/live/module-index",
                "title": "Make Live Module Index",
                "url": f"{WORKER_BASE_URL}/make/live/module-index",
            },
        ])

    seen = set()
    deduped = []
    for item in results:
        key = item["id"]
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped[:10]


@mcp.tool()
async def search(query: str) -> Dict[str, Any]:
    """Search Make live inspection endpoints and modules by keyword."""
    module_index_payload = await worker_get("/make/live/module-index")
    module_index = module_index_payload.get("results", [])
    results = search_results_for_query(query, module_index)
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps({"results": results}, ensure_ascii=False),
            }
        ]
    }


@mcp.tool()
async def fetch(id: str) -> Dict[str, Any]:
    """Fetch a specific Make live inspection resource by id returned from search."""
    if id.startswith("module:"):
        module_id = id.split(":", 1)[1]
        payload = await worker_get("/make/live/module-logs", {"module_ref": module_id})
        title = f"Module {module_id} Logs"
        url = f"{WORKER_BASE_URL}/make/live/module-logs?module_ref={module_id}"
    elif id in {
        "/make/live/details",
        "/make/live/blueprint",
        "/make/live/interface",
        "/make/live/logs",
        "/make/live/module-index",
    }:
        payload = await worker_get(id)
        title = id.rsplit("/", 1)[-1].replace("-", " ").title()
        url = f"{WORKER_BASE_URL}{id}"
    else:
        raise ValueError(f"Unsupported id: {id}")

    document = {
        "id": id,
        "title": title,
        "text": json.dumps(payload, ensure_ascii=False, indent=2),
        "url": url,
        "metadata": {"source": "make-live-worker"},
    }
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps(document, ensure_ascii=False),
            }
        ]
    }


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
