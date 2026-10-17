/* eslint-disable no-await-in-loop -- Inputs and assertions advance one shared browser page in order. */
import type { BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/** Real CSS invalidation work, independent of the runner's frame rate or CPU. */
export async function verifyTranscriptStyleWork(window: BrowserWindow): Promise<void> {
  const css = (await Promise.all([
    "src/renderer/tokens.css", "src/renderer/styles.css", "kits/workspace/styles.css", "kits/review/styles.css",
  ].map((path) => readFile(path, "utf8")))).join("\n");
  await window.loadURL(`data:text/html,${encodeURIComponent(`
    <style>${css}</style>
    <div class="app-shell"><div class="workbench-center"><main class="conversation-column">
      <header class="thread-header"><div class="thread-heading">Thread</div></header>
      <div class="conversation-thread"><div class="transcript">
        <div class="virtual-transcript"><div class="virtual-transcript-row focused">
          <div class="message-shell assistant"><article class="message assistant"><div class="message-text markdown">
            <p>${"<span>settled text</span>".repeat(3_000)}</p><pre id="growing"></pre>
          </div></article></div>
        </div></div>
      </div></div>
      <div class="conversation-start-screen"><div class="conversation-start-content">
        <div class="conversation-empty"><h1>New thread</h1><div class="workbench-region region-draft-actions">
          <tau-part data-tau-part="region:workspace.fresh-start"></tau-part>
        </div></div>
      </div></div>
      <div class="region-composer-controls workbench-region"></div>
      <div class="region-composer-above workbench-region"></div>
      <div class="region-transcript-footer workbench-region"></div>
      <div class="conversation-composer-host"><textarea></textarea></div>
    </main></div></div>
  `)}`);
  const debuggerApi = window.webContents.debugger;
  const evaluate = (source: string) => window.webContents.executeJavaScript(source);
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const recalculated: number[] = [];
  let finish: (() => void) | undefined;
  const collect = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
    if (method === "Tracing.tracingComplete") finish?.();
    if (method !== "Tracing.dataCollected") return;
    for (const entry of params.value as { name: string; args?: { elementCount?: number } }[]) {
      if (entry.name === "UpdateLayoutTree" && entry.args?.elementCount !== undefined) recalculated.push(entry.args.elementCount);
    }
  };
  debuggerApi.on("message", collect);
  try {
    await debuggerApi.sendCommand("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" });
    await evaluate(`new Promise(resolve => {
      let changes = 0;
      const tick = () => {
        const token = document.createElement('span');
        token.textContent = 'new token';
        document.getElementById('growing').append(token);
        // What navigation does after a commit: make pending style work observable.
        document.querySelector('.transcript').scrollTop;
        if (++changes < 10) requestAnimationFrame(tick);
        else requestAnimationFrame(resolve);
      };
      requestAnimationFrame(tick);
    })`);
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    await debuggerApi.sendCommand("Tracing.end");
    await completed;
  } finally {
    debuggerApi.removeListener("message", collect);
  }
  assert.ok(recalculated.length >= 10, "the probe must observe every streamed DOM change");
  assert.ok(recalculated.every((count) => count < 300), `one token restyled the settled transcript: ${recalculated.join(", ")}`);
  console.log(`PASS streamed style work stays bounded: ${Math.max(...recalculated)} elements, 3000 settled spans`);
  await verifyStyleStates(window);
}

async function verifyStyleStates(window: BrowserWindow): Promise<void> {
  const evaluate = (source: string) => window.webContents.executeJavaScript(source);
  const style = (selector: string, property: string): Promise<string> => evaluate(
    `getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(property)}]`,
  );
  await evaluate(`document.body.innerHTML = ${JSON.stringify(`
    <main class="conversation-column" style="width:800px;height:700px">
      <header class="thread-header">
        <div class="thread-header-lead thread-header-content"><button>Threads</button></div>
        <div class="thread-heading thread-header-content">Thread</div>
        <div class="thread-header-actions thread-header-content">Actions</div>
        <div class="thread-header-tools thread-header-content">Tools</div>
      </header>
      <div class="conversation-thread"><div class="transcript" style="height:200px">
        <button id="before-transcript">Before transcript</button>
        <div class="virtual-transcript" tabindex="0">
          <div id="notice" class="virtual-transcript-row focused"><div class="notice-message">Notice</div></div>
          <div id="assistant" class="virtual-transcript-row"><div class="message-shell assistant"><article class="message assistant">Answer</article></div></div>
          <div id="user" class="virtual-transcript-row"><div class="message-shell user"><article class="message user"><div class="message-text">Prompt</div></article></div></div>
        </div>
      </div></div>
      <section class="conversation-start-screen"><div class="conversation-start-content">
        <div class="conversation-empty">
          <i class="conversation-start-intro">Icon</i><h1 class="conversation-start-intro">New thread</h1><p class="conversation-start-intro">Intro</p>
          <div class="workbench-region region-draft-actions">
            <button class="draft-pill">Project</button>
            <tau-part id="fresh-part"></tau-part><tau-part id="other-part"><button>Other action</button></tau-part>
          </div>
        </div>
      </div></section>
      <div class="conversation-composer-host"><textarea></textarea></div>
    </main>
    <div id="strips"></div>
    <div class="composer-toolbar"><div class="composer-chips" data-trailing-icons></div>
      <button class="send-button send-mode"><svg></svg><span class="send-mode-label">Compact and send</span></button>
    </div>
  `)}`);

  // Native keyboard input sets :focus-visible; clicking the same region clears it.
  await evaluate("document.getElementById('before-transcript').focus()");
  for (const type of ["rawKeyDown", "keyUp"]) {
    await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  }
  assert.equal(await evaluate("document.activeElement.matches('.virtual-transcript:focus-visible')"), true);
  assert.equal(await style(".notice-message", "outlineStyle"), "solid");
  for (const [id, target] of [["assistant", ".message.assistant"], ["user", ".message.user .message-text"]]) {
    await evaluate(`document.querySelector('.focused').classList.remove('focused'); document.getElementById('${id}').classList.add('focused')`);
    assert.equal(await style(target!, "outlineStyle"), "solid");
    assert.equal(await style(`#${id} > .message-shell`, "outlineStyle"), "none");
  }
  for (const selector of ["#before-transcript", ".virtual-transcript"]) {
    const { x, y } = await evaluate(`(() => {const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.x+10,y:r.y+10};})()`);
    assert.equal(await evaluate(`!!document.elementFromPoint(${x},${y})?.closest('${selector}')`), true, "pointer input must hit its target");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  }
  assert.equal(await style(".message.user .message-text", "outlineStyle"), "none");
  console.log("PASS keyboard focus rings on notices and message bodies; pointer focus stays quiet");

  await evaluate("document.querySelector('main').classList.add('conversation-start');document.getElementById('fresh-part').innerHTML='<div class=\"fresh-start\">Fresh install</div>'");
  for (const selector of ["i.conversation-start-intro", "h1.conversation-start-intro", "p.conversation-start-intro", ".draft-pill", "#other-part", ".conversation-composer-host"]) {
    assert.equal(await style(selector, "display"), "none", selector);
  }
  assert.equal(await style(".fresh-start", "display"), "flex");
  assert.equal(await style(".thread-header", "visibility"), "visible", "the header keeps its drag region");
  for (const selector of [".thread-header-lead button", ".thread-heading", ".thread-header-actions", ".thread-header-tools"]) {
    assert.equal(await style(selector, "visibility"), "hidden", selector);
  }
  await evaluate("document.getElementById('fresh-part').replaceChildren()");
  assert.equal(await style("h1.conversation-start-intro", "display"), "block");
  assert.equal(await style(".thread-heading", "visibility"), "visible");
  assert.notEqual(await style(".conversation-composer-host", "display"), "none");
  console.log("PASS fresh install hides the ordinary intro, actions and composer, then restores them");

  for (const last of ["review-pr-strip", "review-pr-strips-fold", "review-pr-strips-scroll"]) {
    await evaluate(`document.getElementById('strips').innerHTML = '<div class="review-thread-outcome"><div class="review-pr-strips"><div class="${last}">PRs</div></div><div class="review-settlement-strip">Settled</div></div>'`);
    assert.equal(await style(`.${last}`, "borderBottomLeftRadius"), "0px");
    assert.equal(await style(`.${last}`, "borderBottomWidth"), "0px");
    if (last !== "review-pr-strips-scroll") {
      await evaluate("document.querySelector('.review-settlement-strip').remove()");
      assert.equal(await style(`.${last}`, "borderBottomWidth"), "1px");
    }
  }
  await evaluate("document.getElementById('strips').innerHTML='<div class=\"review-thread-outcome\"><div class=\"review-pr-strip\">Published</div><div class=\"review-settlement-strip\">Settled</div></div>'");
  assert.equal(await style(".review-pr-strip", "borderBottomWidth"), "0px");
  assert.equal(await style(".send-mode-label", "display"), "none");
  await evaluate("document.querySelector('.send-mode svg').remove()");
  assert.notEqual(await style(".send-mode-label", "display"), "none", "a mode without an icon must keep its label");
  console.log("PASS joined PR strips including folded/scrolling lists; compact send labels retain iconless text");
}
