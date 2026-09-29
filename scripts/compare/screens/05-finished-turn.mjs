// Screen 05: the finished turn: its work group closed and open, a code block, a table.
// No diff card: the replayed turn edits no file (a fileChange item is a follow-up for the fixture).
import { CHROME, TRANSCRIPT, probes } from "./probes.mjs";
import { startTurn, waitTurnDone } from "./steps.mjs";

const PROBES = probes(CHROME, TRANSCRIPT);

/**
 * Scrolls the transcript until an element matching `selector` (and `pattern`)
 * is mounted, then centres it. The reference app virtualizes its timeline, so a row far up is
 * not in the DOM until the list scrolls near it.
 */
export async function reveal(ctx, selector, pattern = ".*", block = "center") {
  for (let step = 0; step < 40; step += 1) {
    const found = await ctx.eval(`(() => {
      const pattern = new RegExp(${JSON.stringify(pattern)}, "u");
      const hits = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => pattern.test(el.textContent.trim()));
      const hit = hits.sort((a, b) => a.textContent.length - b.textContent.length)[0];
      if (hit) { hit.scrollIntoView({ block: ${JSON.stringify(block)} }); return true; }
      const scroller = document.querySelector("[data-compare-scroller]") ?? (() => {
        const best = [...document.querySelectorAll("*")].filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight * 1.5 && el.clientHeight > 300).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
        best?.setAttribute("data-compare-scroller", "");
        return best;
      })();
      if (scroller) scroller.scrollTop -= 500;
      return false;
    })()`);
    if (found) { await ctx.wait(500); return; }
    await ctx.wait(150);
  }
  throw new Error(`reveal: nothing matched ${selector} ${pattern}`);
}

async function run(ctx, { shot }) {
  await startTurn(ctx, "Small thread 4");
  await waitTurnDone(ctx);
  await ctx.wait(1_000);
  await ctx.moveMouse(1300, 120);
  await shot("end", { probes: PROBES });
  const work = ctx.id === "tau" ? [".inline-transcript-activity", "^Worked for"] : ["button, div", "^(Worked for|Ran \\d+ commands?)"];
  await reveal(ctx, work[0], work[1], "start");
  await shot("work-group", { probes: PROBES });
  await ctx.clickText(work[0], new RegExp(work[1], "u"));
  await ctx.wait(600);
  await shot("work-group-open", { probes: PROBES });
  await reveal(ctx, ctx.id === "tau" ? ".md-code" : ".chat-markdown-codeblock");
  await shot("code", { probes: PROBES });
  await reveal(ctx, "table");
  await shot("table", { probes: PROBES });
}

export default { id: "05-finished-turn", title: "A finished turn: work group, code block, table", tau: run, reference: run };
