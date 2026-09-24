import type { DeviceInfo } from "./native";
import { NativeSocket, type SocketBridge } from "./native-socket";

/**
 * Development builds only (`vite build --mode development`): a socket to
 * `scripts/sim.mjs` on the development machine, which sends expressions to
 * evaluate here — the simulator's stand-in for the desktop's CDP driver. A
 * release build does not contain this module.
 */
export function startAutomation(bridge: SocketBridge, device: DeviceInfo, port: number): void {
  if (!device.virtual) return;
  installHelpers();
  const host = device.platform === "android" ? "10.0.2.2" : "127.0.0.1";
  const connect = () => {
    const socket = new NativeSocket(bridge, `ws://${host}:${port}/`);
    socket.onmessage = (event) => { void answer(socket, String(event.data)); };
    socket.onclose = () => { setTimeout(connect, 2_000); };
  };
  connect();
}

async function answer(socket: NativeSocket, text: string): Promise<void> {
  let request: { id: string; expr: string };
  try { request = JSON.parse(text) as { id: string; expr: string }; } catch { return; }
  let reply: { id: string; result?: unknown; error?: string };
  try {
    // The page's CSP allows `blob:` modules and no eval.
    const source = `const { all, byText, tap, type, sleep, text } = globalThis.__tauAutomation;\nexport default await (async () => (${request.expr}))();`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      const module = await import(/* @vite-ignore */ url) as { default: unknown };
      reply = { id: request.id, result: serializable(module.default) };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    reply = { id: request.id, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  if (socket.readyState === NativeSocket.OPEN) socket.send(JSON.stringify(reply));
}

function serializable(value: unknown): unknown {
  if (value instanceof Element) return `<${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ""}>`;
  try { return JSON.parse(JSON.stringify(value ?? null)) as unknown; } catch { return String(value); }
}

function installHelpers(): void {
  const all = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector));
  const byText = (selector: string, pattern: RegExp) => all(selector).find((element) => pattern.test(element.textContent ?? ""));
  /** A finger's tap: pointer down and up, then the click a touch screen produces. */
  const tap = (element: HTMLElement | undefined | null) => {
    if (!element) throw new Error("Nothing to tap.");
    element.scrollIntoView({ block: "center" });
    const box = element.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, pointerId: 1, pointerType: "touch", isPrimary: true, button: 0 };
    element.dispatchEvent(new PointerEvent("pointerdown", at));
    element.dispatchEvent(new PointerEvent("pointerup", at));
    element.click();
    return true;
  };
  /** Sets a field's value the way React's controlled inputs expect. */
  const type = (element: HTMLInputElement | HTMLTextAreaElement | undefined | null, value: string) => {
    if (!element) throw new Error("No field to type into.");
    element.focus();
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = () => document.body.innerText;
  (globalThis as { __tauAutomation?: unknown }).__tauAutomation = { all, byText, tap, type, sleep, text };
}
