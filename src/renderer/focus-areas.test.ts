// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { FocusAreaRing } from "./focus-areas";
afterEach(() => { document.body.replaceChildren(); delete document.body.dataset.profile; });
function mount() {
  document.body.innerHTML = `<nav class="session-list" aria-label="Threads"><button class="thread-main" aria-current="page">Thread</button></nav>
    <section class="conversation-column"><div class="transcript" tabindex="-1" aria-label="Conversation"></div><div class="composer-surface"><textarea></textarea><button id="attach">Attach</button></div></section>
    <section class="toast-stack"><div class="toast-item" tabindex="-1">Saved</div><div class="toast-item" tabindex="-1">Done</div></section>
    <section class="stage"><button class="stage-tab" role="tab" aria-selected="true"><span class="stage-tab-label">src/app.ts</span></button></section>`;
  const q = (selector: string) => document.querySelector<HTMLElement>(selector)!;
  return { q, ring: new FocusAreaRing() };
}
describe("workbench area ring", () => {
  it("cycles in the specified order, announces labels and reverses", () => {
    const { q, ring } = mount();
    try {
      q(".thread-main").focus();
      for (const selector of [".transcript", "textarea", ".toast-item", ".stage-tab", ".thread-main"]) {
        expect(ring.move(1)).toBe(true); expect(document.activeElement).toBe(q(selector));
      }
      ring.move(-1); expect(document.activeElement).toBe(q(".stage-tab"));
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("Stage, src/app.ts");
      ring.move(-1); expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("Notifications, 2");
    } finally { ring.dispose(); }
  });
  it("remembers a control and Escape from Notifications returns to it", () => {
    const { q, ring } = mount();
    try {
      q("#attach").focus(); ring.move(1);
      expect(document.activeElement).toBe(q(".toast-item"));
      expect(ring.escapeNotifications()).toBe(true); expect(document.activeElement).toBe(q("#attach"));
      ring.move(-1); ring.move(1); expect(document.activeElement).toBe(q("#attach"));
    } finally { ring.dispose(); }
  });
  it("skips hidden areas, empty notifications and respects dialogs and compact", () => {
    const { q, ring } = mount();
    try {
      q(".toast-stack").replaceChildren(); q(".stage").hidden = true;
      q("textarea").focus(); ring.move(1); expect(document.activeElement).toBe(q(".thread-main"));
      const menu = document.body.appendChild(document.createElement("div")); menu.setAttribute("role", "menu");
      expect(ring.move(1)).toBe(false); expect(document.activeElement).toBe(q(".thread-main"));
      menu.remove(); document.body.dataset.profile = "compact"; expect(ring.move(1)).toBe(false);
    } finally { ring.dispose(); }
  });
  it("cycles within Settings but yields to its nested dialog", () => {
    document.body.innerHTML = '<div class="settings-screen" role="dialog" aria-modal="true"><nav class="settings-nav"><button>Threads</button></nav><main class="settings-main"><h1 class="settings-topbar-title">Threads</h1><input /></main></div>';
    const ring = new FocusAreaRing();
    try {
      document.querySelector("button")!.focus(); ring.move(1); expect(document.activeElement?.tagName).toBe("INPUT");
      ring.move(1); expect(document.activeElement?.tagName).toBe("BUTTON");
      const nested = document.querySelector("main")!.appendChild(document.createElement("div")); nested.setAttribute("role", "dialog");
      expect(ring.move(1)).toBe(false);
    } finally { ring.dispose(); }
  });
  it("uses visible registered extension areas and forgets detached remembered elements", () => {
    const { q, ring: core } = mount(); core.dispose();
    const extra = document.body.appendChild(document.createElement("section"));
    extra.innerHTML = '<button>Extension</button>';
    const ring = new FocusAreaRing(() => [{ id: "extra", order: 60, label: "Extension", root: () => extra }]);
    try {
      extra.querySelector("button")!.focus(); extra.innerHTML = '<button>Replacement</button>';
      q(".stage-tab").focus(); ring.move(1); expect(document.activeElement?.textContent).toBe("Replacement");
      extra.hidden = true; q(".stage-tab").focus(); ring.move(1); expect(document.activeElement).toBe(q(".thread-main"));
    } finally { ring.dispose(); }
  });
});

it("defaults to the active thread even when another thread comes first", () => {
  document.body.innerHTML = '<nav class="session-list" aria-label="Threads"><button class="thread-main">First</button><button class="thread-main" aria-current="page">Active</button></nav>';
  const ring = new FocusAreaRing();
  try { ring.move(1); expect(document.activeElement?.textContent).toBe("Active"); } finally { ring.dispose(); }
});
