import { openUrl as openTauriUrl } from "@tauri-apps/plugin-opener";
import { isRunningInTauri } from "./tauri";

export async function openExternalUrl(url: string): Promise<void> {
  if (isRunningInTauri()) {
    await openTauriUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
