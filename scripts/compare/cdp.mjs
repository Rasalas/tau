// A small CDP client for the comparison: requests by id, events by method.

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export async function listTargets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

/** Polls the devtools endpoint until a page target matching `accept` exists. */
export async function waitForPage(port, { accept = () => true, timeoutMs = 60_000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const page = (await listTargets(port)).find((target) => target.type === "page" && !target.url.startsWith("devtools") && accept(target));
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await wait(pollMs);
  }
  throw new Error(`no page target on port ${port} within ${timeoutMs} ms${lastError ? ` (${lastError.message})` : ""}`);
}

export async function connect(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolvePromise, rejectPromise) => {
    ws.addEventListener("open", () => resolvePromise());
    ws.addEventListener("error", () => rejectPromise(new Error(`cannot open ${webSocketDebuggerUrl}`)));
  });
  let id = 0;
  const waiting = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (message) => {
    const frame = JSON.parse(message.data);
    if (frame.id !== undefined && waiting.has(frame.id)) {
      const { resolvePromise, rejectPromise } = waiting.get(frame.id);
      waiting.delete(frame.id);
      if (frame.error) rejectPromise(new Error(`${frame.error.message} (${frame.error.code})`));
      else resolvePromise(frame.result);
      return;
    }
    for (const listener of listeners.get(frame.method) ?? []) listener(frame.params);
  });
  const send = (method, params = {}) => new Promise((resolvePromise, rejectPromise) => {
    const messageId = ++id;
    waiting.set(messageId, { resolvePromise, rejectPromise });
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
  const on = (method, listener) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(listener);
    return () => listeners.get(method).delete(listener);
  };
  return { send, on, close: () => ws.close() };
}

/** Evaluates `expression` (may be async) in the page and returns its value. */
export async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    throw new Error(detail.exception?.description ?? detail.text ?? JSON.stringify(detail));
  }
  return result.result?.value;
}

/** Polls `expression` until truthy; returns its value and when it first held (epoch ms, host clock). */
export async function waitFor(session, expression, { timeoutMs = 30_000, pollMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let value;
    try { value = await evaluate(session, expression); } catch { value = undefined; }
    if (value) return { value, at: Date.now() };
    await wait(pollMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${expression.slice(0, 200)}`);
}

export async function click(session, x, y) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await session.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

export async function pressEnter(session) {
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
  await session.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...key });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

export async function insertText(session, text) {
  await session.send("Input.insertText", { text });
}
