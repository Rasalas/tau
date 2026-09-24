import type { DeviceAccess, UiPairingRequest } from "../../shared/connections";
import { describeDevice } from "../settings/connections-format";

export const ACCESS_CHOICES: ReadonlyArray<{ value: DeviceAccess; label: string; hint: string }> = [
  { value: "full", label: "Full", hint: "Everything you can do here: threads, terminal, files, git" },
  { value: "read-only", label: "Read only", hint: "Watch threads and state; change nothing" },
];

/** The name a request goes by: what the device called itself, the link's label, or what its browser says. */
export function requestTitle(request: UiPairingRequest): string {
  return request.name ?? request.link?.label ?? (describeDevice(request.device) || "A device");
}
