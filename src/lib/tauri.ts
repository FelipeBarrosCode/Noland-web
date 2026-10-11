import { invoke } from "@tauri-apps/api/core";
import { invokeWebCommand } from "../web/commands";

export async function invokeSafe<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isRunningInTauri()) {
    return invokeWebCommand<T>(command, args);
  }
  return invoke<T>(command, args);
}

export function isRunningInTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
