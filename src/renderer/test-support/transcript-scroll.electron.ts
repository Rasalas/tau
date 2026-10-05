import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

app.setPath("userData", join(process.env.TAU_SCROLL_TEST_HOME!, "userData"));

void app.whenReady().then(async () => {
  try {
    if (process.platform === "darwin") app.setActivationPolicy("accessory");
    const window = new BrowserWindow({
      width: 1000, height: 800, show: false,
      webPreferences: { backgroundThrottling: false },
    });
    const css = await readFile("src/renderer/styles.css", "utf8");
    const tokens = await readFile("src/renderer/tokens.css", "utf8");
    await window.loadURL(`data:text/html,${encodeURIComponent(`
      <style>${tokens}\n${css}</style>
      <div class="transcript-viewport" style="width:620px;height:700px">
        <div class="transcript"><div class="transcript-inner">
          <div class="message-shell assistant"><div class="message assistant">
            <div class="message-text markdown">
              <p>Die Änderungen sind auf main.</p>
              <p><code class="md-file-chip">${"long-file-name-".repeat(100)}</code></p>
              <div class="md-code"><pre><code>${"long_code_".repeat(200)}</code></pre></div>
              <div class="md-table-scroll"><table><tr><td style="white-space:nowrap">${"wide table ".repeat(200)}</td></tr></table></div>
              <p>${"Eine weitere Zeile.<br>".repeat(100)}</p>
            </div>
          </div></div>
        </div></div>
      </div>
    `)}`);
    window.webContents.debugger.attach("1.3");
    const evaluate = (expression: string) => window.webContents.executeJavaScript(expression);
    const wheel = async (selector: string, deltaX: number, deltaY: number) => {
      const { x, y } = await evaluate(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: rect.x + 20, y: rect.y + 10 };
      })()`);
      await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX, deltaY,
      });
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    };
    for (const width of [620, 360, 900]) {
      await evaluate(`(() => {
        document.querySelector('.transcript-viewport').style.width = '${width}px';
        document.querySelector('.transcript').scrollTop = 0;
      })()`);
      const before = await evaluate("document.querySelector('.transcript-inner').getBoundingClientRect().x");
      await wheel(".transcript", 200, 0);
      const after = await evaluate("document.querySelector('.transcript-inner').getBoundingClientRect().x");
      assert.equal(after, before, `horizontal wheel shifted the transcript at ${width}px`);
      assert.equal(await evaluate("document.querySelector('.transcript').scrollLeft"), 0);
      for (const selector of [".md-code pre", ".md-table-scroll"]) {
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollLeft = 0`);
        await wheel(selector, 120, 0);
        assert.ok(await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollLeft > 0`), `${selector} must still scroll horizontally`);
      }
      await wheel(".transcript", 0, 120);
      assert.ok(await evaluate("document.querySelector('.transcript').scrollTop > 0"), "vertical scrolling must still work");
      console.log(`PASS transcript fixed horizontally, code/table scroll, vertical scroll at ${width}px`);
    }
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
