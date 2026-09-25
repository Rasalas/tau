import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog, Dialog, errorMessage, type HostExtensionClient, type RegionProps } from "tau";
import {
  ASKPASS_ANSWER_COMMAND, ASKPASS_DONE_EVENT, ASKPASS_PENDING_COMMAND, ASKPASS_QUESTION_EVENT,
  decodeAskpassQuestion, type AskpassQuestion,
} from "./askpass-protocol.js";

/** The questions the host is waiting on, oldest first; the layer draws the first. */
export class AskpassQuestions {
  private questions: AskpassQuestion[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly host: HostExtensionClient) {}

  /** Follows the host's events and fetches what was asked before this window listened. */
  connect(): () => void {
    const offQuestion = this.host.onEvent(ASKPASS_QUESTION_EVENT, (payload) => {
      const question = decodeAskpassQuestion(payload);
      if (question) this.add(question);
    });
    const offDone = this.host.onEvent(ASKPASS_DONE_EVENT, (payload) => this.remove((payload as { id?: string } | undefined)?.id));
    void this.host.invoke(ASKPASS_PENDING_COMMAND).then((pending) => {
      if (Array.isArray(pending)) for (const entry of pending) { const question = decodeAskpassQuestion(entry); if (question) this.add(question); }
    }, () => undefined);
    return () => { offQuestion(); offDone(); };
  }

  answer(id: string, answer: string | undefined): Promise<unknown> {
    this.remove(id);
    return this.host.invoke(ASKPASS_ANSWER_COMMAND, answer === undefined ? { id, cancel: true } : { id, answer });
  }

  getSnapshot = (): AskpassQuestion | undefined => this.questions[0];
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private add(question: AskpassQuestion): void {
    if (this.questions.some((entry) => entry.id === question.id)) return;
    this.set([...this.questions, question]);
  }

  private remove(id: string | undefined): void {
    if (id && this.questions.some((entry) => entry.id === id)) this.set(this.questions.filter((entry) => entry.id !== id));
  }

  private set(questions: AskpassQuestion[]): void {
    this.questions = questions;
    for (const listener of [...this.listeners]) listener();
  }
}

const TITLES: Record<AskpassQuestion["kind"], string> = {
  password: "Server password",
  passphrase: "Key passphrase",
  otp: "Verification code",
  "host-key": "Unknown server",
  confirm: "Confirm",
  other: "Server question",
};

const FIELDS: Partial<Record<AskpassQuestion["kind"], string>> = { password: "Password", passphrase: "Passphrase", otp: "Code" };

function secretMessage(question: AskpassQuestion): string {
  if (question.kind === "password") return `Enter the password for ${question.target}.`;
  if (question.kind === "passphrase") return `Enter the passphrase for ${question.keyPath ?? "the key"} to connect to ${question.target}.`;
  if (question.kind === "otp") return `Enter the one-time code for ${question.target}.`;
  return question.prompt.trim();
}

function SecretDialog({ question, onAnswer }: { question: AskpassQuestion; onAnswer(answer: string | undefined): void }) {
  const [value, setValue] = useState("");
  const retry = question.attempt > 1;
  return (
    <Dialog className="confirm-dialog servers-askpass" label={TITLES[question.kind]} onClose={() => onAnswer(undefined)}>
      <h2>{TITLES[question.kind]}</h2>
      <p>{secretMessage(question)}</p>
      {retry ? <p role="alert">That was not accepted. Try again.</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); onAnswer(value); }}>
        <input
          autoFocus
          type="password"
          autoComplete="off"
          aria-label={FIELDS[question.kind] ?? "Answer"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </form>
      <footer>
        <button type="button" className="text-button" onClick={() => onAnswer(undefined)}>Cancel</button>
        <button type="button" className="primary" onClick={() => onAnswer(value)}>Connect</button>
      </footer>
    </Dialog>
  );
}

function AskpassDialog({ question, onAnswer }: { question: AskpassQuestion; onAnswer(answer: string | undefined): void }) {
  if (question.kind === "host-key") {
    return (
      <ConfirmDialog
        title={TITLES["host-key"]}
        message={<>Tau has not connected to {question.host ?? question.target} before. Connect only if its {question.keyType ?? "host"} key fingerprint is <code className="servers-fingerprint">{question.fingerprint ?? "unknown"}</code></>}
        confirmLabel="Trust and connect"
        onConfirm={() => onAnswer("yes")}
        onCancel={() => onAnswer("no")}
      />
    );
  }
  if (question.kind === "confirm") {
    return <ConfirmDialog title={TITLES.confirm} message={question.prompt.trim()} confirmLabel="Continue" onConfirm={() => onAnswer("yes")} onCancel={() => onAnswer("no")} />;
  }
  return <SecretDialog question={question} onAnswer={onAnswer} />;
}

/** Drawn from a title-bar region, over the whole window, while ssh waits on the user. */
export function createAskpassLayer(questions: AskpassQuestions) {
  return function AskpassLayer({ actions }: RegionProps) {
    const question = useSyncExternalStore(questions.subscribe, questions.getSnapshot, questions.getSnapshot);
    if (!question) return null;
    const onAnswer = (answer: string | undefined) => {
      void questions.answer(question.id, answer).catch((error: unknown) => actions.notify(errorMessage(error)));
    };
    return createPortal(<AskpassDialog key={question.id} question={question} onAnswer={onAnswer} />, document.body);
  };
}
