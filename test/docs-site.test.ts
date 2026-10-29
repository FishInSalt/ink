import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error The docs site builder is JavaScript without declarations.
import { buildSite, headingSlugs } from "../scripts/build-docs-site.mjs";

const SITE_URL = "https://fishinsalt.github.io/ink";
const BLOG_URL = "https://zheteng-garden.pages.dev/ink/";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

let outDir: string;

beforeAll(async () => {
	outDir = await mkdtemp(join(tmpdir(), "ink-docs-site-"));
	await buildSite({ outDir });
});

afterAll(async () => {
	await rm(outDir, { recursive: true, force: true });
});

function page(relPath: string): Promise<string> {
	return readFile(join(outDir, relPath), "utf8");
}

describe("docs site build", () => {
	it("en home: the language switch points at the zh home (sidebar and article)", async () => {
		const html = await page("index.html");
		expect(html).toContain(
			'<div class="lang"><strong>English</strong> | <a href="zh/index.html">简体中文</a></div>',
		);
		expect(html).toContain('<p><strong>English</strong> | <a href="zh/index.html">简体中文</a></p>');
	});

	it("zh home: the English switch points back at the en home (sidebar and article)", async () => {
		const html = await page("zh/index.html");
		expect(html).toContain(
			'<div class="lang"><a href="../index.html">English</a> | <strong>简体中文</strong></div>',
		);
		expect(html).toContain('<p><a href="../index.html">English</a> | <strong>简体中文</strong></p>');
	});

	it("doc pages carry switcher hrefs both ways", async () => {
		expect(await page("docs/cli.html")).toContain('<a href="../zh/docs/cli.html">简体中文</a>');
		expect(await page("zh/docs/cli.html")).toContain('<a href="../../docs/cli.html">English</a>');
	});

	it("zh cross-file anchors are re-slugged by heading position", async () => {
		const zhSettings = await page("zh/docs/settings.html");
		const match = /href="index\.html#([^"]+)"/.exec(zhSettings);
		const fragment = match?.[1] ?? "";
		const enSlugs = await headingSlugs(await readFile(join(repoRoot, "docs", "index.md"), "utf8"));
		const zhSlugs = await headingSlugs(await readFile(join(repoRoot, "docs", "zh-CN", "index.md"), "utf8"));
		const expected = zhSlugs[enSlugs.indexOf("project-trust")];
		expect(fragment).not.toBe("");
		expect(expected).toBeTruthy();
		expect(fragment).toBe(expected);
	});

	it("keeps the en cross-file anchor unchanged", async () => {
		expect(await page("docs/settings.html")).toContain('href="index.html#project-trust"');
	});

	it("sets the language attribute per page", async () => {
		expect(await page("index.html")).toContain('<html lang="en">');
		expect(await page("zh/index.html")).toContain('<html lang="zh-CN">');
		expect(await page("zh/docs/cli.html")).toContain('<html lang="zh-CN">');
	});

	it("emits hreflang alternates both ways with x-default on en", async () => {
		const enHome = await page("index.html");
		expect(enHome).toContain(`<link rel="alternate" hreflang="zh-CN" href="${SITE_URL}/zh/">`);
		expect(enHome).toContain(`<link rel="alternate" hreflang="x-default" href="${SITE_URL}/">`);
		const zhHome = await page("zh/index.html");
		expect(zhHome).toContain(`<link rel="alternate" hreflang="en" href="${SITE_URL}/">`);
		expect(zhHome).toContain(`<link rel="alternate" hreflang="x-default" href="${SITE_URL}/">`);
	});

	it("sitemap lists all twelve zh URLs", async () => {
		const sitemap = await page("sitemap.xml");
		const zhUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
			.map((match) => match[1] ?? "")
			.filter((url) => url.startsWith(`${SITE_URL}/zh`));
		expect(zhUrls).toHaveLength(12);
		expect(zhUrls).toContain(`${SITE_URL}/zh/`);
		expect(zhUrls).toContain(`${SITE_URL}/zh/docs/cli.html`);
	});

	it("every published page exposes the blog, sitemap and persisted Search Console verification", async () => {
		const siteConfig = JSON.parse(await readFile(join(repoRoot, "scripts", "docs-site-config.json"), "utf8"));
		const token = siteConfig.googleSiteVerification.trim();
		expect(token).not.toBe("");
		const sitemap = await page("sitemap.xml");
		const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? "");
		expect(urls).toHaveLength(24);
		for (const url of urls) {
			const path = url.slice(`${SITE_URL}/`.length);
			const html = await page(path === "" || path.endsWith("/") ? `${path}index.html` : path);
			const head = html.split("</head>")[0] ?? "";
			expect(head).toContain(`<meta name="google-site-verification" content="${token}">`);
			expect(head).toContain(
				`<link rel="sitemap" type="application/xml" title="Sitemap" href="${SITE_URL}/sitemap.xml">`,
			);
			expect(head).toContain(`<link rel="canonical" href="${url}">`);
			expect(html).toContain(`<a href="${BLOG_URL}">`);
		}
	});

	it("home JSON-LD describes the documentation site and source code with accurate product identity", async () => {
		for (const [path, language] of [
			["index.html", "en"],
			["zh/index.html", "zh-CN"],
		]) {
			const html = await page(path ?? "");
			const json = /<script type="application\/ld\+json">([^<]+)<\/script>/.exec(html)?.[1] ?? "";
			const data = JSON.parse(json);
			expect(data["@context"]).toBe("https://schema.org");
			expect(data["@graph"]).toEqual([
				expect.objectContaining({ "@type": "WebSite", name: "Ink", inLanguage: language }),
				expect.objectContaining({
					"@type": "SoftwareSourceCode",
					name: "Ink",
					codeRepository: "https://github.com/FishInSalt/ink",
					programmingLanguage: "TypeScript",
				}),
			]);
			const description = data["@graph"][0].description;
			expect(description).toContain(
				language === "en" ? "AI assistant and agent harness" : "AI 助手与 agent 运行框架",
			);
		}
		expect(await page("docs/cli.html")).not.toContain('type="application/ld+json"');
	});

	it("resolves every emitted href and src on sample pages against the built tree", async () => {
		const samples = ["index.html", "zh/index.html", "docs/cli.html", "zh/docs/settings.html"];
		for (const sample of samples) {
			const html = await page(sample);
			for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
				const target = match[1] ?? "";
				if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("#")) {
					continue;
				}
				const path = target.split(/[#?]/)[0] ?? "";
				if (path === "") continue;
				const resolved = posix.normalize(posix.join(posix.dirname(sample), path));
				expect(resolved.includes("zh/zh"), `${sample}: doubled zh segment in ${target}`).toBe(false);
				expect(existsSync(join(outDir, resolved)), `${sample}: unresolved ${target}`).toBe(true);
			}
		}
	});
});
