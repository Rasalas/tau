export const PRIVATE_SECRETS_ID = "tau.private-secrets";
export const MAX_SECRET_BYTES = 65_536;

export interface SecretFileRequest {
  id: string;
  threadId: string;
  label: string;
  reason: string;
  filename: string;
  lifetimeMinutes: number;
  expiresAt: number;
  status: "pending" | "ready" | "declined" | "ended";
  cleanupFailed?: boolean;
  saved?: true;
}

export interface SecretFileBinding {
  secretRef: string;
  path: string;
  expiresAt: number;
}

export interface SecretFilesState {
  canManage: boolean;
  requests: SecretFileRequest[];
}
