// These functions run inside the WebView through the existing development bridge.
export function listState() {
  const rows = [...document.querySelectorAll(".touch-browser.home .touch-thread-open")];
  return {
    origin: performance.timeOrigin,
    listPaintMs: performance.getEntriesByName("tau.mobile.list-painted")[0]?.startTime ?? null,
    hostId: new URLSearchParams(location.search).get("host"),
    titles: rows.map((row) => row.querySelector(".thread-title")?.textContent),
    ready: document.visibilityState === "visible" && rows.length > 0 && !document.querySelector(".host-connection-status"),
  };
}

export async function backToList(timeoutMs) {
  if (!document.querySelector(".touch-browser.home")) tap(document.querySelector('button[aria-label="Back to threads"]'));
  const deadline = performance.now() + timeoutMs;
  while (!document.querySelector(".touch-browser.home .touch-thread-open") || document.querySelector(".host-connection-status")) {
    if (performance.now() > deadline) throw new Error("Thread list did not return");
    await sleep(50);
  }
  return true;
}

export async function openThread(target, timeoutMs) {
  const row = [...document.querySelectorAll(".touch-browser.home .touch-thread-open")].find((entry) => entry.querySelector(".thread-title")?.textContent === target.title);
  if (!row || row.disabled) throw new Error("Target row missing or disabled");
  const threadId = row.closest("[data-steady-row]")?.getAttribute("data-steady-row");
  if (!threadId) throw new Error("Target row has no thread id");
  row.scrollIntoView({ block: "center" });
  const inView = (element) => {
    if (!element || !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const box = element.getBoundingClientRect();
    const scroller = element.closest("#thread-transcript");
    const clip = scroller?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
    const left = Math.max(0, box.left, clip.left), right = Math.min(innerWidth, box.right, clip.right);
    const top = Math.max(0, box.top, clip.top), bottom = Math.min(innerHeight, box.bottom, clip.bottom);
    return right > left && bottom > top && element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
  };
  const deadline = performance.now() + timeoutMs;
  while (!inView(row)) {
    if (performance.now() > deadline) throw new Error("Target row is covered or outside the viewport");
    await sleep(50);
  }
  const ready = () => {
    if (document.visibilityState !== "visible" || new URLSearchParams(location.search).get("thread") !== threadId || document.querySelector(".host-connection-status")) return false;
    const composer = document.querySelector("textarea");
    const reply = [...document.querySelectorAll(".message.assistant")].find((entry) => entry.textContent.includes(target.text));
    return inView(composer) && inView(reply);
  };
  const startedAt = performance.now();
  tap(row);
  return new Promise((resolve, reject) => {
    let finished = false;
    let frame;
    const timer = setTimeout(() => {
      finished = true;
      cancelAnimationFrame(frame);
      reject(new Error("Newest reply was not painted in view before timeout"));
    }, timeoutMs);
    const check = () => {
      if (finished) return;
      if (!ready()) { frame = requestAnimationFrame(check); return; }
      frame = requestAnimationFrame(() => setTimeout(() => {
        if (finished) return;
        if (!ready()) { frame = requestAnimationFrame(check); return; }
        finished = true;
        clearTimeout(timer);
        resolve({ ms: performance.now() - startedAt, origin: performance.timeOrigin });
      }, 0));
    };
    check();
  });
}

export function expression(fn, ...args) {
  return `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")})`;
}
