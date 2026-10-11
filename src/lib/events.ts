import { listen } from "@tauri-apps/api/event";
import { listenWebEvent } from "../web/events";
import { isRunningInTauri } from "./tauri";

export async function listenBackendEvent<T>(
  event: string,
  callback: (event: { payload: T }) => void,
): Promise<() => void> {
  return isRunningInTauri()
    ? listen<T>(event, callback)
    : listenWebEvent<T>(event, callback);
}
