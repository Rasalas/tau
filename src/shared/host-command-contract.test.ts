import { describe, expect, it } from "vitest";
import { HOST_COMMANDS, HOST_TRANSPORT_COMMANDS, type HostCommandName, type CommandClient } from "./host-command-contract.js";
import { HOST_CORE_COMMANDS } from "./host-core-commands.js";
import { HOST_FACTORY_COMMANDS } from "./host-factory-commands.js";
import { HOST_TURN_COMMANDS } from "./host-turn-commands.js";
import { attachCommandMetadata, command } from "./host-command-definition.js";
import { HOST_COMMAND_METADATA } from "./host-command-metadata.js";
import type { ClientTurnIdentity } from "./contracts.js";

// These checks must compile. They never send requests at runtime.
function checkClientContract(send: CommandClient<"prompt">, move: CommandClient<"move-queued">, goal: CommandClient<"thread-goal">) {
  void send("hello");
  void send("", [], "thread", "legacy-id");
  const identity: ClientTurnIdentity = { clientMessageId: "message", clientTurnId: "turn" };
  void send("hello", [], "thread", identity);
  // @ts-expect-error Prompt text is a string.
  void send(42);
  // @ts-expect-error A structured identity must include both IDs.
  void send("hello", [], "thread", { clientTurnId: "turn" });
  // @ts-expect-error Queue positions are integers on the wire, never text.
  void move("thread", "queued", "first");
  // @ts-expect-error Goal actions come from the decoder's validated vocabulary.
  void goal("thread", "delete");
  const result: Promise<void> = send("hello");
  // @ts-expect-error Sending a prompt does not return a new thread.
  const newThread: Promise<{ sessionId: string }> = send("hello");
  void result;
  void newThread;
  // @ts-expect-error New command names require a shared declaration.
  const unknownCommand: HostCommandName = "send-prompt-with-typo";
  void unknownCommand;
}
void checkClientContract;

function checkMetadataCoverage() {
  const policy = { sample: { access: "read" } } as const;
  const declaration = command<string>()({ decode: () => [] as const });
  attachCommandMetadata(policy, { sample: declaration });
  // @ts-expect-error Every policy entry needs a decoder declaration.
  attachCommandMetadata(policy, {});
  // @ts-expect-error Decoder declarations cannot introduce unclassified commands.
  attachCommandMetadata(policy, { sample: declaration, extra: declaration });
}
void checkMetadataCoverage;


describe("shared turn command contracts", () => {
  it("attaches the client policy without exposing decoders in the policy catalog", () => {
    expect(Object.keys(HOST_COMMANDS).sort()).toEqual(Object.keys(HOST_COMMAND_METADATA).sort());
    for (const name of Object.keys(HOST_COMMAND_METADATA) as HostCommandName[]) {
      expect(HOST_COMMANDS[name].access).toBe(HOST_COMMAND_METADATA[name].access);
      expect(HOST_COMMANDS[name].job).toBe(HOST_COMMAND_METADATA[name].job);
      expect(HOST_COMMAND_METADATA[name]).not.toHaveProperty("decode");
      expect(HOST_COMMAND_METADATA[name]).not.toHaveProperty("audit");
    }
  });

  it("declares each command exactly once across the catalog groups", () => {
    const names = [HOST_CORE_COMMANDS, HOST_FACTORY_COMMANDS, HOST_TURN_COMMANDS, HOST_TRANSPORT_COMMANDS].flatMap(Object.keys);
    expect(names.length).toBe(new Set(names).size);
  });

  it("keeps positional legacy and structured identities", () => {
    expect(HOST_COMMANDS.prompt.decode(["hello", [], "thread", "legacy"])).toEqual(["hello", [], "thread", "legacy", undefined]);
    const identity = { clientMessageId: "message", clientTurnId: "turn" };
    expect(HOST_COMMANDS.steer.decode(["hello", undefined, "thread", identity])[3]).toEqual(identity);
    expect(HOST_COMMANDS["follow-up"].decode([""])).toEqual(["", undefined, undefined, undefined, undefined]);
  });

  it("preserves validation messages for stale or untrusted clients", () => {
    expect(() => HOST_COMMANDS.prompt.decode([4])).toThrow("prompt: text must be a string");
    expect(() => HOST_COMMANDS["prepare-prompt"].decode(["hello", undefined, undefined, undefined, 4])).toThrow("prepare-prompt: workspace must be a non-empty string");
    expect(() => HOST_COMMANDS["move-queued"].decode(["t", "q", 1.5])).toThrow("move-queued: toIndex must be an integer.");
    expect(() => HOST_COMMANDS["resume-limited"].decode(["t", "later"])).toThrow('resume-limited: "when" must be "now", "reset" or "cancel".');
    expect(() => HOST_COMMANDS["compact-and-send"].decode(["t"])).toThrow("compact-and-send: prompt is required");
  });

  it("accepts planned messages with an empty skill slot and validates their time", () => {
    const at = 1_800_000_000_000;
    expect(HOST_COMMANDS["queue-message"].decode(["thread", "later", [], null, at]))
      .toEqual(["thread", "later", [], undefined, at]);
    expect(HOST_COMMANDS["plan-queued"].decode(["thread", "queued", null]))
      .toEqual(["thread", "queued", undefined]);
    for (const invalid of [0, -1, NaN, Infinity, "tomorrow"]) {
      expect(() => HOST_COMMANDS["queue-message"].decode(["thread", "later", [], null, invalid]))
        .toThrow("deliverAt must be a time in epoch milliseconds.");
      expect(() => HOST_COMMANDS["plan-queued"].decode(["thread", "queued", invalid]))
        .toThrow("deliverAt must be a time in epoch milliseconds.");
    }
  });

  it("declares access, jobs and thread audit positions with the arguments", () => {
    expect(HOST_COMMANDS.prompt).toMatchObject({ access: "write", job: true, audit: { thread: 2 } });
    expect(HOST_COMMANDS["prepare-prompt"]).toMatchObject({ access: "write", audit: { thread: 1, automatic: true } });
    expect(HOST_COMMANDS["new-session"].job).toBe(true);
    expect(HOST_COMMANDS["prepared-thread-capability"].access).toBe("read");
  });
});
