import { afterEach, describe, expect, it } from "vitest";
import { replay2, startFakeOpenCode2, textTurn, untilInterrupted, type FakeOpenCode2, type FakeOpenCode2Options } from "./fake-server-v2.js";

type Json = Record<string, any>;

const fakes: FakeOpenCode2[] = [];
const streams: Array<() => void> = [];
afterEach(async () => {
  for (const stop of streams.splice(0)) stop();
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

const PASSWORD = "secret";
const auth = { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` };

async function start(options: FakeOpenCode2Options = {}): Promise<FakeOpenCode2> {
  const fake = await startFakeOpenCode2({ password: PASSWORD, ...options });
  fakes.push(fake);
  return fake;
}

async function call(fake: FakeOpenCode2, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json | undefined }> {
  const response = await fetch(`${fake.url}${path}`, { method, headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Json) : undefined };
}

/** Reads the event stream with plain fetch, the way a client does. */
async function follow(fake: FakeOpenCode2) {
  const controller = new AbortController();
  const response = await fetch(`${fake.url}/api/event`, { headers: auth, signal: controller.signal });
  const events: Json[] = [];
  const comments: string[] = [];
  const waiting: Array<() => void> = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      const reader = response.body!.getReader();
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        buffer += decoder.decode(read.value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith("data: ")) events.push(JSON.parse(block.slice(6)) as Json);
          else if (block.startsWith(":")) comments.push(block);
          for (const wake of waiting.splice(0)) wake();
        }
      }
    } catch { /* aborted */ }
  })();
  streams.push(() => controller.abort());
  const until = async (type: string, from = 0): Promise<Json> => {
    for (;;) {
      const found = events.slice(from).find((event) => event.type === type);
      if (found) return found;
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  };
  return { events, comments, until, types: () => events.map((event) => event.type as string) };
}

async function newSession(fake: FakeOpenCode2, body: Json = {}): Promise<string> {
  const created = await call(fake, "POST", "/api/session", { location: { directory: "/work" }, ...body });
  return created.json!.data.id as string;
}

describe("the fake OpenCode 2 server", () => {
  it("wants the password on /api, names its version, and serves the web UI everywhere else", async () => {
    const fake = await start();
    const bare = await fetch(`${fake.url}/api/info`);
    expect(bare.status).toBe(401);
    expect(await bare.json()).toEqual({ _tag: "UnauthorizedError", message: "Authentication required" });
    expect((await fetch(`${fake.url}/api/info`, { headers: { authorization: `Basic ${Buffer.from("opencode:wrong").toString("base64")}` } })).status).toBe(401);
    expect((await call(fake, "GET", "/api/info")).json).toMatchObject({ version: "2.0.26", paths: { tmp: "/tmp" }, capabilities: { persistentPty: true } });
    const html = await fetch(`${fake.url}/global/health`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html");
    expect((await call(fake, "GET", "/api/nope")).status).toBe(404);
    expect((await start({ version: "2.1.0" }).then((other) => call(other, "GET", "/api/info"))).json?.version).toBe("2.1.0");
  });

  it("creates, reads, renames and lists sessions, a page at a time", async () => {
    const fake = await start();
    const events = await follow(fake);
    const child = await newSession(fake, { title: "parent", permissions: [{ action: "*", resource: "*", effect: "ask" }], model: { id: "space-bunny-free", providerID: "opencode", variant: "high" } });
    const root = await newSession(fake, { title: "second", parentID: child });
    await newSession(fake, { location: { directory: "/other" } });
    expect(fake.requests[1]).toMatchObject({ method: "POST", path: "/api/session", body: { title: "parent" } });
    expect((await call(fake, "GET", `/api/session/${child}`)).json!.data).toMatchObject({
      id: child, title: "parent", location: { directory: "/work" }, cost: 0, tokens: { input: 0, cache: { read: 0, write: 0 } },
      model: { id: "space-bunny-free", providerID: "opencode", variant: "high" }, permissions: [{ action: "*", resource: "*", effect: "ask" }],
    });
    expect((await call(fake, "GET", "/api/session/ses_nope")).json).toMatchObject({ _tag: "SessionNotFoundError" });

    expect((await call(fake, "PATCH", `/api/session/${child}`, { title: "renamed" })).status).toBe(204);
    await events.until("session.renamed");
    expect(events.events.find((event) => event.type === "session.renamed")).toMatchObject({ location: { directory: "/work" }, data: { sessionID: child, title: "renamed" } });
    expect((await call(fake, "POST", `/api/session/${child}/model`, { model: { id: "gpt-5.5", providerID: "github-copilot" } })).status).toBe(204);
    expect((await call(fake, "POST", `/api/session/${child}/agent`, { agent: "plan" })).status).toBe(204);
    await events.until("session.agent.selected");
    expect(fake.sessions.get(child)).toMatchObject({ title: "renamed", agent: "plan", model: { id: "gpt-5.5" } });

    const all = (await call(fake, "GET", "/api/session")).json!;
    expect(all.data).toHaveLength(3);
    const here = (await call(fake, "GET", "/api/session?directory=/work&parentID=null")).json!;
    expect(here.data.map((session: Json) => session.id)).toEqual([child]);
    expect((await call(fake, "GET", `/api/session?parentID=${child}`)).json!.data.map((session: Json) => session.id)).toEqual([root]);

    const first = (await call(fake, "GET", "/api/session?limit=2")).json!;
    expect(first.data).toHaveLength(2);
    expect(typeof first.cursor.next).toBe("string");
    const second = (await call(fake, "GET", `/api/session?limit=2&cursor=${first.cursor.next}`)).json!;
    expect(second.data).toHaveLength(1);
    expect(new Set([...first.data, ...second.data].map((session: Json) => session.id)).size).toBe(3);
    const empty = (await call(fake, "GET", `/api/session?limit=2&cursor=${second.cursor.next}`)).json!;
    expect(empty).toEqual({ data: [], cursor: { previous: expect.any(String), next: null } });
    expect((await call(fake, "GET", "/api/session/active")).json).toEqual({ data: {} });
  });

  it("runs textTurn in the order the real server sends it, and keeps the messages", async () => {
    const fake = await start({ script: textTurn("pong", { tokens: { input: 10, output: 2 } }) });
    const events = await follow(fake);
    const id = await newSession(fake);
    const prompt = await call(fake, "POST", `/api/session/${id}/prompt`, { text: "ping" });
    expect(prompt.json!.data).toMatchObject({ sessionID: id, type: "user", payload: { text: "ping" }, delivery: "steer" });
    await events.until("session.execution.succeeded");

    expect(events.types().filter((type) => type !== "session.created")).toEqual([
      "server.connected", "session.inbox.enqueued", "session.execution.started", "session.inbox.delivered", "session.step.started",
      "session.text.started", "session.text.delta", "session.text.ended", "session.step.streamed", "session.step.ended",
      "session.usage.updated", "session.execution.succeeded",
    ]);
    expect(events.comments).toEqual([": heartbeat"]);
    const byType = (type: string) => events.events.find((event) => event.type === type)!;
    expect(byType("session.inbox.enqueued")).toMatchObject({ location: { directory: "/work" }, data: { inboxID: prompt.json!.data.id, sessionID: id, item: { type: "user", payload: { text: "ping" }, delivery: "steer" } } });
    expect(byType("session.execution.started").location).toBeUndefined();
    expect(byType("session.usage.updated").location).toBeUndefined();
    expect(byType("session.step.started").data).toMatchObject({ agent: "build", model: { id: "space-bunny-free", providerID: "opencode", variant: "default" } });
    expect(byType("session.step.started").data.assistantMessageID).toBe(byType("session.text.delta").data.assistantMessageID);
    expect(byType("session.text.delta").data).toMatchObject({ ordinal: 0, delta: "pong" });
    expect(byType("session.execution.succeeded").id).toMatch(/^evt_/u);

    // A second turn adds to the running totals.
    await call(fake, "POST", `/api/session/${id}/prompt`, { text: "again" });
    await events.until("session.execution.succeeded", events.events.indexOf(byType("session.execution.succeeded")) + 1);
    expect((await call(fake, "GET", `/api/session/${id}`)).json!.data).toMatchObject({ tokens: { input: 20, output: 4 }, outcome: "succeeded" });

    const listed = (await call(fake, "GET", `/api/session/${id}/message?order=asc`)).json!;
    expect(listed.data.map((message: Json) => message.type)).toEqual(["user", "assistant", "idle", "user", "assistant", "idle"]);
    expect(listed.data[0]).toMatchObject({ text: "ping", id: prompt.json!.data.id });
    expect(listed.data[1]).toMatchObject({ agent: "build", content: [{ type: "text", text: "pong" }], finish: "stop", tokens: { input: 10, output: 2 } });
    expect(listed.data[2]).toMatchObject({ outcome: "succeeded" });
    const newest = (await call(fake, "GET", `/api/session/${id}/message?limit=1`)).json!;
    expect(newest.data[0].type).toBe("idle");
    expect((await call(fake, "GET", `/api/session/${id}/message?type=user&order=asc`)).json!.data.map((message: Json) => message.text)).toEqual(["ping", "again"]);
  });

  it("asks for a permission through the recorded turn and goes on with the client's reply", async () => {
    const fake = await start({ script: replay2("permission") });
    const events = await follow(fake);
    const id = await newSession(fake);
    await call(fake, "POST", `/api/session/${id}/prompt`, { text: "run echo" });
    const asked = await events.until("permission.asked");
    expect(asked.data).toMatchObject({ sessionID: id, action: "shell", resources: ["echo hello"], save: ["echo *"], source: { type: "tool" } });
    expect(asked.data.id).toMatch(/^per_/u);
    expect(asked.data.source.messageID).toBe(events.events.find((event) => event.type === "session.step.started")!.data.assistantMessageID);
    expect((await call(fake, "GET", "/api/permission/request?location[directory]=/work")).json).toEqual({ location: { directory: "/work" }, data: [asked.data] });
    expect(fake.requests.at(-1)!.query).toEqual({ "location[directory]": "/work" });
    expect(events.types()).not.toContain("session.execution.succeeded");

    expect((await call(fake, "POST", `/api/session/${id}/permission/per_unknown/reply`, { decision: "once" })).json).toMatchObject({ _tag: "PermissionNotFoundError" });
    expect((await call(fake, "POST", `/api/session/${id}/permission/${asked.data.id}/reply`, { decision: "once" })).status).toBe(204);
    await events.until("session.execution.succeeded");
    const replied = events.events.filter((event) => event.type === "permission.replied");
    expect(replied).toHaveLength(1);
    expect(replied[0]!.data).toEqual({ sessionID: id, requestID: asked.data.id, reply: "once" });
    expect(events.events.every((event) => !JSON.stringify(event).includes("ses_ed30"))).toBe(true);
    expect((await call(fake, "GET", "/api/permission/request?location[directory]=/work")).json!.data).toEqual([]);
    expect((await call(fake, "GET", `/api/session/${id}/message?order=asc`)).json!.data.map((message: Json) => message.type)).toEqual(["user", "assistant", "assistant", "idle"]);
  });

  it("asks a form question and learns the answer or the cancel", async () => {
    const fake = await start({ script: replay2("question") });
    const events = await follow(fake);
    const id = await newSession(fake);
    await call(fake, "POST", `/api/session/${id}/prompt`, { text: "ask me" });
    const created = await events.until("form.created");
    const form = created.data.form;
    expect(form).toMatchObject({ sessionID: id, metadata: { kind: "question" }, fields: [{ key: "q0", options: [{ value: "Red" }, { value: "Blue" }] }] });
    expect((await call(fake, "GET", "/api/form?location[directory]=/work")).json!.data).toEqual([form]);
    expect((await call(fake, "POST", `/api/session/${id}/form/${form.id}/reply`, { answer: { q0: "Blue" } })).status).toBe(204);
    expect((await events.until("form.replied")).data).toEqual({ id: form.id, sessionID: id, answer: { q0: "Blue" } });
    await events.until("session.execution.succeeded");
    expect(events.types().filter((type) => type.startsWith("form."))).toEqual(["form.created", "form.replied"]);

    const cancelFake = await start({ script: replay2("cancelledQuestion") });
    const cancelEvents = await follow(cancelFake);
    const cancelId = await newSession(cancelFake);
    await call(cancelFake, "POST", `/api/session/${cancelId}/prompt`, { text: "ask me" });
    const cancelForm = (await cancelEvents.until("form.created")).data.form;
    expect((await call(cancelFake, "DELETE", `/api/session/${cancelId}/form/${cancelForm.id}?message=no%20thanks`)).status).toBe(204);
    expect((await cancelEvents.until("form.cancelled")).data).toEqual({ id: cancelForm.id, sessionID: cancelId });
    await cancelEvents.until("session.execution.succeeded");
    expect(cancelEvents.types()).not.toContain("session.agent.selected");
    expect((await call(cancelFake, "DELETE", `/api/session/${cancelId}/form/${cancelForm.id}`)).json).toMatchObject({ _tag: "FormNotFoundError" });
  });

  it("hands a turn the answer in ask()", async () => {
    let answer: unknown;
    const fake = await start({ script: async (turn) => { answer = await turn.ask("form", { form: { title: "t", fields: [] } }); turn.emit("session.execution.succeeded"); } });
    const events = await follow(fake);
    const id = await newSession(fake);
    await call(fake, "POST", `/api/session/${id}/prompt`, { text: "x" });
    const { form } = (await events.until("form.created")).data;
    await call(fake, "DELETE", `/api/session/${id}/form/${form.id}?message=stop`);
    await events.until("session.execution.succeeded");
    expect(answer).toEqual({ cancelled: true, message: "stop" });
  });

  it("interrupts a running turn once and emits nothing after", async () => {
    const fake = await start({ script: untilInterrupted });
    const events = await follow(fake);
    const id = await newSession(fake);
    await call(fake, "POST", `/api/session/${id}/prompt`, { text: "sleep" });
    const called = await events.until("session.tool.called");
    expect(called.data).toMatchObject({ input: { command: "sleep 100" }, executed: false });
    expect((await call(fake, "GET", "/api/session/active")).json).toEqual({ data: { [id]: { type: "running" } } });
    expect((await call(fake, "POST", `/api/session/${id}/interrupt`)).json).toEqual({ interrupted: true });
    const done = await events.until("session.execution.interrupted");
    expect(done.data).toEqual({ sessionID: id, reason: "user" });
    expect(events.events.at(-1)).toBe(done);
    expect((await call(fake, "POST", `/api/session/${id}/interrupt`)).json).toEqual({ interrupted: false });
    expect((await call(fake, "GET", "/api/session/active")).json).toEqual({ data: {} });
    expect((await call(fake, "GET", `/api/session/${id}`)).json!.data.outcome).toBe("interrupted");
    expect((await call(fake, "GET", `/api/session/${id}/message?order=asc`)).json!.data.map((message: Json) => message.type)).toEqual(["user", "assistant", "idle"]);
    expect(events.events.at(-1)).toBe(done);
  });

  it("takes a steer and a queued prompt while the recorded steer turn runs", async () => {
    const fake = await start({ script: replay2("steer") });
    const events = await follow(fake);
    const id = await newSession(fake);
    const first = (await call(fake, "POST", `/api/session/${id}/prompt`, { text: "sleep then done" })).json!.data;
    await events.until("session.tool.progress");
    const steer = (await call(fake, "POST", `/api/session/${id}/prompt`, { text: "add steered", delivery: "steer" })).json!.data;
    const queued = (await call(fake, "POST", `/api/session/${id}/prompt`, { text: "then queued-one", delivery: "queue" })).json!.data;
    await events.until("session.execution.succeeded");
    const enqueued = events.events.filter((event) => event.type === "session.inbox.enqueued").map((event) => [event.data.inboxID, event.data.item.delivery]);
    expect(enqueued).toEqual([[first.id, "steer"], [steer.id, "steer"], [queued.id, "queue"]]);
    expect(events.events.filter((event) => event.type === "session.inbox.delivered").map((event) => event.data.inboxID)).toEqual([first.id, steer.id, queued.id]);
    const messages = (await call(fake, "GET", `/api/session/${id}/message?order=asc`)).json!.data as Json[];
    expect(messages.filter((message) => message.type === "user").map((message) => message.text)).toEqual(["sleep then done", "add steered", "then queued-one"]);
    expect(fake.sessions.get(id)!.pendingPrompts).toEqual([]);
  });

  it("runs the script again for a prompt on an idle session", async () => {
    const fake = await start({ script: textTurn("again") });
    const events = await follow(fake);
    const id = await newSession(fake);
    await call(fake, "POST", `/api/session/${id}/prompt`, { text: "one" });
    await events.until("session.execution.succeeded");
    const seen = events.events.length;
    await call(fake, "POST", `/api/session/${id}/prompt`, { text: "two" });
    expect((await events.until("session.execution.succeeded", seen)).type).toBe("session.execution.succeeded");
    expect(events.types().filter((type) => type === "session.execution.started")).toHaveLength(2);
  });

  it("serves the catalog, config, MCP and instruction entries", async () => {
    const fake = await start({ defaultModel: "opencode/exo-free", mcp: [{ name: "tau", status: { status: "connected" } }] });
    const where = "?location[directory]=/work";
    const providers = (await call(fake, "GET", `/api/provider${where}`)).json!;
    expect(providers.location).toEqual({ directory: "/work" });
    expect(providers.data.map((provider: Json) => provider.id)).toEqual(["opencode", "github-copilot"]);
    const models = (await call(fake, "GET", `/api/model${where}`)).json!.data as Json[];
    expect(models.find((model) => model.id === "space-bunny-free")!.variants.map((variant: Json) => variant.id)).toEqual(["low", "medium", "high"]);
    expect(models.filter((model) => model.status === "deprecated")).toHaveLength(1);
    expect(models.find((model) => model.providerID === "github-copilot")!.cost[0].input).toBeGreaterThan(0);
    expect((await call(fake, "GET", `/api/model/default${where}`)).json!.data.id).toBe("exo-free");
    expect((await call(fake, "GET", `/api/agent${where}`)).json!.data.map((agent: Json) => agent.id)).toEqual(["build", "plan", "general"]);
    expect(Array.isArray((await call(fake, "GET", `/api/config${where}`)).json)).toBe(true);
    expect((await call(fake, "GET", `/api/mcp${where}`)).json!.data).toEqual([{ name: "tau", status: { status: "connected" } }]);

    const id = await newSession(fake);
    const entries = `/api/experimental/session/${id}/instructions/entries`;
    expect((await call(fake, "PUT", `${entries}/plan`, { value: "be brief" })).status).toBe(204);
    expect((await call(fake, "GET", entries)).json).toEqual({ data: [{ key: "plan", value: "be brief" }] });
    expect((await call(fake, "DELETE", `${entries}/plan`)).status).toBe(204);
    expect((await call(fake, "GET", entries)).json).toEqual({ data: [] });
    expect(fake.listeners).toBe(0);
  });
});
