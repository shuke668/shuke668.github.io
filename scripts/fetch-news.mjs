#!/usr/bin/env node
/**
 * 抓取 RSS → 生成中英双语「快讯」
 * 只保留标题、≤120 字摘要与原文链接，不镜像全文。
 */
import Parser from "rss-parser";
import yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const WINDOW_MS = 24 * 3600 * 1000;
const PER_SOURCE = 3;
const CAP = { tech: 20, world: 12, biz: 9, defense: 9 };
const BATCH = 8;

const LLM_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE = (process.env.LLM_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-chat";

const parser = new Parser({
  timeout: 20000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; ShukeWatchBot/1.0; +https://github.com/shuke668)" },
});

const sources = yaml.load(fs.readFileSync("data/sources.yml", "utf8")) || [];
const since = Date.now() - WINDOW_MS;
const counters = Object.fromEntries(Object.keys(CAP).map((k) => [k, 0]));

const seenFile = "data/seen.json";
let seen = {};
if (fs.existsSync(seenFile)) {
  try { seen = JSON.parse(fs.readFileSync(seenFile, "utf8")); } catch { seen = {}; }
}
const cutoff = Date.now() - 7 * 86400_000;
for (const [k, v] of Object.entries(seen)) if (!Number.isFinite(v) || v < cutoff) delete seen[k];

const stats = {
  updated_at: new Date().toISOString(),
  scanned: 0,
  written: 0,
  source_count: sources.length,
  today_count: 0,
  sources: [],
};

const pending = [];

for (const src of sources) {
  const rec = { name: src.name, ok: false, items: 0, error: "" };
  try {
    const feed = await parseFeed(src.rss);
    rec.ok = true;
    for (const item of (feed.items || []).slice(0, PER_SOURCE)) {
      if (counters[src.category] >= CAP[src.category]) break;
      const ts = Date.parse(item.isoDate || item.pubDate || "");
      if (!ts || ts < since) continue;

      const url = normalizeUrl(item.link);
      if (!url) continue;
      const id = hash(url);
      if (seen[id]) continue;

      const title = clean(item.title);
      if (!title) continue;

      seen[id] = ts;
      counters[src.category] += 1;
      rec.items += 1;
      stats.scanned += 1;

      pending.push({
        id,
        url,
        ts,
        category: src.category,
        source: src.name,
        title,
        summary: excerpt(item),
      });
    }
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 200);
    console.warn(`[skip] ${src.name}: ${rec.error}`);
  }
  stats.sources.push(rec);
}

const needZh = pending.filter((it) => !isChinese(it.title));
const needEn = pending.filter((it) => isChinese(it.title));
const zhMap = await translate(needZh, "中文");
const enMap = await translate(needEn, "English");

let written = 0;
for (const item of pending) {
  const zhText = isChinese(item.title) ? { title: item.title, summary: item.summary } : zhMap.get(item.id) || { title: item.title, summary: item.summary };
  const enText = isChinese(item.title) ? enMap.get(item.id) || { title: item.title, summary: item.summary } : { title: item.title, summary: item.summary };
  written += writeItem(item, zhText, enText);
}

stats.written = written;
stats.today_count = countToday();
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync(seenFile, JSON.stringify(seen, null, 0), "utf8");
fs.writeFileSync("data/news_stats.json", JSON.stringify(stats, null, 2), "utf8");

const failed = stats.sources.filter((s) => !s.ok).map((s) => s.name);
console.log(`抓取完成：扫描 ${stats.scanned} 条，写入 ${written} 个文件，今日共 ${stats.today_count} 条。`);
if (failed.length) console.log(`失败源：${failed.join(", ")}`);

/* ---------------- 工具函数 ---------------- */

async function parseFeed(url) {
  try {
    return await parser.parseURL(url);
  } catch (first) {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ShukeWatchBot/1.0; +https://github.com/shuke668)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw first;
    return await parser.parseString(sanitizeXml(await res.text()));
  }
}

// 部分中文源（如 36氪）正文里有未转义的 < 和 &，先补转义再解析
function sanitizeXml(xml) {
  return xml
    .replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, "&amp;")
    .replace(/<(?![a-zA-Z/!?])/g, "&lt;");
}

async function translate(items, target) {
  const out = new Map();
  if (!items.length) return out;
  if (!LLM_KEY) {
    console.log("未配置 LLM_API_KEY，双语条目将保留原文。");
    return out;
  }
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    try {
      const text = await chat([
        {
          role: "system",
          content:
            `你是新闻编辑助理。把输入的 JSON 数组逐条翻译成${target}。` +
            "要求：客观准确，标题不超过 60 字，摘要不超过 120 字，不添加评论，不改变事实，保留专有名词和机构名。" +
            '只输出 JSON 数组，格式 [{"id":"...","title":"...","summary":"..."}]，不要输出其他文字。',
        },
        { role: "user", content: JSON.stringify(slice.map((it) => ({ id: it.id, title: it.title, summary: it.summary }))) },
      ]);
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      const rows = JSON.parse(text.slice(start, end + 1));
      for (const row of rows) {
        if (row && row.id) {
          out.set(row.id, {
            title: String(row.title || "").trim(),
            summary: String(row.summary || "").trim(),
          });
        }
      }
    } catch (e) {
      console.warn(`翻译失败，保留原文：${e.message}`);
    }
  }
  return out;
}

async function chat(messages, temperature = 0.2) {
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: LLM_MODEL, messages, temperature }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

function writeItem(item, zhText, enText) {
  const d = new Date(item.ts + 8 * 3600_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const slug = `${y}${m}${day}-${item.id.slice(0, 8)}`;
  const iso = new Date(item.ts).toISOString();
  let wrote = 0;

  for (const lang of ["zh", "en"]) {
    const dir = path.join("content", lang, "news", String(y), m, slug);
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir, { recursive: true });

    const text = lang === "zh" ? zhText : enText;
    const fm = [
      "---",
      `title: ${JSON.stringify(text.title)}`,
      `date: ${iso}`,
      "kind: flash",
      `categories: ["${item.category}"]`,
      "tags: []",
      `summary: ${JSON.stringify(text.summary)}`,
      `source_name: ${JSON.stringify(item.source)}`,
      `source_url: ${JSON.stringify(item.url)}`,
      `source_time: ${iso}`,
      "featured: false",
      "draft: false",
      "---",
      "",
    ].join("\n");

    const note =
      lang === "zh"
        ? "本条由抓取脚本自动生成，仅含标题与摘要，版权归来源方所有。"
        : "Auto-generated from RSS. Headline and excerpt only; all rights belong to the publisher.";
    const link = lang === "zh" ? "阅读原文 →" : "Read original →";
    const body = `${text.summary}\n\n[${link}](${item.url})\n\n---\n\n*${note}*\n`;

    fs.writeFileSync(path.join(dir, "index.md"), fm + body, "utf8");
    wrote += 1;
  }
  return wrote;
}

function countToday() {
  const d = new Date(Date.now() + 8 * 3600_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const dir = path.join("content", "zh", "news", String(y), m);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => name.startsWith(`${y}${m}${day}-`)).length;
}

function isChinese(s) {
  return /[\u4e00-\u9fff]/.test(s || "");
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm$|ref$|source$|cmpid$|ocid$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function hash(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  "#39": "'", "#8217": "’", "#8216": "‘", "#8220": "“", "#8221": "”",
  "#8212": "—", "#8211": "–", "#8230": "…", "#160": " ",
};

function clean(input = "") {
  return String(input)
    .replace(/&(#?\w+);/g, (m, g) => ENTITIES[g] ?? m)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(item) {
  const raw =
    item.contentSnippet ||
    item.summary ||
    item.content ||
    item["content:encoded"] ||
    "";
  const text = clean(raw);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
