import { GUEST_PATH } from "./protocol.js";

// A separate document: no workbench bundles, socket client, Markdown HTML or external resources.
export const guestHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared thread · Tau</title>
<style>:root{color-scheme:light dark;font:15px/1.55 system-ui,sans-serif;background:Canvas;color:CanvasText}body{max-width:760px;margin:auto;padding:24px}header{border-bottom:1px solid GrayText;margin-bottom:24px}h1{font-size:20px}p{overflow-wrap:anywhere;white-space:pre-wrap}article{margin:24px 0}article strong{font-size:12px;color:GrayText}textarea{box-sizing:border-box;width:100%;min-height:100px;font:inherit}button,input{font:inherit}button{padding:8px 16px;margin:8px 0}#status{color:GrayText}#images{display:flex;gap:8px}img{max-width:100px;max-height:100px}form{border-top:1px solid GrayText;padding-top:16px}[hidden]{display:none!important}</style>
<header><h1 id="title">Shared thread</h1><p id="machine"></p></header><p id="status" role="status" aria-live="polite">Connecting…</p><main id="messages" aria-label="Thread messages"></main>
<form id="composer" hidden><label for="text">Suggest a message</label><textarea id="text" maxlength="8000"></textarea><label for="files">Up to 4 images · 10 MB</label><input id="files" type="file" accept="image/png,image/jpeg,image/webp" multiple><div id="images"></div><button id="send" type="submit">Suggest a message</button><p>Nothing you send runs until the owner sends it.</p></form>
<script src="${GUEST_PATH}/client.js" defer></script></html>`;

export const guestScript = String.raw`"use strict";
(() => {
  const path = ${JSON.stringify(GUEST_PATH)};
  const invitation = new URLSearchParams(location.hash.slice(1)).get("guest");
  history.replaceState(null, "", path);
  const byId = (id) => document.getElementById(id);
  let token, joined = false, expiresAt = Infinity, ended = false, pending = false, rendering = "", working = false;
  const status = (text) => { byId("status").textContent = text; };
  async function request(suffix, credential, value) {
    const response = await fetch(path + suffix, { method: value === undefined ? "GET" : "POST", credentials: "omit", cache: "no-store", redirect: "error", headers: { Authorization: "Bearer " + credential, ...(value === undefined ? {} : { "Content-Type": "application/json" }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error); error.status = response.status; throw error; }
    return data;
  }
  const storagePrefix = "tau.guest.browser." + path;
  let storageKey;
  const invitedId = invitation && /^taug\.([a-f0-9]{24})\.[A-Za-z0-9_-]{43}$/.exec(invitation)?.[1];
  const activeId = invitedId || sessionStorage.getItem(storagePrefix);
  if (activeId) { storageKey = storagePrefix + "." + activeId; sessionStorage.setItem(storagePrefix, activeId); }
  async function join() {
    if (invitation) {
      const id = /^taug\.([a-f0-9]{24})\.[A-Za-z0-9_-]{43}$/.exec(invitation)?.[1];
      if (!id) throw new Error("ended");
      const saved = localStorage.getItem(storageKey);
      token = saved && saved.startsWith("taub." + id + ".") ? saved : "taub." + id + "." + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      // Save before claiming; a lost response can be retried by this browser only.
      localStorage.setItem(storageKey, token);
      await request("/claim", invitation, { browserToken: token });
    } else token = localStorage.getItem(storageKey);
    if (!token) throw new Error("ended");
    joined = true;
    await update();
  }
  function fail(error) {
    if ([400, 403, 409].includes(error.status) || error.message === "ended") {
      ended = true; byId("composer").hidden = true; byId("messages").replaceChildren();
      byId("title").textContent = "Shared thread"; byId("machine").textContent = "";
      status(error.message === "claimed" ? "This link is already open in another browser." : "This guest link has ended.");
      if (storageKey) localStorage.removeItem(storageKey);
    } else status("The machine is offline. This page reconnects on its own.");
  }
  async function update() {
    if (ended || working) return;
    working = true;
    try {
      const view = await request("/view", token);
      expiresAt = view.expiresAt;
      byId("title").textContent = view.title;
      byId("machine").textContent = "Shared by " + view.machine;
      const fingerprint = JSON.stringify([view.messages, view.tools]);
      if (fingerprint !== rendering) {
        rendering = fingerprint;
        const rows = view.messages.map((message) => {
          const row = document.createElement("article"), name = document.createElement("strong"), text = document.createElement("p");
          name.textContent = message.role === "user" ? "You" : "Agent";
          text.textContent = message.text; row.append(name, text); return row;
        });
        for (const tool of view.tools) {
          const row = document.createElement("article"), name = document.createElement("strong");
          name.textContent = tool.name + " · " + tool.status; row.append(name);
          if (tool.output) { const text = document.createElement("p"); text.textContent = tool.output; row.append(text); }
          if (tool.outputTruncated) { const note = document.createElement("p"); note.textContent = "Some tool output is omitted."; row.append(note); }
          rows.push(row);
        }
        byId("messages").replaceChildren(...rows);
      }
      pending = view.suggestions.some((s) => s.state === "pending" || s.state === "sending");
      byId("composer").hidden = view.mode !== "suggest";
      byId("send").disabled = pending;
      byId("text").disabled = pending; byId("files").disabled = pending;
      const last = view.suggestions.at(-1);
      status(pending ? "Waiting for the owner to send or dismiss." : last ? last.state === "sent" ? "Sent" : "Dismissed" : view.truncated ? "Some older messages are omitted." : "Following this thread.");
    } catch (error) { fail(error); } finally { working = false; }
  }
  byId("composer").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (ended || pending) return;
    pending = true; byId("send").disabled = true;
    try {
      const files = Array.from(byId("files").files || []);
      if (files.length > 4 || files.reduce((sum, file) => sum + file.size, 0) > 10485760) throw new Error("Choose up to 4 images, at most 10 MB in total.");
      const images = await Promise.all(files.map((file) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = reject; reader.onload = () => resolve({ mimeType: file.type, data: String(reader.result).split(",")[1] }); reader.readAsDataURL(file); })));
      await request("/suggest", token, { text: byId("text").value, images });
      byId("text").value = ""; byId("files").value = ""; status("Waiting for the owner to send or dismiss.");
    } catch (error) { pending = false; byId("send").disabled = false; if (error.status === 403) fail(error); else status(error.message === "pending" ? "Waiting for the owner to send or dismiss." : "Couldn't suggest this message. Check the text and images, then try again."); }
    void update();
  });
  void join().catch(fail);
  const timer = setInterval(() => { if (ended) clearInterval(timer); else if (Date.now() >= expiresAt) fail(Object.assign(new Error("ended"), { status: 403 })); else void (joined ? update() : join().catch(fail)); }, 1500);
})();`;
