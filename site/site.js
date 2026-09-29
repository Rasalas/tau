// Downloads for the visitor's system, the screenshot viewer and copy buttons on
// code. Device hints only choose what the page shows first; nothing is sent or stored.
(() => {
  const downloads = window.TAU_DOWNLOADS;

  /** "mac", "windows", "linux", "mobile" or undefined. */
  function detectSystem() {
    const nav = navigator;
    const ua = nav.userAgent || "";
    const platform = nav.userAgentData?.platform || nav.platform || "";
    if (/iPhone|iPad|iPod|Android/i.test(ua) || (/Mac/i.test(platform) && nav.maxTouchPoints > 1)) return "mobile";
    if (/Mac/i.test(platform)) return "mac";
    if (/Win/i.test(platform)) return "windows";
    if (/Linux|X11|CrOS/i.test(platform)) return "linux";
    return undefined;
  }

  const hrefOf = (file) => downloads.base + file.file;
  const byId = (id) => downloads.files.find((file) => file.id === id);
  const firstFor = { mac: "mac-arm64", windows: "windows", linux: "linux-deb" };
  const heroLabel = { mac: "Download for Mac", windows: "Download for Windows", linux: "Download for Linux" };

  function showDownloads(system, preferred) {
    const primary = preferred ? byId(preferred) : undefined;
    for (const button of document.querySelectorAll("[data-download]")) {
      const label = button.querySelector("[data-download-label]");
      const note = button.parentElement?.querySelector("[data-download-note]");
      if (primary) {
        button.href = hrefOf(primary);
        label.textContent = heroLabel[system];
        if (note) note.textContent = `${primary.label} · ${primary.kind}`;
      } else if (system === "mobile") {
        button.href = "#download";
        label.textContent = "Get Tau for your computer";
        if (note) note.textContent = "Tau runs on your computer; your phone pairs with it.";
      }
    }
    for (const list of document.querySelectorAll("[data-download-list]")) {
      const ordered = [...downloads.files].sort((a, b) => Number(b.os === system) - Number(a.os === system));
      list.replaceChildren(...ordered.map((file) => {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = hrefOf(file);
        link.className = file.id === preferred ? "download-row is-yours" : "download-row";
        const name = document.createElement("span");
        name.className = "download-name";
        name.textContent = file.label;
        const meta = document.createElement("span");
        meta.className = "download-meta";
        meta.textContent = `${file.detail} · ${file.kind}`;
        link.append(name, meta);
        if (file.id === preferred) {
          const tag = document.createElement("span");
          tag.className = "download-tag";
          tag.textContent = "Your system";
          link.append(tag);
        }
        item.append(link);
        return item;
      }));
    }
    for (const link of document.querySelectorAll("[data-release-notes]")) link.href = downloads.releaseNotes;
  }

  if (downloads) {
    const system = detectSystem();
    showDownloads(system, firstFor[system]);
    // Safari reports every Mac as Intel, so only a browser that knows says so.
    if (system === "mac" && navigator.userAgentData?.getHighEntropyValues) {
      navigator.userAgentData.getHighEntropyValues(["architecture"]).then((hints) => {
        if (hints.architecture === "x86") showDownloads(system, "mac-x64");
      }).catch(() => { /* The Apple silicon build stays first; Intel is listed right below. */ });
    }
  }

  // The screenshot viewer: a modal dialog with the full-size picture; Escape, the button or a click outside closes it.
  const viewer = document.querySelector("[data-viewer]");
  if (viewer && typeof viewer.showModal === "function") {
    const frame = viewer.querySelector("[data-viewer-frame]");
    let opener;
    for (const button of document.querySelectorAll("button[data-zoom]")) {
      button.addEventListener("click", () => {
        const picture = button.querySelector("picture")?.cloneNode(true);
        if (!picture) return;
        for (const node of picture.querySelectorAll("source, img")) node.setAttribute("sizes", "100vw");
        const img = picture.querySelector("img");
        img.removeAttribute("loading");
        frame.replaceChildren(picture);
        viewer.querySelector("[data-viewer-caption]").textContent = img.alt;
        opener = button;
        viewer.showModal();
      });
    }
    viewer.addEventListener("click", (event) => { if (event.target === viewer) viewer.close(); });
    viewer.querySelector(".viewer-close")?.addEventListener("click", () => viewer.close());
    viewer.addEventListener("close", () => { frame.replaceChildren(); opener?.focus(); });
  }

  // Copy buttons on code blocks in the docs.
  if (navigator.clipboard) {
    for (const block of document.querySelectorAll(".doc .code")) {
      const pre = block.querySelector("pre");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy";
      button.textContent = "Copy";
      button.addEventListener("click", () => {
        navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? pre.textContent).then(
          () => { button.textContent = "Copied"; setTimeout(() => { button.textContent = "Copy"; }, 1600); },
          () => { button.textContent = "Select and copy"; },
        );
      });
      block.append(button);
    }
  }
})();
