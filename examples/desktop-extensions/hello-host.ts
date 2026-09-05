import type { WorkerHostExtension, WorkerHostExtensionContext } from "tau/host";

/**
 * A minimal host half. Put it beside a `tau-extension.json` that names it as
 * `"host"`, install the folder with `/install ./hello -l` and approve it in
 * Settings. It runs in a worker thread: every service call is a round trip,
 * `electron` is not importable, and a crash here never reaches the workbench.
 *
 * {
 *   "id": "example.hello",
 *   "name": "Hello",
 *   "permissions": ["workspace:read", "process"],
 *   "host": "./hello-host.ts"
 * }
 */
const extension: WorkerHostExtension = {
  id: "example.hello",
  name: "Hello",
  activate(context: WorkerHostExtensionContext) {
    const { services } = context;

    context.registerCommand("where", async () => {
      const cwd = await services.cwd();
      return { cwd, project: await services.projectName(cwd), git: await services.findCommand("git") };
    });

    context.registerCommand("thread", async (input) => {
      const { sessionId } = (input ?? {}) as { sessionId?: string };
      const thread = await services.thread(sessionId);
      // A snapshot, not the live thread: plain facts are all that cross the port.
      return thread ? `${thread.title ?? thread.sessionId} · ${thread.idle ? "idle" : "busy"}` : "no thread is open";
    });

    void services.registerThreadLifecycle({
      beforeWorkspace: async (cwd) => { services.log("hello.workspace", cwd); },
    });

    return () => { services.log("hello.stopped"); };
  },
};

export default extension;
