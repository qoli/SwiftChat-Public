#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const websiteRoot = fileURLToPath(new URL("../", import.meta.url));
const siteUrl = "https://swiftchat.ronniewong.cc";
const canonicalHub = "https://ronniewong.cc";
const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const normalize = (value) => String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
const postUrl = (post) => `${siteUrl}/blog/${encodeURIComponent(post.slug)}/`;
const canonical = (post) => post.canonical?.url || `${canonicalHub}/blog/${encodeURIComponent(post.slug)}/`;
const postDate = (post) => String(post.writtenDate || post.createdTime || "").slice(0, 10);
const plain = (segments = []) => segments.map((segment) => segment.text || "").join("");
const description = (post) => (post.content?.blocks || [])
  .find((block) => block.type === "text" && (block.plainText || plain(block.richText)))?.plainText || post.title;

function richText(segments = []) {
  return segments.map((segment) => {
    let text = escapeHtml(segment.text).replaceAll("\n", "<br>");
    const annotations = segment.annotations || [];
    if (annotations.includes("c")) text = `<code>${text}</code>`;
    if (annotations.includes("b")) text = `<strong>${text}</strong>`;
    if (annotations.includes("i")) text = `<em>${text}</em>`;
    if (annotations.includes("s")) text = `<s>${text}</s>`;
    return segment.href ? `<a href="${escapeHtml(segment.href)}">${text}</a>` : text;
  }).join("");
}

function renderTable(block) {
  const rows = (block.children || []).filter((row) => row.type === "table_row");
  const columns = block.tableColumns?.length ? block.tableColumns : [...new Set(rows.flatMap((row) => Object.keys(row.tableCells || {})))];
  const rowHtml = (row, header) => `<tr>${columns.map((column, index) => {
    const isHeader = header || (block.tableHasRowHeader && index === 0);
    const tag = isHeader ? "th" : "td";
    const scope = isHeader ? ` scope="${header ? "col" : "row"}"` : "";
    return `<${tag}${scope}>${richText(row.tableCells?.[column] || [])}</${tag}>`;
  }).join("")}</tr>`;
  const hasHeader = block.tableHasColumnHeader && rows.length;
  return `<div class="blog-table"><table>${hasHeader ? `<thead>${rowHtml(rows[0], true)}</thead>` : ""}<tbody>${rows.slice(hasHeader ? 1 : 0).map((row) => rowHtml(row, false)).join("")}</tbody></table></div>`;
}

function renderBlock(block) {
  const text = richText(block.richText);
  const children = block.children?.length ? `<div class="blog-block-children">${renderBlocks(block.children)}</div>` : "";
  const heading = { header: "h2", sub_header: "h3", sub_sub_header: "h4" }[block.type];
  if (heading) return `<${heading}>${text}</${heading}>${children}`;
  switch (block.type) {
    case "quote": return `<blockquote>${text}</blockquote>${children}`;
    case "code": return `<pre><code>${escapeHtml(block.plainText || plain(block.richText))}</code></pre>${children}`;
    case "divider": return "<hr>";
    case "image":
    case "video":
    case "file":
    case "external_object_instance": {
      const caption = richText(block.caption);
      const alt = block.plainText || plain(block.caption) || "SwiftChat";
      if (block.assetPath) return `<figure class="blog-media"><img src="/${escapeHtml(block.assetPath)}" alt="${escapeHtml(alt)}" loading="lazy">${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
      return block.source ? `<p><a href="${escapeHtml(block.source)}">${caption || escapeHtml(alt)}</a></p>` : caption;
    }
    case "table": return renderTable(block);
    case "table_row": return "";
    case "page":
    case "collection_view_page": return `<p><a href="https://www.notion.so/${escapeHtml(block.id)}">${text || "Original note"}</a></p>`;
    default: return `${text ? `<p>${text}</p>` : ""}${children}`;
  }
}

function renderBlocks(blocks = []) {
  const result = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === "bulleted_list" || block.type === "numbered_list") {
      const tag = block.type === "bulleted_list" ? "ul" : "ol";
      const items = [];
      while (blocks[index]?.type === block.type) {
        const item = blocks[index];
        items.push(`<li>${richText(item.richText)}${item.children?.length ? renderBlocks(item.children) : ""}</li>`);
        index += 1;
      }
      index -= 1;
      result.push(`<${tag}>${items.join("")}</${tag}>`);
    } else result.push(renderBlock(block));
  }
  return result.join("\n");
}

function shell({ title, summary, canonicalUrl, url = canonicalUrl, type = "website", main, schema, stylesheet }) {
  return `<!doctype html>
<html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(summary)}"><link rel="canonical" href="${escapeHtml(canonicalUrl)}">
<meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(summary)}">
<meta property="og:type" content="${type}"><meta property="og:url" content="${escapeHtml(url)}">
<link rel="icon" href="/assets/icon.png"><link rel="stylesheet" href="${stylesheet}">
<script type="application/ld+json">${JSON.stringify(schema).replaceAll("<", "\\u003c")}</script>
</head><body><a class="skip" href="#main">Skip to content</a>
<header><a class="brand" href="/"><img src="/assets/icon.png" alt="" width="44" height="44">SwiftChat</a>
<nav aria-label="Main navigation"><a href="/blog/" aria-current="page">Blog</a><a href="/changelog.html">Changelog</a><a href="https://github.com/qoli/SwiftChat-Public">GitHub</a><a href="/support.html">Support</a><a href="/privacy.html">Privacy</a></nav></header>
<main id="main" class="document blog">${main}</main>
<footer><span>© 2026 Ronnie Wong · Made for Mac.</span><span>Independent software. Not affiliated with OpenAI.</span></footer>
</body></html>
`;
}

function renderIndex(posts, stylesheet) {
  const summary = "關於 SwiftChat 的開發、功能與使用方式。";
  return shell({
    title: "Blog — SwiftChat", summary, canonicalUrl: `${siteUrl}/blog/`, stylesheet,
    schema: { "@context": "https://schema.org", "@type": "Blog", name: "SwiftChat Blog", url: `${siteUrl}/blog/`, description: summary },
    main: `<div class="blog-heading"><p class="eyebrow">SwiftChat Blog</p><h1>在 Mac 上，聊得更順手。</h1><p class="lede">${summary}</p></div>
<section aria-label="Articles">${posts.length ? posts.map((post) => `<article class="blog-post"><a href="${encodeURIComponent(post.slug)}/"><time datetime="${escapeHtml(postDate(post))}">${escapeHtml(postDate(post))}</time><h2>${escapeHtml(post.title)}</h2><p>${escapeHtml(description(post))}</p><span class="blog-read">閱讀文章 →</span></a></article>`).join("\n") : "<p>新文章即將登場。</p>"}</section>`,
  });
}

function renderArticle(post, stylesheet) {
  return shell({
    title: `${post.title} — SwiftChat Blog`, summary: description(post), canonicalUrl: canonical(post), url: postUrl(post), type: "article", stylesheet,
    schema: {
      "@context": "https://schema.org", "@type": "BlogPosting", headline: post.title, description: description(post),
      url: postUrl(post), mainEntityOfPage: canonical(post), isBasedOn: canonical(post),
      datePublished: postDate(post), dateModified: post.lastEditedTime,
      author: { "@type": "Person", name: "Ronnie Wong", url: canonicalHub },
    },
    main: `<article><div class="blog-heading"><a class="blog-back" href="/blog/">← SwiftChat Blog</a><h1>${escapeHtml(post.title)}</h1><p class="blog-meta"><time datetime="${escapeHtml(postDate(post))}">${escapeHtml(postDate(post))}</time>${post.tag ? ` · ${escapeHtml(post.tag)}` : ""}</p></div>
<div class="blog-prose">${renderBlocks(post.content?.blocks)}</div>
<div class="blog-source">${canonical(post) !== postUrl(post) ? `<a href="${escapeHtml(canonical(post))}">RonnieCC 原文</a>` : ""}${post.notionUrl ? `<a href="${escapeHtml(post.notionUrl)}">Notion 原稿</a>` : ""}</div></article>`,
  });
}

function renderRedirect(post) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="robots" content="noindex,follow"><meta http-equiv="refresh" content="0; url=${escapeHtml(postUrl(post))}"><link rel="canonical" href="${escapeHtml(canonical(post))}"><title>${escapeHtml(post.title)}</title></head><body><a href="${escapeHtml(postUrl(post))}">${escapeHtml(post.title)}</a></body></html>\n`;
}

function collectAssets(blocks = [], assets = new Set()) {
  for (const block of blocks) {
    if (block.assetPath) assets.add(block.assetPath);
    collectAssets(block.children, assets);
  }
  return assets;
}

export async function syncBlog({ sourceRoot, sourceFile = path.join(sourceRoot, "content/blog.seed.json"), outputRoot = path.join(websiteRoot, "dist") }) {
  const source = JSON.parse(await readFile(sourceFile, "utf8"));
  const posts = source.posts.filter((post) => post.public !== false &&
    [...(post.subsites || []), ...(post.publishTargets || [])].some((target) => normalize(target) === "swiftchat"))
    .sort((a, b) => postDate(b).localeCompare(postDate(a)));
  const assets = new Set();
  for (const post of posts) collectAssets(post.content?.blocks, assets);
  for (const asset of assets) await readFile(path.join(sourceRoot, asset));
  const stylesheetVersion = createHash("sha256").update(await readFile(path.join(outputRoot, "assets/site.css"))).digest("hex").slice(0, 12);
  const stylesheet = `/assets/site.css?v=${stylesheetVersion}`;

  const blogRoot = path.join(outputRoot, "blog");
  await rm(blogRoot, { recursive: true, force: true });
  await rm(path.join(outputRoot, "content/blog-assets"), { recursive: true, force: true });
  await mkdir(blogRoot, { recursive: true });
  await mkdir(path.join(outputRoot, "content"), { recursive: true });
  for (const asset of assets) {
    const destination = path.join(outputRoot, asset);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(sourceRoot, asset), destination);
  }
  await writeFile(path.join(outputRoot, "content/blog.seed.json"), `${JSON.stringify({
    source: { repo: "RonnieCC", path: "content/blog.seed.json", subsite: "swiftchat", contractVersion: source.contractVersion, generatedAt: source.generatedAt }, posts,
  }, null, 2)}\n`);
  await writeFile(path.join(blogRoot, "index.html"), renderIndex(posts, stylesheet));
  for (const post of posts) {
    const articleRoot = path.join(blogRoot, post.slug);
    await mkdir(articleRoot, { recursive: true });
    await writeFile(path.join(articleRoot, "index.html"), renderArticle(post, stylesheet));
    for (const legacy of post.legacySlugs || []) {
      if (legacy === post.slug) continue;
      const legacyRoot = path.join(blogRoot, legacy);
      await mkdir(legacyRoot, { recursive: true });
      await writeFile(path.join(legacyRoot, "index.html"), renderRedirect(post));
    }
  }
  const urls = ["/", "/privacy.html", "/support.html", "/changelog.html", "/blog/"].map((route) => `${siteUrl}${route}`);
  urls.push(...posts.filter((post) => canonical(post) === postUrl(post)).map(postUrl));
  await writeFile(path.join(outputRoot, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `<url><loc>${escapeHtml(url)}</loc></url>`).join("\n")}\n</urlset>\n`);
  for (const entry of await readdir(outputRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
    const file = path.join(outputRoot, entry.name);
    const html = await readFile(file, "utf8");
    const updated = html.replace(/href="(\/?assets\/site\.css)(?:\?[^"]*)?"/g, `href="$1?v=${stylesheetVersion}"`);
    if (updated !== html) await writeFile(file, updated);
  }
  console.log(`Selected ${posts.length}/${source.posts.length} RonnieCC posts for SwiftChat; copied ${assets.size} assets.`);
  return { posts: posts.length, assets: assets.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceRoot = path.resolve(process.env.RONNIECC_REPO || path.join(websiteRoot, "../../RonnieCC"));
  await syncBlog({ sourceRoot, sourceFile: process.env.RONNIECC_BLOG_SEED || path.join(sourceRoot, "content/blog.seed.json") });
}
