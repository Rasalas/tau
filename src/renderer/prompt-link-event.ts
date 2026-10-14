export const PROMPT_LINK_EVENT = "tau:open-prompt-link";

/** Only a route check here; the parser loads after the click. */
export const isPromptLinkUrl = (href: string): boolean => /^tau:\/\/new\/?\?/iu.test(href);

export function openPromptLink(href: string): void {
  window.dispatchEvent(new CustomEvent(PROMPT_LINK_EVENT, { detail: href }));
}
