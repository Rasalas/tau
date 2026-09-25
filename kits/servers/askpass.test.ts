import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AskpassBridge, AskpassDialogs, classifyPrompt, type AskpassRequest, type CredentialSource } from "./askpass";
import { ASKPASS_DONE_EVENT, ASKPASS_QUESTION_EVENT, type AskpassQuestion } from "./askpass-protocol";
import { runCommand } from "./fixtures/run-command";

const HOST_KEY_PROMPT = [
  "The authenticity of host '[127.0.0.1]:52100 ([127.0.0.1]:52100)' can't be established.",
  "ED25519 key fingerprint is SHA256:Qm9ndXNGaW5nZXJwcmludEZvclRlc3RzT25seTEyMzQ.",
  "This key is not known by any other names.",
  "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
].join("\n");

describe("classifyPrompt", () => {
  it("reads OpenSSH's questions", () => {
    expect(classifyPrompt(HOST_KEY_PROMPT)).toEqual({ kind: "host-key", fingerprint: "SHA256:Qm9ndXNGaW5nZXJwcmludEZvclRlc3RzT25seTEyMzQ", keyType: "ED25519", host: "[127.0.0.1]:52100" });
    expect(classifyPrompt("tester@127.0.0.1's password: ").kind).toBe("password");
    expect(classifyPrompt("(tester@127.0.0.1) Password: ").kind).toBe("password");
    expect(classifyPrompt("Enter passphrase for key '/k/id_ed25519': ")).toEqual({ kind: "passphrase", keyPath: "/k/id_ed25519" });
    expect(classifyPrompt("(tester@127.0.0.1) Verification code: ").kind).toBe("otp");
    expect(classifyPrompt("Warning: the ED25519 host key differs. Continue? (yes/no)? ").kind).toBe("confirm");
    expect(classifyPrompt("Favourite colour: ").kind).toBe("other");
  });
});

const skipOnWindows = process.platform === "win32";

describe.skipIf(skipOnWindows)("AskpassBridge", () => {
  let dir: string;
  let bridge: AskpassBridge;
  let requests: AskpassRequest[];
  let answers: Array<string | null | undefined>;

  const source: CredentialSource = {
    answer: async (request) => {
      requests.push(request);
      return answers.shift();
    },
  };

  const helper = (env: Record<string, string>, prompt: string) => runCommand(env.SSH_ASKPASS!, [prompt], { env: { PATH: process.env.PATH, ...env } });

  beforeEach(async () => {
    dir = mkdtempSync("/tmp/tau-askpass-");
    requests = [];
    answers = [];
    bridge = new AskpassBridge({ stateDir: join(dir, "state"), socketDir: dir, sources: [source] });
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers ssh's question through the helper, with the target and a count per kind", async () => {
    const session = await bridge.session({ id: "site", label: "tester@127.0.0.1" });
    answers.push("s3cret-answer", "again");
    const first = await helper(session.env, "tester@127.0.0.1's password: ");
    expect(first).toMatchObject({ code: 0, stdout: "s3cret-answer\n" });
    const second = await helper(session.env, "tester@127.0.0.1's password: ");
    expect(second.stdout).toBe("again\n");
    expect(requests.map((request) => [request.kind, request.attempt, request.target.id])).toEqual([["password", 1, "site"], ["password", 2, "site"]]);
    session.dispose();
  });

  it("writes the helper 0700 into the state folder and keeps no answer on disk or in the environment", async () => {
    const session = await bridge.session({ id: "site", label: "site" });
    answers.push("never-on-disk-7c1e");
    await helper(session.env, "Password: ");
    expect(statSync(session.env.SSH_ASKPASS!).mode & 0o777).toBe(0o700);
    expect(session.env.SSH_ASKPASS!.startsWith(join(dir, "state"))).toBe(true);
    expect(JSON.stringify(session.env)).not.toContain("never-on-disk");
    for (const name of readdirSync(join(dir, "state"))) expect(readFileSync(join(dir, "state", name), "utf8")).not.toContain("never-on-disk");
    session.dispose();
  });

  it("refuses a token after its call ended, and a made-up one", async () => {
    const session = await bridge.session({ id: "site", label: "site" });
    session.dispose();
    answers.push("x");
    expect((await helper(session.env, "Password: ")).code).toBe(1);
    expect((await helper({ ...session.env, TAU_ASKPASS_TOKEN: "guess" }, "Password: ")).code).toBe(1);
    expect(requests).toHaveLength(0);
  });

  it("passes an undecided source on and cancels when nobody answers", async () => {
    const session = await bridge.session({ id: "site", label: "site" });
    answers.push(undefined);
    expect((await helper(session.env, "Password: ")).code).toBe(1);
    answers.push(null);
    expect((await helper(session.env, "Password: ")).code).toBe(1);
    session.dispose();
  });

  it("allows only yes or no to a host key question, and no line breaks in any answer", async () => {
    const session = await bridge.session({ id: "site", label: "site" });
    answers.push("SHA256:whatever");
    expect((await helper(session.env, HOST_KEY_PROMPT)).code).toBe(1);
    answers.push("yes");
    expect((await helper(session.env, HOST_KEY_PROMPT)).stdout).toBe("yes\n");
    answers.push("two\nlines");
    expect((await helper(session.env, "Password: ")).code).toBe(1);
    session.dispose();
  });

  it("cancels an open question when the call ends", async () => {
    const session = await bridge.session({ id: "site", label: "site" });
    const dialogs = new AskpassDialogs(() => undefined);
    const waiting = new AskpassBridge({ stateDir: join(dir, "state2"), socketDir: dir, sources: [dialogs] });
    const other = await waiting.session({ id: "site", label: "site" });
    const asking = helper(other.env, "Password: ");
    await expect.poll(() => dialogs.pending().length).toBe(1);
    other.dispose();
    expect((await asking).code).toBe(1);
    expect(dialogs.pending()).toHaveLength(0);
    session.dispose();
    await waiting.close();
  });
});

describe("AskpassDialogs", () => {
  const request = (extra: Partial<AskpassRequest> = {}): AskpassRequest => ({
    kind: "password", prompt: "Password: ", target: { id: "t", label: "tester@127.0.0.1" }, attempt: 1, signal: new AbortController().signal, ...extra,
  });

  it("emits a question without secrets and settles on the first answer", async () => {
    const events: Array<[string, unknown]> = [];
    const dialogs = new AskpassDialogs((name, payload) => events.push([name, payload]), 60_000, () => 1000);
    const answering = dialogs.answer(request({ kind: "host-key", fingerprint: "SHA256:abc", host: "[127.0.0.1]:2" }));
    const question = events[0]![1] as AskpassQuestion;
    expect(events[0]![0]).toBe(ASKPASS_QUESTION_EVENT);
    expect(question).toMatchObject({ kind: "host-key", target: "tester@127.0.0.1", fingerprint: "SHA256:abc", host: "[127.0.0.1]:2", attempt: 1, expiresAt: 61_000 });
    expect(dialogs.pending()).toEqual([question]);
    expect(dialogs.respond({ id: question.id, answer: "yes" })).toEqual({ ok: true });
    expect(dialogs.respond({ id: question.id, answer: "yes" })).toEqual({ ok: false });
    expect(await answering).toBe("yes");
    expect(events[1]).toEqual([ASKPASS_DONE_EVENT, { id: question.id }]);
  });

  it("answers a cancel, an abort and a timeout with null", async () => {
    const events: Array<[string, unknown]> = [];
    const dialogs = new AskpassDialogs((name, payload) => events.push([name, payload]), 20);
    const cancelled = dialogs.answer(request());
    dialogs.respond({ id: (events[0]![1] as AskpassQuestion).id, cancel: true });
    expect(await cancelled).toBeNull();
    const controller = new AbortController();
    const aborted = dialogs.answer(request({ signal: controller.signal }));
    controller.abort();
    expect(await aborted).toBeNull();
    expect(await dialogs.answer(request())).toBeNull();
    expect(dialogs.pending()).toHaveLength(0);
  });
});
