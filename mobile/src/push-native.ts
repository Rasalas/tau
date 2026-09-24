import { App } from "@capacitor/app";
import { PushNotifications } from "@capacitor/push-notifications";
import { pushAvailable } from "./native";
import type { PushPort } from "./push";

const TOKEN_TIMEOUT_MS = 20_000;

/** The platform half of push: Capacitor's plugin for permission, token and taps. */
export function nativePushPort(platform: "ios" | "android"): PushPort {
  return {
    platform,
    available: () => pushAvailable(),
    permission: async () => {
      const { receive } = await PushNotifications.checkPermissions();
      return receive === "granted" ? "granted" : receive === "denied" ? "denied" : "prompt";
    },
    requestPermission: async () => ((await PushNotifications.requestPermissions()).receive === "granted" ? "granted" : "denied"),
    token: () => new Promise<string>((resolve, reject) => {
      const handles = [
        PushNotifications.addListener("registration", ({ value }) => { done(); resolve(value); }),
        PushNotifications.addListener("registrationError", ({ error }) => { done(); reject(new Error(error)); }),
      ];
      const timer = setTimeout(() => { done(); reject(new Error("The system gave no push token.")); }, TOKEN_TIMEOUT_MS);
      function done(): void {
        clearTimeout(timer);
        for (const handle of handles) void handle.then((entry) => entry.remove());
      }
      void PushNotifications.register().catch((error: unknown) => { done(); reject(error instanceof Error ? error : new Error(String(error))); });
    }),
    topic: async () => (platform === "ios" ? (await App.getInfo()).id : undefined),
    onTap: (listener) => {
      const handle = PushNotifications.addListener("pushNotificationActionPerformed", ({ notification }) => listener((notification.data ?? {}) as Record<string, unknown>));
      return () => { void handle.then((entry) => entry.remove()); };
    },
  };
}
