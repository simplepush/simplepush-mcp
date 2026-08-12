/** Public status summary for the uptime monitor, mirroring the backend's
 * `/v1/status`: 200 only when every dependency this server needs is
 * operational, 503 otherwise, and failures are reported as status only.
 *
 * Distinct from `/health`, which the orchestrator probes: that one must stay
 * independent of the backend, or a backend outage would restart these pods.
 */
import type { HttpConfig } from "./config.js";

const PROBE_TIMEOUT_MS = 3000;

export type ComponentHealth = { name: string; status: "operational" | "down"; latencyMs?: number };
export type StatusResponse = { status: "operational" | "degraded" | "down"; components: ComponentHealth[] };

async function check(name: string, probe: (signal: AbortSignal) => Promise<boolean>): Promise<ComponentHealth> {
  const started = Date.now();
  try {
    const ok = await probe(AbortSignal.timeout(PROBE_TIMEOUT_MS));
    return ok ? { name, status: "operational", latencyMs: Date.now() - started } : { name, status: "down" };
  } catch {
    return { name, status: "down" };
  }
}

/** A throwaway token: `active: false` on a 200 proves the authorization
 * server is up AND accepts our introspection credential, which is what every
 * authenticated request depends on. */
async function authorizationServer(config: HttpConfig, signal: AbortSignal, fetchImpl: typeof fetch): Promise<boolean> {
  const resp = await fetchImpl(new URL("/oauth/introspect", config.authServerUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.introspectionSecret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token: "status-probe" }).toString(),
    signal,
  });
  if (!resp.ok) return false;
  const body = (await resp.json()) as { active?: unknown };
  return body.active === false;
}

/** The backend's own summary, so a database or storage outage shows here too. */
async function api(config: HttpConfig, signal: AbortSignal, fetchImpl: typeof fetch): Promise<boolean> {
  const resp = await fetchImpl(new URL("/v1/status", config.baseUrl), { signal });
  return resp.ok;
}

export async function status(config: HttpConfig, fetchImpl: typeof fetch = fetch): Promise<StatusResponse> {
  const components = await Promise.all([
    check("authorization-server", (signal) => authorizationServer(config, signal, fetchImpl)),
    check("api", (signal) => api(config, signal, fetchImpl)),
  ]);
  const up = components.filter((c) => c.status === "operational").length;
  const overall = up === components.length ? "operational" : up > 0 ? "degraded" : "down";
  return { status: overall, components };
}
