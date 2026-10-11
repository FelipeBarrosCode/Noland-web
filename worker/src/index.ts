const VAST_ORIGIN = "https://console.vast.ai";
const ALLOWED_PREFIXES = [
  "/api/v0/asks/",
  "/api/v0/bundles/",
  "/api/v0/instances/",
  "/api/v0/users/current/",
  "/api/v1/instances/",
];
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "OPTIONS"]);

interface Env {
  NOLAND_WEB_ORIGIN?: string;
  ASSETS: Fetcher;
}

function cors(request: Request, env: Env): HeadersInit {
  const configuredOrigin = env.NOLAND_WEB_ORIGIN;
  const requestOrigin = request.headers.get("origin") ?? "";
  const allowedOrigin = configuredOrigin && requestOrigin === configuredOrigin
    ? configuredOrigin
    : configuredOrigin ? "" : new URL(request.url).origin;
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-vast-api-key",
    "access-control-max-age": "86400",
    "cache-control": "no-store",
    vary: "Origin",
  };
}

function response(request: Request, env: Env, body: BodyInit | null, status: number): Response {
  return new Response(body, { status, headers: cors(request, env) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestOrigin = request.headers.get("origin") ?? "";
    const expectedOrigin = env.NOLAND_WEB_ORIGIN ?? new URL(request.url).origin;
    if (requestOrigin && requestOrigin !== expectedOrigin) {
      return response(request, env, "Origin not allowed", 403);
    }
    if (request.method === "OPTIONS") return response(request, env, null, 204);
    if (!ALLOWED_METHODS.has(request.method)) return response(request, env, "Method not allowed", 405);

    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith("/api/vast/")) return env.ASSETS.fetch(request);
    const upstreamPath = incoming.pathname.slice("/api/vast".length);
    if (!ALLOWED_PREFIXES.some((prefix) => upstreamPath.startsWith(prefix))) {
      return response(request, env, "Vast endpoint is not allowlisted", 403);
    }

    const apiKey = request.headers.get("x-vast-api-key")?.trim();
    if (!apiKey || apiKey.length > 512) return response(request, env, "Missing Vast API key", 401);

    const upstreamUrl = new URL(upstreamPath, VAST_ORIGIN);
    upstreamUrl.search = incoming.search;
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        ...(request.method === "GET" || request.method === "DELETE"
          ? {}
          : { "content-type": "application/json" }),
      },
      body: request.method === "GET" || request.method === "DELETE" ? undefined : request.body,
      redirect: "manual",
    });
    const headers = new Headers(cors(request, env));
    headers.set("content-type", upstream.headers.get("content-type") ?? "application/json");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
