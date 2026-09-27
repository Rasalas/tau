/**
 * The open app page in the address: `?page=<id>`. A link or a push opens a
 * page by it, and the system's back gesture leaves it.
 */
export const PAGE_PARAM = "page";

export function pageFromUrl(href: string): string | undefined {
  return new URL(href).searchParams.get(PAGE_PARAM) || undefined;
}

export function urlWithPage(href: string, page: string | undefined): string {
  const url = new URL(href);
  if (page) url.searchParams.set(PAGE_PARAM, page);
  else url.searchParams.delete(PAGE_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
