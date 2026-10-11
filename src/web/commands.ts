import type {
  CloudflareTurnSettingsResponse,
  ManualLocationInput,
  InstanceMicConfig,
  InstanceMicRuntimeStatus,
  MicSettingsUpdate,
  MoonlightPreferences,
  OnboardingPayload,
  OfferCandidate,
  ProvisioningEvent,
  ServerPreferencesUpdate,
  SystemHealthReport,
} from "../lib/types";
import { emitWebEvent } from "./events";
import { loadWebState, updateWebState } from "./storage";
import {
  createVastInstance,
  destroyVastInstance,
  getVastWallet,
  listVastInstances,
  searchVastOffers,
} from "./vast";

const offerCache = new Map<number, OfferCandidate>();
const provisioningLog: ProvisioningEvent[] = [];
const microphoneConfigs = new Map<number, InstanceMicConfig>();

function defaultMicrophoneConfig(instanceId: number): InstanceMicConfig {
  return microphoneConfigs.get(instanceId) ?? {
    instanceId,
    enabled: false,
    forwardingEnabled: false,
    autoConnect: false,
    transport: "webrtc",
    codec: "opus",
    sampleRate: 48_000,
    channels: 1,
    vmWireguardIp: "",
    rtpPort: 0,
    rtcpPort: 0,
    localRtcpPort: 0,
    rtpPayloadType: 111,
    deviceId: "default",
    deviceName: "Browser default microphone",
    qualityProfile: "standard",
    sessionId: null,
    sessionToken: null,
    ssrc: null,
    lastEnabledAt: null,
    lastDisabledAt: null,
  };
}

function disabledMicrophoneStatus(): InstanceMicRuntimeStatus {
  return {
    enabled: false,
    state: "disabled",
    reconnectCount: 0,
    vmAgentReachable: false,
    deviceReady: false,
    receivingAudio: false,
    transport: "webrtc",
    sampleRate: 48_000,
    channels: 1,
    bitrateKbps: 64,
    frameMs: 20,
    packetLossPercent: 0,
    jitterMs: 0,
    bufferDepthMs: 0,
    lastPacketMsAgo: null,
    pipewireConnected: false,
    defaultSource: false,
    muted: false,
    sidecarHealthy: false,
    captureSampleRate: 48_000,
    captureOverruns: 0,
    ringFillMs: 0,
    appsrcQueueMs: 0,
    opusPacketsSent: 0,
    bytesSent: 0,
    error: null,
  };
}

function argument<T>(args: Record<string, unknown> | undefined, key: string): T {
  if (!args || !(key in args)) throw new Error(`Missing command argument: ${key}`);
  return args[key] as T;
}

function event(state: ProvisioningEvent["state"], message: string, isError = false): void {
  const payload: ProvisioningEvent = {
    state,
    message,
    timestamp: new Date().toISOString(),
    isError,
  };
  provisioningLog.push(payload);
  if (provisioningLog.length > 250) provisioningLog.shift();
  emitWebEvent("orchestration:progress", payload);
}

function turnSettings(enabled = false): CloudflareTurnSettingsResponse {
  return {
    enabled,
    status: enabled ? "valid" : "disabled",
    keyIdHint: null,
    tokenSet: false,
    credentialRef: "browser-session://cloudflare-turn",
    lastValidatedAt: null,
    lastError: null,
  };
}

async function pollUntilRunning(instanceId: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await loadWebState();
    const instances = await listVastInstances(state.credentials.vastApiKey);
    const instance = instances.find((candidate) => candidate.instanceId === instanceId);
    if (instance && /running|ready/iu.test(instance.status)) {
      await updateWebState((next) => {
        next.instance.status = instance.status;
        next.instance.sshHost = instance.sshHost;
        next.instance.sshPort = instance.sshPort;
        next.moonlight.hostAddress = instance.publicIp || instance.sshHost;
        next.orchestrationState = "Ready";
        next.lastError = null;
      });
      event("Ready", "The instance is running; its browser gateway is starting.");
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 10_000));
  }
  await updateWebState((state) => {
    state.orchestrationState = "Error";
    state.lastError = "Timed out waiting for the rented instance to start.";
  });
  event("Error", "Timed out waiting for the rented instance to start.", true);
}

async function startPlay(): Promise<void> {
  const state = await loadWebState();
  if (!state.selectedOffer) throw new Error("Select a server before starting.");
  event("CreatingInstance", "Creating Vast.ai instance");
  await updateWebState((next) => { next.orchestrationState = "CreatingInstance"; });
  const instanceId = await createVastInstance(
    state.credentials.vastApiKey,
    state.selectedOffer,
    state.serverPreferences.templateHash,
    state.serverPreferences.storageGb,
    state.credentials.appUsername,
    state.credentials.appPassword,
  );
  await updateWebState((next) => {
    next.instance.instanceId = instanceId;
    next.instance.offerId = state.selectedOffer?.id ?? null;
    next.instance.status = "pending";
    next.orchestrationState = "WaitingForInstance";
  });
  event("WaitingForInstance", `Instance ${instanceId} was created and is starting.`);
  void pollUntilRunning(instanceId);
}

export async function invokeWebCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  switch (command) {
    case "get_app_state":
      return await loadWebState() as T;
    case "get_provisioning_logs":
      return [...provisioningLog] as T;
    case "get_setup_status_command":
      return (await loadWebState()).postWireguardSetup as T;
    case "complete_onboarding": {
      const payload = argument<OnboardingPayload>(args, "payload");
      if (!payload.vastApiKey.trim()) throw new Error("A Vast.ai API key is required.");
      await getVastWallet(payload.vastApiKey);
      return await updateWebState((state) => {
        state.onboardingCompleted = true;
        state.credentials.appUsername = payload.appUsername;
        state.credentials.appPassword = payload.appPassword;
        state.credentials.vastApiKey = payload.vastApiKey.trim();
        state.orchestrationState = "Idle";
        state.lastError = null;
      }) as T;
    }
    case "update_vast_api_key": {
      const apiKey = argument<string>(args, "apiKey").trim();
      await getVastWallet(apiKey);
      return await updateWebState((state) => { state.credentials.vastApiKey = apiKey; }) as T;
    }
    case "update_platform_credentials": {
      const payload = argument<{ appUsername: string; appPassword: string }>(args, "payload");
      return await updateWebState((state) => {
        state.credentials.appUsername = payload.appUsername;
        state.credentials.appPassword = payload.appPassword;
      }) as T;
    }
    case "set_manual_location":
    case "set_os_location": {
      const payload = argument<ManualLocationInput>(args, "payload");
      return await updateWebState((state) => {
        state.location = { ...payload, source: command === "set_manual_location" ? "manual" : "os" };
      }) as T;
    }
    case "refresh_ip_location": {
      const response = await fetch("https://ipapi.co/json/");
      if (!response.ok) throw new Error("Unable to detect location from the current IP address.");
      const location = await response.json() as Record<string, unknown>;
      return await updateWebState((state) => {
        state.location = {
          source: "ip",
          city: String(location.city ?? ""),
          region: String(location.region ?? ""),
          country: String(location.country_code ?? ""),
          latitude: Number(location.latitude ?? 0),
          longitude: Number(location.longitude ?? 0),
        };
      }) as T;
    }
    case "update_server_preferences": {
      const payload = argument<ServerPreferencesUpdate>(args, "payload");
      return await updateWebState((state) => { state.serverPreferences = { ...state.serverPreferences, ...payload }; }) as T;
    }
    case "update_moonlight_preferences": {
      const payload = argument<MoonlightPreferences>(args, "payload");
      return await updateWebState((state) => { state.moonlightPreferences = payload; }) as T;
    }
    case "search_offers": {
      const state = await loadWebState();
      const page = Number(args?.page ?? 1);
      const pageSize = Number(args?.pageSize ?? 24);
      const offers = await searchVastOffers(
        state.credentials.vastApiKey,
        state.serverPreferences,
        state.location,
        Math.min(page * pageSize + 1, 200),
      );
      offerCache.clear();
      for (const offer of offers) offerCache.set(offer.id, offer);
      await updateWebState((next) => { next.orchestrationState = "SelectingServer"; });
      return offers.slice((page - 1) * pageSize, page * pageSize) as T;
    }
    case "list_available_offer_countries": {
      const state = await loadWebState();
      const offers = await searchVastOffers(state.credentials.vastApiKey, {
        ...state.serverPreferences,
        geolocationCountryCode: "GLOBAL",
      }, state.location, 200);
      const counts = new Map<string, number>();
      for (const offer of offers) if (offer.country) counts.set(offer.country, (counts.get(offer.country) ?? 0) + 1);
      return [...counts].map(([code, offerCount]) => ({ code, offerCount })).sort((a, b) => b.offerCount - a.offerCount) as T;
    }
    case "select_offer": {
      const offerId = argument<number>(args, "offerId");
      const storageGb = argument<number>(args, "storageGb");
      const offer = offerCache.get(offerId);
      if (!offer) throw new Error("Refresh the offers before selecting this server.");
      return await updateWebState((state) => {
        state.selectedOffer = offer;
        state.serverPreferences.storageGb = Math.max(storageGb, 30);
        state.orchestrationState = "ServerSelected";
      }) as T;
    }
    case "start_play_flow":
      await startPlay();
      return undefined as T;
    case "get_rented_instances": {
      const state = await loadWebState();
      if (!state.credentials.vastApiKey) return [] as T;
      return await listVastInstances(state.credentials.vastApiKey) as T;
    }
    case "get_vast_wallet_summary": {
      const state = await loadWebState();
      return await getVastWallet(state.credentials.vastApiKey) as T;
    }
    case "destroy_instance": {
      const instanceId = argument<number>(args, "instanceId");
      const state = await loadWebState();
      await destroyVastInstance(state.credentials.vastApiKey, instanceId);
      await updateWebState((next) => {
        next.provisionedServers = next.provisionedServers.filter((server) => server.instanceId !== instanceId);
        if (next.instance.instanceId === instanceId) {
          next.instance = { ...next.instance, instanceId: null, offerId: null, status: "idle", sshHost: "" };
          next.orchestrationState = "Idle";
        }
      });
      return undefined as T;
    }
    case "resume_provisioning_existing_instance":
    case "start_play_existing_instance": {
      const instanceId = argument<number>(args, "instanceId");
      const state = await loadWebState();
      const instance = (await listVastInstances(state.credentials.vastApiKey)).find((item) => item.instanceId === instanceId);
      if (!instance) throw new Error("The selected instance is no longer available.");
      const host = instance.publicIp || instance.sshHost;
      if (!host) throw new Error("The instance has not published a reachable address yet.");
      await updateWebState((next) => {
        next.instance.instanceId = instanceId;
        next.instance.status = instance.status;
        next.moonlight.hostAddress = host;
        next.orchestrationState = "Ready";
      });
      return `https://${host}:${instance.gatewayPort ?? 8080}/` as T;
    }
    case "system_health_check": {
      const report: SystemHealthReport = {
        ok: window.isSecureContext && "RTCPeerConnection" in window,
        checkedAtUnix: Math.floor(Date.now() / 1000),
        os: navigator.platform,
        arch: navigator.userAgent,
        summary: window.isSecureContext ? "Browser streaming APIs are available." : "HTTPS is required for browser streaming.",
        probes: [
          {
            id: "secure-context",
            label: "Secure browser context",
            category: "browser",
            status: window.isSecureContext ? "ok" : "failed",
            summary: window.isSecureContext ? "HTTPS is active." : "Open Noland Web over HTTPS.",
            details: null,
            fixHint: window.isSecureContext ? null : "Deploy behind HTTPS before starting a stream.",
          },
          {
            id: "webrtc",
            label: "WebRTC",
            category: "streaming",
            status: "RTCPeerConnection" in window ? "ok" : "failed",
            summary: "RTCPeerConnection" in window ? "WebRTC is supported." : "This browser does not provide WebRTC.",
            details: null,
            fixHint: null,
          },
        ],
      };
      return report as T;
    }
    case "get_cloudflare_turn_settings":
      return turnSettings((await loadWebState()).cloudflareTurn.enabled) as T;
    case "get_auto_shutdown_settings":
      return (await loadWebState()).autoShutdown as T;
    case "save_auto_shutdown_settings": {
      const settings = argument<{ enabled: boolean; inactivityHours: number; backupAppLimit: number }>(args, "settings");
      return await updateWebState((state) => { state.autoShutdown.settings = settings; }) as T;
    }
    case "get_shared_storage_profiles":
      return ((await loadWebState()).sharedStorageProfiles ?? []) as T;
    case "get_shared_storage_settings": {
      const settings = (await loadWebState()).sharedStorage.settings;
      return { ...settings, cryptPasswordSet: false } as T;
    }
    case "list_storage_providers":
      return [] as T;
    case "get_instance_backup_status":
      return {
        instanceId: (await loadWebState()).instance.instanceId,
        configured: false,
        state: "unavailable",
        lastBackupAt: null,
        lastError: "Shared storage has not been ported to the browser gateway.",
      } as T;
    case "get_instance_connection_status": {
      const instanceId = argument<number>(args, "instanceId");
      return {
        instanceId,
        network: {
          schemaVersion: 1,
          clientRevision: 0,
          updatedAt: null,
          preference: "auto",
          activeTransport: null,
          fallbackReason: null,
          direct: { endpoint: null, probeEndpoint: null, effectiveMtu: null, availability: "unknown" },
          cloudflareTurn: {
            enabled: false,
            credentialRef: null,
            relayEndpoint: null,
            allocationGeneration: 0,
            allocationExpiresAt: null,
            credentialExpiresAt: null,
            effectiveMtu: null,
            availability: "unknown",
          },
          lastEvaluation: null,
          lastTransition: null,
          connectionProfile: null,
        },
        manualTurnSwitchingEnabled: false,
        automaticSelectionEnabled: true,
      } as T;
    }
    case "moonlight_get_session_state":
      return { state: "idle", error: null } as T;
    case "moonlight_get_active_input_mode":
      return "browser" as T;
    case "moonlight_get_input_debug_state":
      return {} as T;
    case "network_monitor_get_state":
      return null as T;
    case "set_instance_performance_overlay":
      return argument<boolean>(args, "enabled") as T;
    case "set_instance_moonlight_pipeline_enabled":
      return await loadWebState() as T;
    case "get_software_artwork":
      return { key: String(args?.name ?? ""), imageUrl: null, source: "none" } as T;
    case "get_instance_launch_library": {
      const instanceId = argument<number>(args, "instanceId");
      return { instanceId, launchPcAvailable: false, items: [] } as T;
    }
    case "list_remote_upload_folders":
      return { path: "/", homePath: "/home/user", folders: [] } as T;
    case "list_instance_shared_storage_objects":
    case "list_instance_exportable_storage_objects":
      return [] as T;
    case "get_launch_instance_software_job":
      return null as T;
    case "start_local_sleep_prevention":
    case "stop_local_sleep_prevention":
      return "Browser wake-lock lifecycle is managed by the stream view." as T;
    case "moonlight_start_input_capture":
    case "moonlight_stop_input_capture":
    case "moonlight_activate_native_mouse_capture":
    case "moonlight_deactivate_native_mouse_capture":
      return false as T;
    case "moonlight_update_video_geometry":
    case "moonlight_send_relative_mouse":
    case "moonlight_send_absolute_mouse":
    case "moonlight_send_mouse_button":
    case "moonlight_send_keyboard":
    case "moonlight_disconnect_stream":
      return undefined as T;
    case "stop_provisioning_after_current_stage":
      return undefined as T;
    case "moonlight_get_instance_pipeline_status": {
      const instanceId = argument<number>(args, "instanceId");
      return {
        instanceId,
        enabled: true,
        hostId: `noland-web-${instanceId}`,
        paired: false,
        sessionState: "idle",
        lastError: null,
        runtimeConnected: false,
        rendererReady: false,
        videoSessionActive: false,
        videoFrameCount: 0,
        rendererSubmittedFrameCount: 0,
        rendererDroppedFrameCount: 0,
        audioSampleCount: 0,
        lastRuntimeEvent: null,
      } as T;
    }
    case "get_instance_mic_config": {
      const instanceId = argument<number>(args, "instanceId");
      return defaultMicrophoneConfig(instanceId) as T;
    }
    case "update_instance_mic_settings": {
      const instanceId = argument<number>(args, "instanceId");
      const payload = argument<MicSettingsUpdate>(args, "payload");
      const current = defaultMicrophoneConfig(instanceId);
      const updated: InstanceMicConfig = {
        ...current,
        deviceId: payload.deviceId ?? current.deviceId,
        deviceName: payload.deviceId && payload.deviceId !== current.deviceId
          ? "Browser microphone"
          : current.deviceName,
        qualityProfile: payload.qualityProfile ?? current.qualityProfile,
        forwardingEnabled: payload.forwardingEnabled ?? current.forwardingEnabled,
        autoConnect: payload.autoConnect ?? current.autoConnect,
      };
      microphoneConfigs.set(instanceId, updated);
      return updated as T;
    }
    case "get_instance_mic_status":
      return disabledMicrophoneStatus() as T;
    case "list_microphones": {
      if (!navigator.mediaDevices?.enumerateDevices) return [] as T;
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({
          id: device.deviceId || `browser-microphone-${index}`,
          name: device.label || `Microphone ${index + 1}`,
          isDefault: device.deviceId === "default" || index === 0,
          sampleRates: [48_000],
          channels: 1,
        })) as T;
    }
    case "disable_instance_mic":
    case "mute_instance_mic":
    case "unmute_instance_mic":
    case "recreate_instance_mic_device":
      return undefined as T;
    case "get_instance_mic_metrics":
      return {
        capturedSamples: 0,
        consumedSamples: 0,
        droppedStaleSamples: 0,
        overruns: 0,
        underruns: 0,
        silenceSamples: 0,
        buffersPushed: 0,
        captureRestarts: 0,
        captureErrors: 0,
        pipelineErrors: 0,
        ringDepthSamples: 0,
        appsrcQueueMs: 0,
        opusPacketsSent: 0,
        bytesSent: 0,
        currentRtpSequence: null,
        sampledAtUnixMs: Date.now(),
      } as T;
    case "enable_instance_mic":
    case "reconnect_instance_mic":
      throw new Error("Browser microphone forwarding will be enabled after the gateway session is connected.");
    default:
      throw new Error(`The browser port does not support '${command}' yet.`);
  }
}
