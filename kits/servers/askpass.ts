import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  ASKPASS_DONE_EVENT, ASKPASS_QUESTION_EVENT, type AskpassKind, type AskpassQuestion,
} from "./askpass-protocol.js";
import { ensureControlDir } from "./ssh-target.js";

/*
 * The askpass bridge: ssh runs `SSH_ASKPASS` for every question (password,
 * passphrase, one-time code, unknown host key). That helper is a script the
 * kit writes into its state folder; it hands ssh's prompt to this process over
 * a Unix socket, with the token of the ssh call it belongs to, and prints the
 * answer for ssh. No answer is ever in argv, the environment or a file.
 */

export interface AskpassTarget {
  id: string;
  /** How a dialog names the target. */
  label: string;
}

export interface AskpassRequest {
  kind: AskpassKind;
  prompt: string;
  target: AskpassTarget;
  fingerprint?: string;
  keyType?: string;
  host?: string;
  keyPath?: string;
  /** Per ssh call and kind; 2 and up means the answer before was refused. */
  attempt: number;
  /** Aborts when ssh gave up on the question or the call ended. */
  signal: AbortSignal;
}

/**
 * Where answers come from, asked in order. A string answers, `null` refuses
 * (ssh sees a cancel), `undefined` passes to the next source. The credentials
 * ticket plugs its keychain and command sources in ahead of the dialog.
 */
export interface CredentialSource {
  answer(request: AskpassRequest): Promise<string | null | undefined>;
}

/** Reads ssh's prompt; the wording is OpenSSH's (sshconnect.c, sshconnect2.c). */
export function classifyPrompt(prompt: string): Pick<AskpassRequest, "kind" | "fingerprint" | "keyType" | "host" | "keyPath"> {
  if (/authenticity of host/iu.test(prompt)) {
    const fingerprint = /\b(SHA256:[A-Za-z0-9+/=]+|MD5(?::[0-9a-f]{2}){16})/u.exec(prompt)?.[1];
    const keyType = /\b([A-Z0-9-]+) key fingerprint is/u.exec(prompt)?.[1];
    const host = /authenticity of host '([^' ]+)/iu.exec(prompt)?.[1];
    return { kind: "host-key", ...(fingerprint ? { fingerprint } : {}), ...(keyType ? { keyType } : {}), ...(host ? { host } : {}) };
  }
  if (/\(yes\/no(\/\[fingerprint\])?\)\??\s*$/iu.test(prompt)) return { kind: "confirm" };
  if (/passphrase/iu.test(prompt)) {
    const keyPath = /for key '([^']+)'/iu.exec(prompt)?.[1];
    return { kind: "passphrase", ...(keyPath ? { keyPath } : {}) };
  }
  if (/verification code|one-time|\botp\b|\btoken\b|authenticator|\bcode\b/iu.test(prompt)) return { kind: "otp" };
  if (/password/iu.test(prompt)) return { kind: "password" };
  return { kind: "other" };
}

/** Runs under the host's own binary (`ELECTRON_RUN_AS_NODE`), written to the state folder at start. */
const CLIENT_SOURCE = `"use strict";
const net = require("node:net");
const socket = process.env.TAU_ASKPASS_SOCKET;
const token = process.env.TAU_ASKPASS_TOKEN;
if (!socket || !token) process.exit(1);
let buffer = "";
let done = false;
const connection = net.connect(socket, () => {
  connection.write(JSON.stringify({ token, prompt: process.argv[2] || "" }) + "\\n");
});
connection.setEncoding("utf8");
connection.on("data", (chunk) => {
  buffer += chunk;
  const end = buffer.indexOf("\\n");
  if (end < 0 || done) return;
  done = true;
  let reply;
  try { reply = JSON.parse(buffer.slice(0, end)); } catch { reply = {}; }
  connection.end();
  if (reply.ok !== true || typeof reply.answer !== "string") process.exit(1);
  process.stdout.write(reply.answer + "\\n", () => process.exit(0));
});
connection.on("error", () => process.exit(1));
connection.on("close", () => { if (!done) process.exit(1); });
`;

const shellWord = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export interface AskpassBridgeOptions {
  /** Where the helper script goes: the kit's state folder. */
  stateDir: string;
  /** Where the socket goes; the owner-checked `<controlRoot>/tau-<uid>` by default (a short path). */
  socketDir?: string;
  /** `/tmp` unless a test names its own. */
  controlRoot?: string;
  sources: readonly CredentialSource[];
  /** The binary the helper runs; the host's own by default. */
  execPath?: string;
  platform?: NodeJS.Platform;
}

interface Session {
  target: AskpassTarget;
  attempts: Map<AskpassKind, number>;
  controller: AbortController;
}

const MAX_REQUEST_BYTES = 64 * 1024;

export class AskpassBridge {
  private server: Server | undefined;
  private socketPath: string | undefined;
  private helperPath: string | undefined;
  private readonly sessions = new Map<string, Session>();
  private starting: Promise<void> | undefined;

  constructor(private readonly options: AskpassBridgeOptions) {}

  start(): Promise<void> {
    this.starting ??= this.listen().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private async listen(): Promise<void> {
    const platform = this.options.platform ?? process.platform;
    const execPath = this.options.execPath ?? process.execPath;
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    const client = join(this.options.stateDir, "askpass-client.cjs");
    await writeFile(client, CLIENT_SOURCE, { mode: 0o600 });
    const suffix = randomBytes(6).toString("hex");
    if (platform === "win32") {
      this.helperPath = join(this.options.stateDir, "askpass.cmd");
      await writeFile(this.helperPath, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" "${client}" %*\r\n`, { mode: 0o700 });
      this.socketPath = `\\\\.\\pipe\\tau-askpass-${suffix}`;
    } else {
      this.helperPath = join(this.options.stateDir, "askpass.sh");
      await writeFile(this.helperPath, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellWord(execPath)} ${shellWord(client)} "$@"\n`, { mode: 0o700 });
      await chmod(this.helperPath, 0o700);
      this.socketPath = join(this.options.socketDir ?? await ensureControlDir(this.options.controlRoot), `askpass-${suffix}.sock`);
    }
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => { server.off("error", reject); resolve(); });
    });
    if (platform !== "win32") await chmod(this.socketPath, 0o600);
    this.server = server;
  }

  /**
   * The environment one ssh call runs with. Its token is good for that call
   * only: `dispose` when ssh exits, and any question still open is cancelled.
   */
  async session(target: AskpassTarget): Promise<{ env: Record<string, string>; dispose(): void }> {
    await this.start();
    const token = randomBytes(24).toString("base64url");
    const session: Session = { target, attempts: new Map(), controller: new AbortController() };
    this.sessions.set(token, session);
    return {
      env: {
        SSH_ASKPASS: this.helperPath!,
        SSH_ASKPASS_REQUIRE: "force",
        // Older OpenSSH only runs askpass with a display set.
        DISPLAY: process.env.DISPLAY || ":0",
        TAU_ASKPASS_SOCKET: this.socketPath!,
        TAU_ASKPASS_TOKEN: token,
      },
      dispose: () => {
        if (this.sessions.get(token) !== session) return;
        this.sessions.delete(token);
        session.controller.abort();
      },
    };
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.controller.abort();
    this.sessions.clear();
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.socketPath && !this.socketPath.startsWith("\\\\")) await rm(this.socketPath, { force: true });
  }

  private serve(socket: Socket): void {
    let buffer = "";
    let handled = false;
    const reply = (answer: string | null) => {
      if (socket.destroyed) return;
      socket.end(`${JSON.stringify(answer === null ? { ok: false } : { ok: true, answer })}\n`);
    };
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) { handled = true; socket.destroy(); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      handled = true;
      let message: { token?: unknown; prompt?: unknown };
      try { message = JSON.parse(buffer.slice(0, end)) as typeof message; } catch { reply(null); return; }
      const session = typeof message.token === "string" ? this.sessions.get(message.token) : undefined;
      if (!session || typeof message.prompt !== "string") { reply(null); return; }
      const request = new AbortController();
      const abort = () => request.abort();
      session.controller.signal.addEventListener("abort", abort, { once: true });
      // The helper is gone when ssh gave up (a timeout, the call was killed).
      socket.once("close", abort);
      void this.ask(session, message.prompt, request.signal)
        .then(reply, () => reply(null))
        .finally(() => session.controller.signal.removeEventListener("abort", abort));
    });
  }

  private async ask(session: Session, prompt: string, signal: AbortSignal): Promise<string | null> {
    const classified = classifyPrompt(prompt);
    const attempt = (session.attempts.get(classified.kind) ?? 0) + 1;
    session.attempts.set(classified.kind, attempt);
    const request: AskpassRequest = { ...classified, prompt, target: session.target, attempt, signal };
    for (const source of this.options.sources) {
      if (signal.aborted) return null;
      const answer = await source.answer(request);
      if (answer === undefined) continue;
      if (answer === null) return null;
      // ssh reads one line; anything after a line break would be lost or misread.
      if (/[\r\n]/u.test(answer)) return null;
      if ((request.kind === "host-key" || request.kind === "confirm") && answer !== "yes" && answer !== "no") return null;
      return answer;
    }
    return null;
  }
}

interface WaitingQuestion {
  question: AskpassQuestion;
  settle(answer: string | null): void;
}

/**
 * The prompt source: every question becomes a dialog in the windows (an
 * `askpass-question` event); the first answer wins. Unanswered after
 * `timeoutMs`, it is cancelled.
 */
export class AskpassDialogs implements CredentialSource {
  private readonly waiting = new Map<string, WaitingQuestion>();

  constructor(
    private readonly emit: (name: string, payload: unknown) => void,
    private readonly timeoutMs = 120_000,
    private readonly now: () => number = Date.now,
  ) {}

  answer(request: AskpassRequest): Promise<string | null> {
    if (request.signal.aborted) return Promise.resolve(null);
    const question: AskpassQuestion = {
      id: randomUUID(),
      kind: request.kind,
      target: request.target.label,
      prompt: request.prompt,
      attempt: request.attempt,
      expiresAt: this.now() + this.timeoutMs,
      ...(request.fingerprint ? { fingerprint: request.fingerprint } : {}),
      ...(request.keyType ? { keyType: request.keyType } : {}),
      ...(request.host ? { host: request.host } : {}),
      ...(request.keyPath ? { keyPath: request.keyPath } : {}),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(null), this.timeoutMs);
      const onAbort = () => settle(null);
      const settle = (answer: string | null) => {
        if (!this.waiting.delete(question.id)) return;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        this.emit(ASKPASS_DONE_EVENT, { id: question.id });
        resolve(answer);
      };
      this.waiting.set(question.id, { question, settle });
      request.signal.addEventListener("abort", onAbort, { once: true });
      this.emit(ASKPASS_QUESTION_EVENT, question);
    });
  }

  /** The `askpass-answer` command. */
  respond(input: unknown): { ok: boolean } {
    const { id, answer, cancel } = (input ?? {}) as { id?: unknown; answer?: unknown; cancel?: unknown };
    const waiting = typeof id === "string" ? this.waiting.get(id) : undefined;
    if (!waiting) return { ok: false };
    if (cancel === true || typeof answer !== "string") waiting.settle(null);
    else waiting.settle(answer);
    return { ok: true };
  }

  pending(): AskpassQuestion[] {
    return [...this.waiting.values()].map((entry) => entry.question);
  }

  cancelAll(): void {
    for (const entry of [...this.waiting.values()]) entry.settle(null);
  }
}
