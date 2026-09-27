import type { SubmissionController, SubmissionControllerPorts } from "./submission-controller";
import { loadSubmissionController } from "./deferred-surfaces";

/** Sending is never part of the first paint: the controller's code loads on the first send, or once the window is idle. */
export function deferredSubmission(ports: SubmissionControllerPorts): Pick<SubmissionController, "submit"> {
  let controller: SubmissionController | undefined;
  const create = (module: typeof import("./submission-controller")) => (controller ??= new module.SubmissionController(ports));
  return {
    submit: (input) => {
      const loaded = loadSubmissionController.current;
      return loaded ? create(loaded).submit(input) : loadSubmissionController().then((module) => create(module).submit(input));
    },
  };
}
