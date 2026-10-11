import type {
  LocationState,
  OfferCandidate,
  RentedInstanceSummary,
  ServerPreferences,
  VastWalletSummary,
} from "../lib/types";

const API_BASE = (import.meta.env.VITE_NOLAND_API_BASE || "/api").replace(/\/$/u, "");

type JsonObject = Record<string, unknown>;

async function request<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  if (!apiKey.trim()) throw new Error("A Vast.ai API key is required.");
  const response = await fetch(`${API_BASE}/vast${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-vast-api-key": apiKey.trim(),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`Vast.ai request failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return body as T;
}

function number(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return Number.parseFloat(value) || fallback;
  return fallback;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function boolean(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "verified";
}

function valuesFrom(body: unknown, keys: string[]): JsonObject[] {
  if (Array.isArray(body)) return body.filter(isObject);
  if (!isObject(body)) return [];
  for (const key of keys) {
    const value = body[key];
    if (Array.isArray(value)) return value.filter(isObject);
    if (isObject(value)) return [value];
  }
  return [body];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGeolocation(value: string): [string, string, string] {
  const parts = value.split(/[,/]/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) return [parts[0], parts[1], parts[parts.length - 1] ?? ""];
  if (parts.length === 2) return [parts[0], "", parts[1]];
  return ["", "", parts[0] ?? ""];
}

function distanceKm(from: LocationState, latitude: number, longitude: number): number {
  if (!from.latitude || !from.longitude || !latitude || !longitude) return 0;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const deltaLatitude = radians(latitude - from.latitude);
  const deltaLongitude = radians(longitude - from.longitude);
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(radians(from.latitude)) * Math.cos(radians(latitude))
    * Math.sin(deltaLongitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseOffer(raw: JsonObject, category: string, location: LocationState): OfferCandidate | null {
  const id = number(raw.id);
  if (!id) return null;
  const geolocation = text(raw.geolocation);
  const [city, region, country] = parseGeolocation(geolocation);
  const latitude = number(raw.latitude ?? raw.lat);
  const longitude = number(raw.longitude ?? raw.lon);
  const compute = number(raw.dph_total ?? raw.dph_base ?? raw.min_bid);
  const storage = number(raw.storage_cost ?? raw.storage_hourly);
  const hourlyPrice = compute + storage;
  const reliability = number(raw.reliability ?? raw.reliability2);
  const internetDownMbps = number(raw.inet_down ?? raw.dlperf ?? raw.net_down);
  const internetUpMbps = number(raw.inet_up ?? raw.ulperf ?? raw.net_up);
  const estimatedDistanceKm = distanceKm(location, latitude, longitude);
  const score = reliability * 100 + internetDownMbps / 100 - hourlyPrice * 30 - estimatedDistanceKm / 1000;
  return {
    id,
    hostId: number(raw.host_id) || null,
    hostLabel: text(raw.hostname, raw.machine_id ? `Host-${raw.machine_id}` : "Vast Host"),
    locationLabel: [city, region, country].filter(Boolean).join(", ") || "Unknown location",
    city,
    region,
    country,
    latitude,
    longitude,
    reliability,
    gpuName: text(raw.gpu_name, "Unknown GPU"),
    gpuRamMb: number(raw.gpu_ram ?? raw.gpu_total_ram),
    gpuCount: number(raw.num_gpus, 1),
    cpuName: text(raw.cpu_name ?? raw.cpu_model),
    cpuCores: number(raw.cpu_cores_effective ?? raw.cpu_cores ?? raw.cpu_num_cores),
    internetDownMbps,
    internetUpMbps,
    hourlyPrice,
    computeHourlyPrice: compute,
    storageHourlyPrice: storage,
    availableStorageGb: number(raw.disk_space, 50),
    estimatedDistanceKm,
    score,
    timeRemainingHours: number(raw.duration ?? raw.time_remaining),
    isVerified: boolean(raw.verification),
    isDatacenter: boolean(raw.datacenter),
    offerType: category === "bid" ? "interruptible" : category === "reserved" ? "reserved" : "on-demand",
    hasStaticIp: boolean(raw.static_ip),
    hasAvx: boolean(raw.has_avx),
  };
}

function matchesPreferences(offer: OfferCandidate, preferences: ServerPreferences): boolean {
  return (preferences.maxHourlyPrice <= 0 || offer.hourlyPrice <= preferences.maxHourlyPrice)
    && offer.hourlyPrice >= preferences.minHourlyPrice
    && (!preferences.requireVerified || offer.isVerified)
    && (!preferences.requireDatacenter || offer.isDatacenter)
    && (!preferences.requireStaticIp || offer.hasStaticIp)
    && (!preferences.requireAvx || offer.hasAvx)
    && offer.gpuCount === 1
    && offer.gpuRamMb / 1024 >= preferences.minGpuRamGb
    && offer.cpuCores >= preferences.minCpuCores
    && offer.internetDownMbps >= preferences.minInetDownMbps
    && offer.internetUpMbps >= preferences.minInetUpMbps;
}

export async function searchVastOffers(
  apiKey: string,
  preferences: ServerPreferences,
  location: LocationState,
  limit: number,
): Promise<OfferCandidate[]> {
  const categories = [
    preferences.includeOnDemand ? "ondemand" : null,
    preferences.includeInterruptible ? "bid" : null,
    preferences.includeReserved ? "reserved" : null,
  ].filter((value): value is string => value !== null);
  const results = await Promise.all(categories.map(async (category) => {
    const payload: JsonObject = {
      limit: Math.min(Math.max(limit, 1), 200),
      type: category,
      rentable: { eq: true },
      rented: { eq: false },
      reliability: { gte: Math.max(preferences.minReliability, 0.8) },
      gpu_arch: { eq: "nvidia" },
      vms_enabled: { eq: true },
      num_gpus: { eq: 1 },
      allocated_storage: Math.max(preferences.storageGb, 30),
      order: [["dph_total", "asc"]],
    };
    if (preferences.geolocationCountryCode && preferences.geolocationCountryCode !== "GLOBAL") {
      payload.geolocation = { in: [preferences.geolocationCountryCode.toUpperCase()] };
    }
    const body = await request<unknown>(apiKey, "/api/v0/bundles/", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return valuesFrom(body, ["offers"]).map((raw) => parseOffer(raw, category, location)).filter(Boolean) as OfferCandidate[];
  }));
  const unique = new Map<number, OfferCandidate>();
  for (const offer of results.flat()) if (matchesPreferences(offer, preferences)) unique.set(offer.id, offer);
  return [...unique.values()].sort((left, right) => right.score - left.score);
}

function parseInstance(raw: JsonObject): RentedInstanceSummary | null {
  const instanceId = number(raw.id ?? raw.instance_id ?? raw.contract_id);
  if (!instanceId) return null;
  const status = text(raw.actual_status ?? raw.status ?? raw.cur_state, "pending");
  const publicIp = text(raw.public_ipaddr ?? raw.public_ip);
  const ports = isObject(raw.ports) ? raw.ports : {};
  const gatewayMappings = Array.isArray(ports["8080/tcp"])
    ? ports["8080/tcp"].filter(isObject)
    : [];
  const gatewayPort = number(gatewayMappings[0]?.HostPort ?? gatewayMappings[0]?.host_port, 8080);
  return {
    performanceOverlayEnabled: false,
    instanceId,
    label: text(raw.label, `Instance ${instanceId}`),
    status,
    gpuName: text(raw.gpu_name, "Unknown GPU"),
    sshHost: text(raw.ssh_host, publicIp),
    sshPort: number(raw.ssh_port, 22),
    publicIp,
    gatewayPort,
    embeddedMoonlightPipelineEnabled: true,
    embeddedMoonlightSessionState: null,
    embeddedMoonlightLastError: null,
    embeddedMoonlightRuntimeConnected: null,
    embeddedMoonlightRendererReady: null,
    embeddedMoonlightVideoSessionActive: null,
    embeddedMoonlightPaired: null,
  };
}

export async function listVastInstances(apiKey: string): Promise<RentedInstanceSummary[]> {
  const body = await request<unknown>(apiKey, "/api/v1/instances/");
  return valuesFrom(body, ["instances", "results"])
    .map(parseInstance)
    .filter((instance): instance is RentedInstanceSummary => instance !== null)
    .filter((instance) => !/destroy|stopped|exited/iu.test(instance.status))
    .sort((left, right) => right.instanceId - left.instanceId);
}

export async function destroyVastInstance(apiKey: string, instanceId: number): Promise<void> {
  await request(apiKey, `/api/v0/instances/${instanceId}/`, { method: "DELETE" });
}

export async function getVastWallet(apiKey: string): Promise<VastWalletSummary> {
  const body = await request<JsonObject>(apiKey, "/api/v0/users/current/");
  const balance = number(body.credit ?? body.credit_balance ?? body.balance ?? body.balance_usd, Number.NaN);
  const balanceUsd = Number.isFinite(balance) ? balance : null;
  return {
    available: balanceUsd !== null,
    balanceUsd,
    displayAmount: balanceUsd === null ? "Unavailable" : `$${balanceUsd.toFixed(2)}`,
    source: balanceUsd === null ? "unavailable" : "vast_api",
    lastUpdatedAt: new Date().toISOString(),
  };
}

export async function createVastInstance(
  apiKey: string,
  offer: OfferCandidate,
  templateHash: string,
  storageGb: number,
  sunshineUsername: string,
  sunshinePassword: string,
): Promise<number> {
  const installUrl = "https://raw.githubusercontent.com/FelipeBarrosCode/Noland-web/main/instance-gateway/install.sh";
  const payload = {
    template_hash_id: templateHash,
    disk: Math.max(storageGb, 30),
    runtype: "vm",
    vm: true,
    target_state: "running",
    label: "Noland Web",
    cancel_unavail: true,
    env: [
      "-p 8080:8080/tcp",
      "-p 47990:47990/tcp",
      "-p 40000-40100:40000-40100/udp",
      `-e NOLAND_SUNSHINE_USER_B64=${base64(sunshineUsername || "noland")}`,
      `-e NOLAND_SUNSHINE_PASSWORD_B64=${base64(sunshinePassword)}`,
    ].join(" "),
    onstart: `curl -fsSL '${installUrl}' | sudo bash`,
  };
  const body = await request<JsonObject>(apiKey, `/api/v0/asks/${offer.id}/`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  const id = number(body.new_contract ?? body.instance_id ?? body.contract_id);
  if (!id) throw new Error("Vast.ai accepted the request but did not return an instance ID.");
  return id;
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
