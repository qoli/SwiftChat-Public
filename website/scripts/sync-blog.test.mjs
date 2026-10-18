import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { syncBlog } from "./sync-blog.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "swiftchat-blog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const outputRoot = path.join(root, "dist");
  await mkdir(path.join(sourceRoot, "content/blog-assets/post"), { recursive: true });
  await mkdir(path.join(outputRoot, "releases"), { recursive: true });
  await writeFile(path.join(sourceRoot, "content/blog-assets/post/screenshot.png"), "image fixture");
  await writeFile(path.join(outputRoot, "releases/alpha.json"), "release fixture");
  const mirror = {
    id: "mirror", title: 'Chat <script> & "Mac"', slug: "native-chat-abcd1234", legacySlugs: ["old-chat"],
    writtenDate: "2026-10-18", tag: "AI, macOS", subsites: ["SwiftChat"],
    notionUrl: "https://www.notion.so/mirror",
    content: { blocks: [
      { type: "text", plainText: "Native conversations", richText: [{ text: "Native conversations", annotations: ["b"] }] },
      { type: "numbered_list", richText: [{ text: "Context" }], children: [
        { type: "image", assetPath: "content/blog-assets/post/screenshot.png", caption: [{ text: "Screenshot" }] },
      ] },
    ] },
  };
  const source = { contractVersion: 1, generatedAt: "2026-10-18T00:00:00Z", posts: [
    mirror,
    { ...mirror, id: "owned", slug: "owned-chat-abcd1234", legacySlugs: [], subsites: [], publishTargets: ["swiftchat"], canonical: { site: "swiftchat", url: "https://swiftchat.ronniewong.cc/blog/owned-chat-abcd1234/" } },
    { ...mirror, id: "tag-only", subsites: [], tag: "SwiftChat" },
    { ...mirror, id: "draft", public: false },
  ] };
  const sourceFile = path.join(sourceRoot, "content/blog.seed.json");
  await writeFile(sourceFile, JSON.stringify(source));
  return { sourceRoot, sourceFile, outputRoot, source };
}

test("routes only public subsite targets and preserves canonical ownership, nested assets and release data", async (t) => {
  const options = await fixture(t);
  assert.deepEqual(await syncBlog(options), { posts: 2, assets: 1 });
  const read = (name) => readFile(path.join(options.outputRoot, name), "utf8");
  const seed = JSON.parse(await read("content/blog.seed.json"));
  assert.deepEqual(seed.posts.map((post) => post.id), ["mirror", "owned"]);
  const article = await read("blog/native-chat-abcd1234/index.html");
  assert.match(article, /rel="canonical" href="https:\/\/ronniewong.cc\/blog\/native-chat-abcd1234\/"/);
  assert.match(article, /RonnieCC 原文/);
  assert.match(article, /Notion 原稿/);
  assert.match(article, /<strong>Native conversations<\/strong>/);
  assert.match(article, /Chat &lt;script&gt; &amp; &quot;Mac&quot;/);
  assert.match(article, /src="\/content\/blog-assets\/post\/screenshot.png"/);
  assert.equal(await read("content/blog-assets/post/screenshot.png"), "image fixture");
  const index = await read("blog/index.html");
  assert.match(index, /href="native-chat-abcd1234\/"/);
  assert.doesNotMatch(index, /href="old-chat\/"/);
  const sitemap = await read("sitemap.xml");
  assert.match(sitemap, /https:\/\/swiftchat.ronniewong.cc\/blog\/<\/loc>/);
  assert.match(sitemap, /owned-chat-abcd1234/);
  assert.doesNotMatch(sitemap, /native-chat-abcd1234|old-chat/);
  assert.match(await read("blog/old-chat/index.html"), /noindex,follow/);
  assert.equal(await read("releases/alpha.json"), "release fixture");
});

test("a missing source asset fails before replacing the published mirror", async (t) => {
  const options = await fixture(t);
  await syncBlog(options);
  const indexPath = path.join(options.outputRoot, "blog/index.html");
  const previous = await readFile(indexPath, "utf8");
  await rm(path.join(options.sourceRoot, "content/blog-assets/post/screenshot.png"));
  await assert.rejects(syncBlog(options), { code: "ENOENT" });
  assert.equal(await readFile(indexPath, "utf8"), previous);
});

test("removing a subsite selection removes stale articles and assets", async (t) => {
  const options = await fixture(t);
  await syncBlog(options);
  options.source.posts = [];
  await writeFile(options.sourceFile, JSON.stringify(options.source));
  assert.deepEqual(await syncBlog(options), { posts: 0, assets: 0 });
  await assert.rejects(readFile(path.join(options.outputRoot, "blog/native-chat-abcd1234/index.html")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(options.outputRoot, "content/blog-assets/post/screenshot.png")), { code: "ENOENT" });
  assert.match(await readFile(path.join(options.outputRoot, "blog/index.html"), "utf8"), /新文章即將登場/);
});
