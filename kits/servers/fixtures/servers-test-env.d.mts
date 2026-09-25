export const FIXTURES: string;
export const TEST_USER: string;
export const TEST_PASSWORD: string;
export const TEST_PASSPHRASE: string;
export const SSH_ALIAS: string;

export interface ServersPaths {
  dir: string;
  key: string;
  passphraseKey: string;
  sshConfig: string;
  knownHosts: string;
  agentSocket: string;
  agentPid: string;
  sshState: string;
  ftpState: string;
  root: string;
  home: string;
  keychain: string;
  secretTool: string;
  calls: string;
  tls: string;
}

export type CallRecord = { at: string; tool: "ssh" | "ftp" | "security" | "secret-tool"; [key: string]: any };

export interface TestSshAgent {
  pid: number | undefined;
  socket: string;
  /** Whether `stop()` ends it: started by this call, or recorded in `agent.pid` by an earlier one. */
  owned: boolean;
  stop(): void;
  exited: Promise<void>;
}

export function paths(dir: string): ServersPaths;
export function serversStateDir(env?: NodeJS.ProcessEnv): string | undefined;
export function isLoopback(host: string): boolean;
export function assertLoopback(host: string): void;
export function appendCall(dir: string, record: Record<string, unknown>): void;
export function readCalls(dir: string): CallRecord[];
export function renderSshConfig(dir: string, options?: { sshPort?: number }): string;
export function writeSshConfig(dir: string, options?: { sshPort?: number }): void;
export function recordedSshPort(dir: string): number | undefined;
export function prepareServersDir(dir: string): ServersPaths;
export function serversInstanceEnv(dir: string): Record<string, string>;
export function startTestSshAgent(dir: string, options?: { sshAgent?: string; sshAdd?: string }): Promise<TestSshAgent>;
