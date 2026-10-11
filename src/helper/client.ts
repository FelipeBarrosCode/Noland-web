const HELPER_BASE = "http://127.0.0.1:43127";

let sessionToken: string | null = null;
export type HelperAvailability = "missing" | "starting" | "ready";
export type LoopbackPermission = PermissionState | "unsupported";

let helperAvailability: HelperAvailability | null = null;
let eventSource: EventSource | null = null;

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), milliseconds);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("Noland Helper request timed out")));
      }),
    ]);
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function getHelperAvailability(force = false): Promise<HelperAvailability> {
  if (!force && helperAvailability !== null) return helperAvailability;
  try {
    const requestOptions: RequestInit & { targetAddressSpace?: "loopback" } = {
      cache: "no-store",
      headers: { accept: "application/json" },
      targetAddressSpace: "loopback",
    };
    const response = await withTimeout(fetch(`${HELPER_BASE}/v1/health`, requestOptions), 800);
    const body = response.ok ? await response.json() as { ready?: boolean } : null;
    helperAvailability = !response.ok ? "missing" : body?.ready === true ? "ready" : "starting";
  } catch {
    helperAvailability = "missing";
  }
  return helperAvailability;
}

export async function getLoopbackPermission(): Promise<LoopbackPermission> {
  if (!navigator.permissions?.query) return "unsupported";
  try {
    const permission = await navigator.permissions.query({ name: "loopback-network" as PermissionName });
    return permission.state;
  } catch {
    return "unsupported";
  }
}

export async function isHelperAvailable(force = false): Promise<boolean> {
  return await getHelperAvailability(force) === "ready";
}

export async function getHelperSession(): Promise<string | null> {
  if (sessionToken) return sessionToken;
  if (!await isHelperAvailable()) return null;
  const response = await fetch(`${HELPER_BASE}/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) throw new Error(`Noland Helper handshake failed (${response.status})`);
  const body = await response.json() as { token?: string };
  if (!body.token) throw new Error("Noland Helper did not return a session token");
  sessionToken = body.token;
  return sessionToken;
}

export async function invokeHelper<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<{ handled: false } | { handled: true; value: T }> {
  const token = await getHelperSession();
  if (!token) return { handled: false };
  const response = await fetch(`${HELPER_BASE}/v1/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ command, args: args ?? {} }),
  });
  if (response.status === 401) {
    sessionToken = null;
    throw new Error("Noland Helper session expired. Refresh the page to reconnect.");
  }
  if (!response.ok) throw new Error(await response.text());
  const body = await response.json() as { result?: T; error?: string | null };
  if (body.error) throw new Error(body.error);
  return { handled: true, value: body.result as T };
}

export async function ensureHelperEventStream(): Promise<void> {
  if (eventSource) return;
  const token = await getHelperSession();
  if (!token) return;
  eventSource = new EventSource(`${HELPER_BASE}/v1/events?token=${encodeURIComponent(token)}`);
  for (const eventName of [
    "orchestration:progress",
    "direct-upload:progress",
    "shared-storage:progress",
    "shared-storage:restore-completed",
    "remote-terminal-output",
    "remote-terminal-closed",
  ]) {
    eventSource.addEventListener(eventName, (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as unknown;
        window.dispatchEvent(new CustomEvent(`noland:${eventName}`, { detail: payload }));
      } catch (error) {
        console.warn(`[helper] invalid ${eventName} payload`, error);
      }
    });
  }
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
  };
}
