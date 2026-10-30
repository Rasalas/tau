export const SHARING_ID = "tau.thread-sharing";
export const GUEST_PATH = "/extensions/tau.thread-sharing/guest";
export const SHARING_EVENT = "changed";
export const LIFETIMES = [1, 8, 24] as const;
export const ADDRESS_REASON = "Guests need a published HTTPS address their browser trusts, such as Tailscale HTTPS under Connections. Tau Connect's WebSocket relay does not serve guest pages. The guest must be able to reach that HTTPS address.";
export interface GuestMessage { role: "user" | "assistant"; text: string }
export interface GuestTool { name: string; status: "running" | "done" | "error"; output?: string; outputTruncated?: true }
export interface GuestImage { mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string }
export interface Suggestion {
  id: string;
  text: string;
  images: GuestImage[];
  state: "pending" | "sending" | "sent" | "dismissed";
}
export interface SharedThread {
  id: string;
  threadId: string;
  title: string;
  expiresAt: number;
  claimed: boolean;
  watching: boolean;
  mode: "watch" | "suggest";
  suggestions: Suggestion[];
}
export interface SharingState { enabled: boolean; owner: boolean; available: boolean; toolOutputThreads?: string[]; links: SharedThread[] }
export interface GuestView {
  title: string;
  machine: string;
  mode: "watch" | "suggest";
  expiresAt: number;
  messages: GuestMessage[];
  tools: GuestTool[];
  truncated: boolean;
  suggestions: Array<Pick<Suggestion, "id" | "state">>;
}
