import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isRunningInTauri } from "../lib/tauri";

type HelperRpcRequest = {
  id: string;
  command: string;
  args?: Record<string, unknown>;
};

let bound = false;

export async function bindNativeHelperBridge(): Promise<void> {
  if (bound || !isRunningInTauri()) return;
  bound = true;
  await listen<HelperRpcRequest>("helper:rpc-request", async ({ payload }) => {
    try {
      const result = await invoke(payload.command, payload.args ?? {});
      await invoke("helper_rpc_respond", { id: payload.id, result: result ?? null, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await invoke("helper_rpc_respond", { id: payload.id, result: null, error: message });
    }
  });

  for (const eventName of [
    "orchestration:progress",
    "direct-upload:progress",
    "shared-storage:progress",
    "shared-storage:restore-completed",
    "remote-terminal-output",
    "remote-terminal-closed",
  ]) {
    await listen(eventName, ({ payload }) => {
      void invoke("helper_publish_event", { event: eventName, payload });
    });
  }
  await invoke("helper_bridge_ready");
}
