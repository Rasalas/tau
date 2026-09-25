// Test-only package for smoke:remote-work: exposes sessions.import and
// sessions.send as commands until Remote Work Kit's own ones replace it (H06).
export default {
  id: "test.session-import-probe",
  name: "Session import probe",
  activate(context) {
    context.registerCommand("import", (input) => context.services.sessions.import(input));
    context.registerCommand("send", async (input) => {
      await context.services.sessions.send(input.sessionId, input.text);
      return { sent: true };
    });
  },
};
