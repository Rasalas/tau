// Screen 09: the terminal split in two, then the preview with its element picker.
// Tau's preview draws the page in a native view over its panel, which
// Page.captureScreenshot does not see; T3's page shows in the capture.
// T3 calls its element picker "Annotate preview".
import { createServer } from "node:http";
import { CHROME, probes } from "./probes.mjs";
import { openThread } from "./steps.mjs";

const PROBES = probes(CHROME, {
  tau: { terminal: ".xterm", terminalPane: ".terminal-pane, [class*=terminal-split] > *", panelHeader: ".panel-header, .stage-tabs, [class*=stage-tab]", previewBar: "[class*=preview] input, [class*=preview-address]", previewPanel: "[class*=preview]" },
  t3: { terminal: "aside.thread-terminal-drawer", terminalPane: "aside.thread-terminal-drawer canvas", panelHeader: "[data-slot=tabs-list], [role=tablist]", previewBar: "input[aria-label*=URL i], input[placeholder*=URL i], input[placeholder*=localhost i]", previewPanel: "[data-preview-panel], [aria-label*=Preview]" },
});

const PAGE = `<!doctype html><title>Preview fixture</title><body style="font:16px system-ui;margin:40px"><h1>Preview fixture</h1><p>A page for the element picker.</p><button>Primary action</button></body>`;

async function withServer(fn) {
  const server = createServer((request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(PAGE); });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  try { return await fn(`http://127.0.0.1:${server.address().port}/`); } finally { server.close(); }
}

// Tau's terminal is xterm.js; T3's is ghostty-web on a canvas.
const TERMINAL = { tau: ".xterm", t3: "aside.thread-terminal-drawer canvas" };

async function run(ctx, { shot, note }) {
  const terminal = TERMINAL[ctx.id];
  await openThread(ctx, "Small thread 6");
  await ctx.press("mod+j");
  await ctx.waitFor(`!!document.querySelector(${JSON.stringify(terminal)})`, { timeoutMs: 20_000 });
  await ctx.wait(1_500);
  await ctx.click(terminal);
  await ctx.type("echo terminal fixture");
  await ctx.press("Enter");
  await ctx.wait(500);
  await ctx.press("mod+d");
  await ctx.wait(1_500);
  note("terminals", await ctx.eval(`document.querySelectorAll(${JSON.stringify(terminal)}).length`));
  await ctx.moveMouse(700, 300);
  await shot("terminal-split", { probes: PROBES });
  await ctx.press("mod+j");
  await ctx.wait(600);
  await withServer(async (url) => {
    await ctx.press("mod+shift+j");
    await ctx.wait(1_500);
    const field = await ctx.eval(`(() => {
      const input = [...document.querySelectorAll("input")].find((el) => /url|address|localhost|http/i.test((el.getAttribute("aria-label") ?? "") + (el.placeholder ?? "")));
      if (!input) return null;
      input.focus();
      return input.getAttribute("aria-label") ?? input.placeholder;
    })()`);
    note("previewField", field);
    if (field) {
      await ctx.clearField();
      await ctx.type(url);
      await ctx.press("Enter");
      await ctx.wait(2_000);
    }
    await shot("preview", { probes: PROBES });
    const picker = await ctx.eval(`(() => {
      const button = [...document.querySelectorAll("button")].find((el) => /^(Pick an element|Annotate preview)$/i.test(el.getAttribute("aria-label") ?? ""));
      button?.click();
      return button ? button.getAttribute("aria-label") ?? button.textContent : null;
    })()`);
    note("pickerButton", picker);
    await ctx.wait(800);
    if (picker) await shot("preview-picker", { probes: PROBES });
  });
}

export default { id: "09-terminal-preview", title: "Terminal with a split, preview with the element picker", tau: run, t3: run };
