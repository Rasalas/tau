/** The backend kind the host entry registers; threads of this kind carry it as `backendKind`. */
export const ANTIGRAVITY_BACKEND_KIND = "antigravity" as const;
export const ANTIGRAVITY_HOST_EXTENSION_ID = "tau.antigravity";
/** Names Tau to the agent in `initialize.clientInfo`. */
export const ANTIGRAVITY_CLIENT_NAME = "tau";
/** The desktop half opens this link in the user's browser; the agent's own loopback listener completes the sign-in. */
export const ANTIGRAVITY_SIGN_IN_EVENT = "sign-in";
/** The host tells the desktop half how an install is going. */
export const ANTIGRAVITY_INSTALL_EVENT = "install";

export interface AntigravitySignInEvent {
  threadId?: string;
  url: string;
}

export interface AntigravityInstallEvent {
  phase: "downloading" | "extracting" | "verifying" | "installed" | "failed";
  downloadedBytes?: number;
  totalBytes?: number;
  message?: string;
}
