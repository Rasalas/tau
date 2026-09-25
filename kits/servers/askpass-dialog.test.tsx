// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtensionClient, WorkbenchActions } from "tau";
import { AskpassQuestions, createAskpassLayer } from "./askpass-dialog.js";
import { ASKPASS_ANSWER_COMMAND, ASKPASS_DONE_EVENT, ASKPASS_PENDING_COMMAND, ASKPASS_QUESTION_EVENT, type AskpassQuestion } from "./askpass-protocol.js";

afterEach(cleanup);

function fakeHost(pending: AskpassQuestion[] = []) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const invoked: Array<[string, unknown]> = [];
  const host: HostExtensionClient = {
    invoke: async (command, input) => {
      invoked.push([command, input]);
      return command === ASKPASS_PENDING_COMMAND ? pending : { ok: true };
    },
    onEvent: (name, listener) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    },
  };
  const emit = (name: string, payload: unknown) => act(() => { for (const listener of listeners.get(name) ?? []) listener(payload); });
  return { host, invoked, emit };
}

const question = (extra: Partial<AskpassQuestion> = {}): AskpassQuestion => ({
  id: "q1", kind: "password", target: "tester@127.0.0.1", prompt: "Password: ", attempt: 1, expiresAt: 0, ...extra,
});

const actions = new Proxy({}, { get: () => () => undefined }) as WorkbenchActions;

function mount(questions: AskpassQuestions) {
  const Layer = createAskpassLayer(questions);
  return render(<Layer actions={actions} snapshot={undefined as never} />);
}

describe("the askpass dialog", () => {
  it("asks for a password and sends it only as the command's answer", async () => {
    const { host, invoked, emit } = fakeHost();
    const questions = new AskpassQuestions(host);
    const disconnect = questions.connect();
    mount(questions);
    emit(ASKPASS_QUESTION_EVENT, question());
    const field = await screen.findByLabelText("Password");
    expect(screen.getByText("Enter the password for tester@127.0.0.1.")).toBeTruthy();
    fireEvent.change(field, { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(invoked).toContainEqual([ASKPASS_ANSWER_COMMAND, { id: "q1", answer: "hunter2" }]));
    expect(screen.queryByLabelText("Password")).toBeNull();
    disconnect();
  });

  it("shows the host key's fingerprint and answers yes or no", async () => {
    const { host, invoked, emit } = fakeHost();
    const questions = new AskpassQuestions(host);
    questions.connect();
    mount(questions);
    emit(ASKPASS_QUESTION_EVENT, question({ id: "hk", kind: "host-key", fingerprint: "SHA256:abc", keyType: "ED25519", host: "[127.0.0.1]:2222" }));
    await screen.findByRole("dialog", { name: "Unknown server" });
    expect(screen.getByText("SHA256:abc")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Trust and connect" }));
    await waitFor(() => expect(invoked).toContainEqual([ASKPASS_ANSWER_COMMAND, { id: "hk", answer: "yes" }]));
    emit(ASKPASS_QUESTION_EVENT, question({ id: "hk2", kind: "host-key", fingerprint: "SHA256:def" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(invoked).toContainEqual([ASKPASS_ANSWER_COMMAND, { id: "hk2", answer: "no" }]));
  });

  it("picks up a question asked before the window listened, says when a retry follows a wrong answer, and closes when another window answered", async () => {
    const { host, invoked, emit } = fakeHost([question({ id: "early", kind: "otp", attempt: 2 })]);
    const questions = new AskpassQuestions(host);
    questions.connect();
    mount(questions);
    await screen.findByLabelText("Code");
    expect(screen.getByRole("alert").textContent).toMatch(/not accepted/u);
    emit(ASKPASS_DONE_EVENT, { id: "early" });
    await waitFor(() => expect(screen.queryByLabelText("Code")).toBeNull());
    expect(invoked.filter(([command]) => command === ASKPASS_ANSWER_COMMAND)).toEqual([]);
  });

  it("cancels on Cancel", async () => {
    const { host, invoked, emit } = fakeHost();
    const questions = new AskpassQuestions(host);
    questions.connect();
    mount(questions);
    emit(ASKPASS_QUESTION_EVENT, question({ kind: "passphrase", keyPath: "/k/id" }));
    await screen.findByText("Enter the passphrase for /k/id to connect to tester@127.0.0.1.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(invoked).toContainEqual([ASKPASS_ANSWER_COMMAND, { id: "q1", cancel: true }]));
  });
});
