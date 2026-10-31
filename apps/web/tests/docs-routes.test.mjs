import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import { test } from "node:test";

const base = process.env.DOCS_TEST_URL;
if (!base) throw new Error("Set DOCS_TEST_URL to a running production build.");
const noindex = process.env.DOCS_EXPECT_NOINDEX === "1";
const origin = "https://emulate.dev";
const { pages, redirects } = JSON.parse(
  await readFile(new URL("./fixtures/docs-baseline.json", import.meta.url), "utf8"),
);
const docsPaths = Object.keys(pages).filter((path) => path !== "/");

const get = (path, headers = {}) =>
  fetch(new URL(path, base), {
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
    headers: { "user-agent": "Mozilla/5.0", accept: "text/html", ...headers },
  });
const decode = (value) =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
const meta = (html, key) =>
  decode(html.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`))?.[1] ?? "");
const link = (html, rel) => html.match(new RegExp(`<link rel="${rel}" href="([^"]*)"`))?.[1];
const text = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

for (const [path, expected] of Object.entries(pages)) {
  test(`HTML ${path} keeps its title, social card and headings`, async () => {
    const response = await get(path);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal(decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""), expected.title);
    assert.equal(meta(html, "description"), expected.description);
    assert.equal(meta(html, "og:title"), expected.ogTitle);
    assert.equal(meta(html, "og:image"), `${origin}${expected.ogImage}`);
    assert.equal(link(html, "canonical"), path === "/" ? origin : `${origin}${path}`);
    assert.equal(meta(html, "robots"), noindex ? "noindex, nofollow" : "index, follow");
    const body = text(html);
    for (const heading of expected.headings) assert.ok(body.includes(heading), `missing heading ${heading}`);
  });
}

test("old root slugs redirect permanently to /docs", async () => {
  for (const [from, to] of Object.entries(redirects)) {
    const response = await get(from);
    assert.equal(response.status, 308, from);
    assert.equal(response.headers.get("location"), to, from);
  }
});

test("every docs page has a Markdown twin with canonical frontmatter", async () => {
  for (const path of docsPaths) {
    const response = await get(`${path}.md`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", /^text\/markdown/);
    assert.equal(response.headers.get("link"), `<${origin}${path}>; rel="canonical"`);
    const body = await response.text();
    assert.ok(body.includes(`canonical_url: "${origin}${path}"`), path);
    assert.doesNotMatch(body, /className=/);
  }
  assert.equal((await get("/docs/index.md")).status, 200);
});

test("Markdown keeps import and export lines inside code blocks", async () => {
  const body = await (await get("/docs/nextjs.md")).text();
  assert.ok(body.includes("import { createEmulateHandler } from '@emulators/adapter-next'"));
  assert.ok(body.includes("export const { GET, POST, PUT, PATCH, DELETE, OPTIONS }"));
});

test("docs negotiate Markdown for agents and HTML for browsers", async () => {
  const markdown = await get("/docs/github", { accept: "text/markdown" });
  assert.equal(markdown.status, 200);
  assert.match(markdown.headers.get("content-type") ?? "", /^text\/markdown/);
  const agent = await get("/docs/github", { "user-agent": "ClaudeBot/1.0", accept: "*/*" });
  assert.match(agent.headers.get("content-type") ?? "", /^text\/markdown/);
  const html = await get("/docs/github");
  assert.match(html.headers.get("content-type") ?? "", /^text\/html/);
  for (const response of [markdown, agent, html]) {
    const vary = (response.headers.get("vary") ?? "").toLowerCase();
    for (const token of ["accept", "user-agent", "rsc"]) assert.ok(vary.includes(token), `Vary lacks ${token}`);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("missing pages return 404 in both representations", async () => {
  assert.equal((await get("/docs/missing")).status, 404);
  assert.equal((await get("/missing")).status, 404);
  const markdown = await get("/docs/missing.md");
  assert.equal(markdown.status, 404);
  assert.match(await markdown.text(), /sitemap\.md/);
  assert.equal((await get("/docs/%E0%A4%A")).status, 404);
});

test("/en/docs aliases redirect without the locale and keep the query", async () => {
  const response = await get("/en/docs/github?tab=1");
  assert.equal(response.status, 308);
  const location = new URL(response.headers.get("location") ?? "", base);
  assert.equal(`${location.pathname}${location.search}`, "/docs/github?tab=1");
});

test("every content page is in the docs inventory", async () => {
  const files = (await readdir(new URL("../content/docs/", import.meta.url))).filter((file) => file.endsWith(".mdx"));
  const llms = await (await get("/llms.txt")).text();
  for (const file of files) {
    const path = file === "index.mdx" ? "/docs" : `/docs/${file.slice(0, -4)}`;
    assert.ok(llms.includes(`${origin}${path}.md`), `${file} is missing from lib/docs-navigation.ts`);
  }
});

test("agent indexes list every docs page", async () => {
  const llms = await (await get("/llms.txt")).text();
  const sitemapMarkdown = await (await get("/sitemap.md")).text();
  const sitemap = await (await get("/sitemap.xml")).text();
  for (const path of docsPaths) {
    assert.ok(llms.includes(`${origin}${path}.md`), `llms.txt lacks ${path}`);
    assert.ok(sitemapMarkdown.includes(`(${origin}${path})`), `sitemap.md lacks ${path}`);
    assert.ok(sitemap.includes(`<loc>${origin}${path}</loc>`), `sitemap.xml lacks ${path}`);
  }
  const robots = await (await get("/robots.txt")).text();
  assert.match(robots, noindex ? /Disallow: \// : /Allow: \//);
  assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`));
});

test("search returns page and heading hits", async () => {
  const response = await get("/api/search?query=installation%20token");
  assert.equal(response.status, 200);
  const results = await response.json();
  assert.ok(results.some((result) => result.url === "/docs/github#installation-token-inspection"));
});

test("OG images still render", async () => {
  for (const path of ["/og", "/og/github"]) {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
  }
});
