import { expect, it, vi } from "vitest";
import { HOST_COMMANDS } from "../shared/host-command-contract.js";
import { bindHostCommand } from "./host-command-handler.js";
import { NO_JOB_CONTEXT } from "./host-jobs.js";

function checkHandlerContract() {
  bindHostCommand(HOST_COMMANDS.prompt, async ([text, attachments, sessionId]) => { void text; void attachments; void sessionId; });
  // @ts-expect-error A prompt handler must return void, as its client expects.
  bindHostCommand(HOST_COMMANDS.prompt, async () => "wrong result");
  // @ts-expect-error The handler receives decoded text, never a numeric first parameter.
  bindHostCommand(HOST_COMMANDS.prompt, async ([text]: readonly [number]) => { void text; });
  // @ts-expect-error The new-session handler must return a NewThreadResult.
  bindHostCommand(HOST_COMMANDS["new-session"], async () => undefined);
}
void checkHandlerContract;

it("decodes the declared tuple before invoking a host handler", async () => {
  const handler = vi.fn(async ([session, id, index]: readonly [string, string, number]) => { void session; void id; void index; });
  const method = bindHostCommand(HOST_COMMANDS["move-queued"], handler);
  await expect(method(["thread", "queued", "first"], NO_JOB_CONTEXT)).rejects.toThrow("move-queued: toIndex must be an integer.");
  expect(handler).not.toHaveBeenCalled();
  await method(["thread", "queued", 2], NO_JOB_CONTEXT);
  expect(handler).toHaveBeenCalledWith(["thread", "queued", 2], NO_JOB_CONTEXT);
});
