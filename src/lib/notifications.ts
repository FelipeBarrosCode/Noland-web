import {
  isPermissionGranted as isNativePermissionGranted,
  requestPermission as requestNativePermission,
  sendNotification as sendNativeNotification,
} from "@tauri-apps/plugin-notification";
import { isRunningInTauri } from "./tauri";

type NotificationPayload = {
  title: string;
  body?: string;
  icon?: string;
  silent?: boolean;
  sound?: string;
};

export async function isPermissionGranted(): Promise<boolean> {
  if (isRunningInTauri()) return isNativePermissionGranted();
  return "Notification" in window && Notification.permission === "granted";
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (isRunningInTauri()) return requestNativePermission();
  if (!("Notification" in window)) return "denied";
  return Notification.requestPermission();
}

export async function sendNotification(payload: NotificationPayload): Promise<void> {
  if (isRunningInTauri()) {
    await sendNativeNotification(payload);
    return;
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  new Notification(payload.title, {
    body: payload.body,
    icon: payload.icon,
    silent: payload.silent,
  });
}
