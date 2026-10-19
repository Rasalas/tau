import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

/** Give slow connections time to complete when the other address family is unreachable. */
export function configureOutboundNetwork(): void {
  setDefaultAutoSelectFamilyAttemptTimeout(Math.max(1_000, getDefaultAutoSelectFamilyAttemptTimeout()));
}
