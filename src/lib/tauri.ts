import { invoke } from "@tauri-apps/api/core";
import { invokeWebCommand } from "../web/commands";
import { invokeHelper } from "../helper/client";
import type { RentedInstanceSummary } from "./types";

export async function invokeSafe<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isRunningInTauri()) {
    if (command === "start_play_existing_instance") {
      const instanceId = Number(args?.instanceId);
      const refreshedGateway = await invokeHelper<string>("refresh_instance_web_gateway", { instanceId });
      if (refreshedGateway.handled && refreshedGateway.value) {
        return refreshedGateway.value as T;
      }
      const instances = await invokeHelper<RentedInstanceSummary[]>("get_rented_instances");
      if (!instances.handled) throw new Error("Noland Helper is not connected.");
      const instance = instances.value.find((candidate) => candidate.instanceId === instanceId);
      if (!instance) throw new Error("The selected instance is no longer available.");
      const host = instance.publicIp || instance.sshHost;
      if (!host) throw new Error("The instance has not published a gateway address yet.");
      return `https://${host}:${instance.gatewayPort ?? 8080}/` as T;
    }
    if (command === "moonlight_get_instance_pipeline_status") {
      return invokeWebCommand<T>(command, args);
    }
    const helper = await invokeHelper<T>(command, args);
    if (helper.handled) return helper.value;
    if (import.meta.env.VITE_ALLOW_BROWSER_FALLBACK === "1") {
      return invokeWebCommand<T>(command, args);
    }
    throw new Error("Noland Helper is required for SSH provisioning and native operations.");
  }
  return invoke<T>(command, args);
}

export function isRunningInTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
