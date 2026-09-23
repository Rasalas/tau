// Code evaluated inside each app's renderer. App-neutral on purpose: the same
// probe measures both, only the selectors in apps.mjs differ.

/** Installs `window.__compareProbe`: rAF intervals, long tasks and first sight of sentinel strings. */
export const INSTALL_PROBE = `(() => {
  if (window.__compareProbe) return true;
  const probe = { recording: false, frames: [], longTasks: [], seen: {}, sentinels: [] };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) probe.longTasks.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ type: "longtask", buffered: true });
  const tick = (now) => { if (probe.recording) probe.frames.push(now); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const check = (text) => {
    if (!text) return;
    for (const sentinel of probe.sentinels) {
      if (probe.seen[sentinel] === undefined && text.includes(sentinel)) probe.seen[sentinel] = performance.now();
    }
  };
  // Only nodes that changed are read, so the observer stays cheap during a stream.
  new MutationObserver((records) => {
    if (probe.sentinels.every((sentinel) => probe.seen[sentinel] !== undefined)) return;
    for (const record of records) {
      if (record.type === "characterData") check(record.target.data);
      else for (const node of record.addedNodes) check(node.textContent);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  window.__compareProbe = probe;
  return true;
})()`;

export const startRecording = (sentinels) => `(() => {
  const probe = window.__compareProbe;
  probe.frames = [];
  probe.seen = {};
  probe.sentinels = ${JSON.stringify(sentinels)};
  probe.startedAt = performance.now();
  probe.recording = true;
  return performance.timeOrigin + probe.startedAt;
})()`;

export const STOP_RECORDING = `(() => {
  const probe = window.__compareProbe;
  probe.recording = false;
  const startedAt = probe.startedAt;
  const stoppedAt = performance.now();
  return {
    timeOrigin: performance.timeOrigin,
    startedAt,
    stoppedAt,
    frames: probe.frames,
    longTasks: probe.longTasks.filter((task) => task.start >= startedAt && task.start <= stoppedAt),
    seen: probe.seen,
  };
})()`;

export const PAINT_TIMINGS = `(() => ({
  timeOrigin: performance.timeOrigin,
  paints: performance.getEntriesByType("paint").map((entry) => ({ name: entry.name, startTime: entry.startTime })),
}))()`;

/** The tallest scrollable element that holds text: the transcript in both apps. */
export const FIND_SCROLLER = `(() => {
  let best;
  for (const element of document.querySelectorAll("*")) {
    const style = getComputedStyle(element);
    if (!/(auto|scroll)/.test(style.overflowY)) continue;
    if (element.scrollHeight < element.clientHeight * 1.5 || element.clientHeight < 200) continue;
    if (!best || element.scrollHeight > best.scrollHeight) best = element;
  }
  if (!best) return null;
  best.setAttribute("data-compare-scroller", "");
  const rect = best.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, scrollHeight: best.scrollHeight, clientHeight: best.clientHeight, scrollTop: best.scrollTop };
})()`;

/**
 * Samples the scroller's centre line every frame while recording; a sample is
 * blank when every probe point hits an element without text.
 */
export const START_BLANK_SAMPLER = `(() => {
  const scroller = document.querySelector("[data-compare-scroller]");
  const sampler = { samples: 0, blank: 0, active: true };
  const rect = scroller.getBoundingClientRect();
  const points = [0.25, 0.5, 0.75].map((fraction) => [rect.left + rect.width / 2, rect.top + rect.height * fraction]);
  const sample = () => {
    if (!sampler.active) return;
    sampler.samples += 1;
    const empty = points.every(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return !hit || hit === scroller || !(hit.textContent || "").trim();
    });
    if (empty) sampler.blank += 1;
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  window.__compareBlank = sampler;
  return true;
})()`;

export const STOP_BLANK_SAMPLER = `(() => {
  const sampler = window.__compareBlank;
  sampler.active = false;
  const scroller = document.querySelector("[data-compare-scroller]");
  return { samples: sampler.samples, blank: sampler.blank, scrollTop: scroller?.scrollTop ?? null, scrollHeight: scroller?.scrollHeight ?? null };
})()`;
