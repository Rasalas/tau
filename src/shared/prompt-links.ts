/** External text is only ever placed in a draft, never submitted by a link. */
export const PROMPT_LINK_LIMIT = 8_000;

export interface PromptLink {
  prompt: string;
  hostId?: string;
  project?: string;
  provider?: string;
  model?: string;
  truncated: boolean;
}

export function parsePromptLink(href: string): PromptLink | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return undefined; }
  if (url.protocol !== "tau:" || url.hostname.toLowerCase() !== "new" || url.username || url.password || url.port
    || (url.pathname !== "" && url.pathname !== "/")) return undefined;
  const prompt = url.searchParams.get("prompt");
  if (!prompt?.trim()) return undefined;
  // Do not split a surrogate pair at the limit.
  let text = prompt.slice(0, PROMPT_LINK_LIMIT);
  if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
  const optional = (key: string) => url.searchParams.get(key)?.trim().slice(0, 512) || undefined;
  const hostId = optional("host");
  const project = optional("project");
  const provider = optional("provider");
  const model = optional("model");
  return { prompt: text, truncated: text.length < prompt.length || url.searchParams.get("promptTruncated") === "1",
    ...(hostId ? { hostId } : {}), ...(project ? { project } : {}),
    ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}

/** Carries only draft parameters through the phone's host route. */
export function promptLinkParams(link: PromptLink): URLSearchParams {
  return new URLSearchParams({ prompt: link.prompt, ...(link.project ? { project: link.project } : {}),
    ...(link.provider ? { provider: link.provider } : {}), ...(link.model ? { model: link.model } : {}),
    ...(link.truncated ? { promptTruncated: "1" } : {}) });
}
