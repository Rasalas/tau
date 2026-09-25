export interface FakeFtpServerOptions {
  dir: string;
  /** Loopback only; anything else throws. */
  host?: string;
  port?: number;
  mode?: "plain" | "explicit" | "implicit";
  /** Refuses a login on a control connection that is not encrypted. */
  requireTls?: boolean;
  user?: string;
  password?: string;
}

export interface FakeFtpServer {
  port: number;
  host: string;
  pid: number;
  mode: "plain" | "explicit" | "implicit";
  requireTls: boolean;
  /** The self-signed certificate for 127.0.0.1, or null in plain mode. */
  cert: string | null;
  close(): Promise<unknown>;
}

export function ensureTlsCertificate(dir: string): { cert: string; key: string };
/** In-process; ftp-srv then exits this process on SIGTERM/SIGINT. Tests run the CLI as a child instead. */
export function startFakeFtpServer(options: FakeFtpServerOptions): Promise<FakeFtpServer>;
