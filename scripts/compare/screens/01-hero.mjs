// Screen 01: a new thread's start screen (the hero) in a project with history.
import { CHROME, probes } from "./probes.mjs";

const HERO = {
  tau: { hero: ".conversation-start-screen h1, .conversation-start-content h1", projectCard: "button.conversation-start-project" },
  t3: { hero: "main[data-slot=sidebar-inset] h1, main[data-slot=sidebar-inset] h2@What should we build" },
};

export default {
  id: "01-hero",
  title: "New thread: the start screen",
  async tau(ctx, { shot }) {
    await ctx.waitFor(`!!document.querySelector(".conversation-start-screen textarea")`);
    await ctx.moveMouse(900, 820);
    await shot(undefined, { probes: probes(CHROME, HERO), tabs: 6 });
  },
  async t3(ctx, { shot }) {
    await ctx.waitFor(`!!document.querySelector("[data-testid=composer-editor]") && /What should we build/.test(document.body.textContent)`);
    await ctx.moveMouse(900, 820);
    await shot(undefined, { probes: probes(CHROME, HERO), tabs: 6 });
  },
};
