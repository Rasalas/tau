export interface FakeSshServerOptions {
  /** The state folder: keys, ssh_config, known_hosts, root/, home/, calls.log. */
  dir: string;
  /** Loopback only; anything else throws. */
  host?: string;
  port?: number;
  user?: string;
  /** `null` turns password logins off. */
  password?: string | null;
  /** A code asked for by keyboard-interactive after the key or password. */
  otp?: string;
  /** `sftp-server -R`. */
  readOnly?: boolean;
  /** Writes the fresh host key into the state folder's known_hosts. */
  trustHostKey?: boolean;
  sftpServer?: string;
}

export interface FakeSshServer {
  port: number;
  host: string;
  pid: number;
  /** `SHA256:…`, as ssh prints it. */
  fingerprint: string;
  knownHostsLine: string;
  sftpServer: string | null;
  dir: string;
  close(): Promise<void>;
}

export function findSftpServer(env?: NodeJS.ProcessEnv): string | undefined;
export function startFakeSshServer(options: FakeSshServerOptions): Promise<FakeSshServer>;
