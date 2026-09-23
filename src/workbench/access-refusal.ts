import { ACCESS_CLOSE_REASON } from "../shared/connections";

/** What a client says when the host closed it with 4401, by the reason it gave. */
export function accessRefusal(reason: string): string {
  if (reason === ACCESS_CLOSE_REASON.revoked) return "This client's access to the host was revoked. Ask the host's owner for a new pairing link.";
  if (reason === ACCESS_CLOSE_REASON.rotated) return "The host token was rotated. Connect again with the new token.";
  return "The host refused this client's token.";
}
