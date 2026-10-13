import { ACCESS_CLOSE_REASON } from "../shared/connections";

/** What a client says when the host closed it with 4401, by the reason it gave. */
export function accessRefusal(reason: string): string {
  if (reason === ACCESS_CLOSE_REASON.revoked) return "This device’s access was ended on the machine. Create a new pairing link in Tau’s Settings → Connections there.";
  if (reason === ACCESS_CLOSE_REASON.rotated) return "The access key was changed on the machine. Connect again with the new key.";
  return "The machine did not accept this device’s access. Pair it again.";
}
