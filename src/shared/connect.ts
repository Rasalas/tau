export interface ConnectStatus { phase: "disabled" | "connecting" | "connected" | "offline"; relay?: string; id?: string; detail?: string }
export interface ConnectSetup { relay: string; enrollmentToken: string }
