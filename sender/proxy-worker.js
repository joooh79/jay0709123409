export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (!env.UPSTREAM_BASE_URL) {
      return json(
        {
          ok: false,
          error: "UPSTREAM_BASE_URL is not configured"
        },
        500
      );
    }

    if (pathname === "/proxy-health") {
      try {
        const result = await waitUntilAwake(env);
        return json({
          ok: true,
          proxy: "warmup-proxy-worker",
          upstream_ready: true,
          attempts_used: result.attemptsUsed,
          waited_ms: result.waitedMs,
          upstream_health_status: result.healthStatus
        });
      } catch (error) {
        return json(
          {
            ok: false,
            proxy: "warmup-proxy-worker",
            upstream_ready: false,
            error: error?.message || "Upstream did not wake in time"
          },
          503
        );
      }
    }

    // 핵심 수정 1:
    // /proxy-health 를 제외한 모든 경로에서 wake 완료 후 upstream 프록시
    try {
      await waitUntilAwake(env);
    } catch (error) {
      return json(
        {
          ok: false,
          proxy: "warmup-proxy-worker",
          upstream_ready: false,
          error: error?.message || "Upstream did not wake in time"
        },
        503
      );
    }

    return proxyToUpstream(request, env);
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization"
  };
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeHealth(env) {
  const healthUrl = `${env.UPSTREAM_BASE_URL.replace(/\/+$/, "")}/health`;

  const response = await fetch(healthUrl, {
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(Number(env.HEALTH_PROBE_TIMEOUT_MS || 8000))
  });

  let parsed = null;
  let raw = "";

  try {
    raw = await response.text();
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  return {
    status: response.status,
    ok: response.ok,
    parsed,
    raw
  };
}

async function waitUntilAwake(env) {
  const maxWakeMs = Number(env.MAX_WAKE_MS || 120000);
  const maxAttempts = Number(env.MAX_WAKE_ATTEMPTS || 2);
  const perAttemptWaitMs = Math.floor(maxWakeMs / maxAttempts);

  let attemptsUsed = 0;
  let lastError = null;
  let waitedMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    const attemptStart = Date.now();
    let delay = Number(env.INITIAL_RETRY_DELAY_MS || 1500);

    while (Date.now() - attemptStart < perAttemptWaitMs) {
      try {
        const health = await probeHealth(env);

        if (health.ok && health.parsed && health.parsed.ok === true) {
          waitedMs += Date.now() - attemptStart;
          return {
            ok: true,
            attemptsUsed,
            waitedMs,
            healthStatus: health.status
          };
        }

        lastError = new Error(
          `Health returned non-ok (status=${health.status})`
        );
      } catch (error) {
        lastError = error;
      }

      await sleep(delay);
      delay = Math.min(
        Math.floor(delay * 1.5),
        Number(env.MAX_RETRY_DELAY_MS || 5000)
      );
    }

    waitedMs += Date.now() - attemptStart;
  }

  throw new Error(
    `Upstream did not wake after ${maxAttempts} attempts within ${maxWakeMs}ms${
      lastError ? `: ${lastError.message}` : ""
    }`
  );
}

async function proxyToUpstream(request, env) {
  const incomingUrl = new URL(request.url);
  const upstreamBase = env.UPSTREAM_BASE_URL.replace(/\/+$/, "");
  const upstreamUrl = new URL(
    `${upstreamBase}${incomingUrl.pathname}${incomingUrl.search}`
  );

  const headers = new Headers(request.headers);
  headers.set("x-warmup-proxy", "cloudflare-worker");
  headers.delete("host");

  const init = {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "manual"
  };

  try {
    const upstreamResponse = await fetch(upstreamUrl.toString(), init);

    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
    responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    return json(
      {
        ok: false,
        proxy: "warmup-proxy-worker",
        upstream_ready: false,
        upstream_fetch_failed: true,
        error: error?.message || "Upstream fetch failed",
        upstream_url: upstreamUrl.toString(),
        method: request.method,
        path: incomingUrl.pathname
      },
      503
    );
  }
}