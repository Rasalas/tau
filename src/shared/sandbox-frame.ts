/**
 * What a sandboxed document is: the policy it is served under, the scripts
 * the host puts ahead of its own, and the limits a client draws it within
 * (ADR 0032). Pure functions, shared by the host that serves the document and
 * the client that frames it.
 */

import { CODE_KEYS } from "./key-codes.js";

export const FRAME_MIN_HEIGHT = 80;
export const FRAME_DEFAULT_HEIGHT = 320;
export const FRAME_MAX_HEIGHT = 2000;
/** The largest document a host serves as a frame. */
export const FRAME_MAX_HTML_BYTES = 5 * 1024 * 1024;
/** Posted to the frame whenever the workbench's colour scheme changes: `{ type, scheme }`. */
export const FRAME_SCHEME_MESSAGE = "tau-sandbox-frame:color-scheme";
/** Posted to the frame: the chords it may pass on as app shortcuts, `{ type, chords: FrameChord[] }`. */
export const FRAME_KEYS_MESSAGE = "tau-sandbox-frame:keys";
/** Posted by the frame: a key it passes on, `{ type, key, code, metaKey, ctrlKey, shiftKey, altKey, repeat }`. */
export const FRAME_KEYDOWN_MESSAGE = "tau-sandbox-frame:keydown";
/** The most chords a client names to a frame. */
export const FRAME_MAX_CHORDS = 128;

/** A chord as the frame matches it: `key` is lowercase and `mod` is already Meta or Control. */
export interface FrameChord {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** A key a frame passed on; whatever the document claims, so a client checks it before it acts. */
export interface FrameKeyDown {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
}

/** The key a frame's `tau-sandbox-frame:keydown` message names, or nothing for any other message. */
export function readFrameKeyDown(data: unknown): FrameKeyDown | undefined {
  if (!isRecord(data) || data.type !== FRAME_KEYDOWN_MESSAGE) return undefined;
  const { key, code } = data;
  if (typeof key !== "string" || typeof code !== "string" || key.length === 0 || key.length > 32 || code.length > 32) return undefined;
  return {
    key,
    code,
    metaKey: data.metaKey === true,
    ctrlKey: data.ctrlKey === true,
    shiftKey: data.shiftKey === true,
    altKey: data.altKey === true,
    repeat: data.repeat === true,
  };
}

const MAX_DOMAINS = 32;
const MAX_DOMAIN_LENGTH = 256;

/** The origins a document declares it needs, by kind. */
export interface SandboxFrameCsp {
  connectDomains?: readonly string[];
  resourceDomains?: readonly string[];
  frameDomains?: readonly string[];
  baseUriDomains?: readonly string[];
}

/** Browser features a frame may be delegated; each is a user-visible capability. */
export interface SandboxFramePermissions {
  camera?: Record<string, never>;
  microphone?: Record<string, never>;
  geolocation?: Record<string, never>;
  clipboardWrite?: Record<string, never>;
}

export type FrameColorScheme = "light" | "dark";

// Only scheme-qualified origins, optionally with a leading `*.`, survive:
// keywords, paths, quotes or whitespace could widen or break the policy.
const DOMAIN = /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/iu;

function publicOrigin(domain: string): boolean {
  try {
    const host = new URL(domain.replace("://*.", "://")).hostname.toLowerCase();
    if (!host.includes(".") || /\.(?:localhost|local|internal)$/u.test(host)) return false;
    const octets = host.split(".").map(Number);
    if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      const [a, b] = octets as [number, number, number, number];
      return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
    }
    return true;
  } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDomains(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const domains = value
    .filter((domain): domain is string => typeof domain === "string" && domain.length <= MAX_DOMAIN_LENGTH && DOMAIN.test(domain) && publicOrigin(domain))
    .slice(0, MAX_DOMAINS);
  return domains.length === 0 ? undefined : domains;
}

/** The well-formed part of a declared policy, or nothing. */
export function readFrameCsp(value: unknown): SandboxFrameCsp | undefined {
  if (!isRecord(value)) return undefined;
  const csp: Record<string, readonly string[]> = {};
  for (const key of ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"] as const) {
    const domains = readDomains(value[key]);
    if (domains) csp[key] = domains;
  }
  return Object.keys(csp).length === 0 ? undefined : csp as SandboxFrameCsp;
}

const PERMISSION_KEYS = ["camera", "microphone", "geolocation", "clipboardWrite"] as const;

export function readFramePermissions(value: unknown): SandboxFramePermissions | undefined {
  if (!isRecord(value)) return undefined;
  const permissions: Record<string, Record<string, never>> = {};
  for (const key of PERMISSION_KEYS) if (isRecord(value[key])) permissions[key] = {};
  return Object.keys(permissions).length === 0 ? undefined : permissions as SandboxFramePermissions;
}

/** The `allow` attribute for the permissions a document declared; empty for none. */
export function frameAllowAttribute(permissions: SandboxFramePermissions | undefined): string {
  const features: string[] = [];
  if (permissions?.camera) features.push("camera");
  if (permissions?.microphone) features.push("microphone");
  if (permissions?.geolocation) features.push("geolocation");
  if (permissions?.clipboardWrite) features.push("clipboard-write");
  return features.join("; ");
}

/** `min` (API 1.62.0) lets a small part, a bar in a row, go below 80 px; never below 1. */
export function clampFrameHeight(height: number, min = FRAME_MIN_HEIGHT): number {
  if (!Number.isFinite(height)) return FRAME_DEFAULT_HEIGHT;
  return Math.round(Math.min(FRAME_MAX_HEIGHT, Math.max(Math.max(1, min), height)));
}

/**
 * The policy of a framed document: undeclared origins stay blocked, and nothing
 * loads from the host's own origin (`'self'` would reach its API).
 */
export function frameContentSecurityPolicy(csp: SandboxFrameCsp | undefined): string {
  csp = readFrameCsp(csp);
  const resources = csp?.resourceDomains?.join(" ") ?? "";
  const list = (domains: readonly string[] | undefined) => domains?.length ? domains.join(" ") : "'none'";
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`.trim(),
    `style-src 'unsafe-inline' ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    `connect-src ${list(csp?.connectDomains)}`,
    `frame-src ${list(csp?.frameDomains)}`,
    "object-src 'none'",
    `base-uri ${list(csp?.baseUriDomains)}`,
    "form-action 'none'",
  ].join("; ");
}

/**
 * The `Content-Security-Policy` header a framed document is served with: the
 * sandbox (scripts and forms, an opaque origin because `allow-same-origin` is
 * absent) plus the document's own policy. The browser enforces this beside the
 * one in the document, so the document can only narrow it.
 */
export function frameResponsePolicy(csp: SandboxFrameCsp | undefined): string {
  return `sandbox allow-scripts allow-forms; ${frameContentSecurityPolicy(csp)}`;
}

const escapeAttribute = (value: string) => value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");

/**
 * Sets the canvas and native controls to the workbench's scheme before any
 * vendor script reads it, and follows later changes the parent posts. Only the
 * parent window counts as a sender: the origin is opaque, so nothing else can
 * be checked.
 */
function schemeBootstrap(scheme: FrameColorScheme): string {
  return `<script>(function(){var r=document.documentElement;r.style.colorScheme=${JSON.stringify(scheme)};window.addEventListener("message",function(e){if(e.source!==window.parent)return;var m=e.data;if(m&&m.type===${JSON.stringify(FRAME_SCHEME_MESSAGE)}&&(m.scheme==="light"||m.scheme==="dark"))r.style.colorScheme=m.scheme;});})();</script>`;
}

/**
 * Passes on the chords the parent named, so an app shortcut still works once a
 * click gave the keyboard to the document. Only Cmd/Ctrl chords outside a text
 * field, and only if the document's own listeners left the key alone: the
 * deciding listener is added while the key dispatches, so it runs last.
 */
function keysBootstrap(): string {
  const send = `{type:${JSON.stringify(FRAME_KEYDOWN_MESSAGE)},key:e.key,code:c,metaKey:e.metaKey,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey,repeat:e.repeat}`;
  return `<script>(function(){var K=[],C=${JSON.stringify(CODE_KEYS)};`
    + `window.addEventListener("message",function(e){if(e.source!==window.parent)return;var m=e.data;if(m&&m.type===${JSON.stringify(FRAME_KEYS_MESSAGE)}&&Array.isArray(m.chords))K=m.chords;});`
    + `window.addEventListener("keydown",function(e){var t=e.composedPath()[0],c=e.code||"",x=[String(e.key).toLowerCase()],f;`
    + `if(!e.isTrusted||e.isComposing||e.keyCode===229||!(e.metaKey||e.ctrlKey)||!K.length)return;`
    + `if(e.getModifierState&&e.getModifierState("AltGraph")&&!/^[a-z0-9]$/i.test(e.key))return;`
    + `if(t&&(t.isContentEditable||/^(?:INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))return;`
    + `if(C.hasOwnProperty(c))x.push(C[c]);else if(/^Digit\\d$/.test(c))x.push(c.slice(5));`
    + `if(e.altKey&&/^Key[A-Z]$/.test(c))x.push(c.slice(3).toLowerCase());`
    + `if(!K.some(function(s){return s&&s.metaKey===e.metaKey&&s.ctrlKey===e.ctrlKey&&s.shiftKey===e.shiftKey&&s.altKey===e.altKey&&x.indexOf(s.key)>-1;}))return;`
    + `f=function(v){window.removeEventListener("keydown",f);if(v!==e||e.defaultPrevented)return;e.preventDefault();window.parent.postMessage(${send},"*");};`
    + `window.addEventListener("keydown",f);setTimeout(function(){window.removeEventListener("keydown",f);});},true);})();</script>`;
}

/**
 * An opaque document has no cookies, but reading `document.cookie` throws
 * instead of answering an empty string, which analytics libraries do at
 * startup. The guard turns that one case into "no cookies".
 */
const COOKIE_GUARD = `<script>(function(){try{void document.cookie;}catch(e){if(e&&e.name==="SecurityError"){Object.defineProperty(document,"cookie",{configurable:true,get:function(){return "";},set:function(){}});}}})();</script>`;

/**
 * The document as it is served: doctype first (standards mode), then the
 * policy, then the host's scripts, then everything the document wrote. A
 * document without a doctype gets one.
 */
export function prepareFrameDocument(html: string, options: { csp?: SandboxFrameCsp | undefined; colorScheme?: FrameColorScheme }): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(frameContentSecurityPolicy(options.csp))}">`;
  const head = `${meta}${schemeBootstrap(options.colorScheme ?? "light")}${keysBootstrap()}${COOKIE_GUARD}`;
  const doctype = /^﻿?\s*<!doctype[^>]*>/iu.exec(html);
  return doctype ? `${doctype[0]}${head}${html.slice(doctype[0].length)}` : `<!doctype html>${head}${html}`;
}
