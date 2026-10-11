/**
 * What a sandboxed document is: the policy it is served under, the scripts
 * the host puts ahead of its own, and the limits a client draws it within
 * (ADR 0032). Pure functions, shared by the host that serves the document and
 * the client that frames it.
 */

export const FRAME_MIN_HEIGHT = 80;
export const FRAME_DEFAULT_HEIGHT = 320;
export const FRAME_MAX_HEIGHT = 2000;
/** The largest document a host serves as a frame. */
export const FRAME_MAX_HTML_BYTES = 5 * 1024 * 1024;
/** Posted to the frame whenever the workbench's colour scheme changes: `{ type, scheme }`. */
export const FRAME_SCHEME_MESSAGE = "tau-sandbox-frame:color-scheme";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDomains(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const domains = value
    .filter((domain): domain is string => typeof domain === "string" && domain.length <= MAX_DOMAIN_LENGTH && DOMAIN.test(domain))
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

export function clampFrameHeight(height: number): number {
  if (!Number.isFinite(height)) return FRAME_DEFAULT_HEIGHT;
  return Math.round(Math.min(FRAME_MAX_HEIGHT, Math.max(FRAME_MIN_HEIGHT, height)));
}

/**
 * The policy of a framed document: undeclared origins stay blocked, and nothing
 * loads from the host's own origin (`'self'` would reach its API).
 */
export function frameContentSecurityPolicy(csp: SandboxFrameCsp | undefined): string {
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
  const head = `${meta}${schemeBootstrap(options.colorScheme ?? "light")}${COOKIE_GUARD}`;
  const doctype = /^﻿?\s*<!doctype[^>]*>/iu.exec(html);
  return doctype ? `${doctype[0]}${head}${html.slice(doctype[0].length)}` : `<!doctype html>${head}${html}`;
}
