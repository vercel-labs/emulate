import type { Context } from "hono";

export interface PaginationParams {
  page: number;
  per_page: number;
}

export function parsePagination(c: Context): PaginationParams {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const per_page = Math.min(100, Math.max(1, parseInt(c.req.query("per_page") ?? "30", 10) || 30));
  return { page, per_page };
}

export function setLinkHeader(
  c: Context,
  totalCount: number,
  page: number,
  perPage: number
): void {
  const lastPage = Math.max(1, Math.ceil(totalCount / perPage));
  const baseUrl = new URL(c.req.url);
  const links: string[] = [];

  const makeLink = (p: number, rel: string) => {
    baseUrl.searchParams.set("page", String(p));
    baseUrl.searchParams.set("per_page", String(perPage));
    return `<${baseUrl.toString()}>; rel="${rel}"`;
  };

  if (page < lastPage) {
    links.push(makeLink(page + 1, "next"));
    links.push(makeLink(lastPage, "last"));
  }
  if (page > 1) {
    links.push(makeLink(1, "first"));
    links.push(makeLink(page - 1, "prev"));
  }

  if (links.length > 0) {
    c.header("Link", links.join(", "));
  }
}
