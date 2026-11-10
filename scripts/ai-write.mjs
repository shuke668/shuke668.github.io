#!/usr/bin/env node
/**
 * AI 写稿：扫描 front matter 里 writer: ai 的空稿，补齐中文正文并生成英文版。
 * 由 GitHub Actions 在 push 后触发；本地也可手动运行。
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const LLM_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE = (process.env.LLM_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-chat";
const MAX = Number(process.env.AI_MAX || 3);

if (!LLM_KEY) {
  console.log("未配置 LLM_API_KEY，跳过 AI 写稿。");
  process.exit(0);
}

const root = path.join("content", "zh");
if (!fs.existsSync(root)) {
  console.log("没有 content/zh 目录，跳过。");
  process.exit(0);
}

const files = fs
  .readdirSync(root, { recursive: true })
  .filter((f) => typeof f === "string" && f.endsWith("index.md"))
  .map((f) => path.join(root, f));

let done = 0;

for (const file of files) {
  if (done >= MAX) break;

  let parsed;
  try {
    parsed = parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.warn(`跳过 ${file}：${e.message}`);
    continue;
  }
  if (!parsed || parsed.fm.writer !== "ai") continue;
  if (parsed.body.length > 160) continue;

  const fm = parsed.fm;
  console.log(`写稿：${fm.title}`);

  try {
    const body = await chat(
      [
        {
          role: "system",
          content:
            "你是一位资深的科技与国际事务观察者，为一个个人博客撰写短评。要求：\n" +
            "1. 使用中文，600-900 字，Markdown 格式，包含 2-4 个二级标题；\n" +
            "2. 先交代事实与背景，再给出判断，明确区分事实与观点；\n" +
            "3. 不编造数据、引述或时间；不确定的信息写成「据……报道」；\n" +
            "4. 不做价值煽动，语气克制、专业；\n" +
            "5. 结尾用一句话给出可被引用的结论；\n" +
            "6. 只输出文章正文，不要输出 front matter 或解释。",
        },
        {
          role: "user",
          content: [
            `标题：${fm.title}`,
            fm.angle ? `写作角度：${fm.angle}` : "",
            fm.summary ? `已知摘要：${fm.summary}` : "",
            fm.source_name ? `来源：${fm.source_name}` : "",
            fm.source_url ? `原文链接：${fm.source_url}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      0.65,
    );

    if (!body || body.length < 120) {
      console.warn(`生成内容过短，跳过：${fm.title}`);
      continue;
    }

    const fmText = parsed.fmText.replace(/^draft:\s*true\s*$/m, "draft: false");
    fs.writeFileSync(file, `${fmText}\n${body}\n`, "utf8");

    const enTitle = await translate(fm.title, "英文");
    const enSummary = fm.summary ? await translate(String(fm.summary), "英文") : "";
    const enBody = await translate(body, "英文");

    const enFm = buildFrontMatter({
      title: enTitle || fm.title,
      date: fm.date,
      kind: fm.kind || "post",
      categories: fm.categories || [],
      tags: fm.tags || [],
      summary: enSummary || fm.summary || "",
      featured: fm.featured === true,
      draft: false,
      source_name: fm.source_name,
      source_url: fm.source_url,
    });

    const enFile = file.replace(`${path.sep}zh${path.sep}`, `${path.sep}en${path.sep}`);
    fs.mkdirSync(path.dirname(enFile), { recursive: true });
    fs.writeFileSync(enFile, `${enFm}\n${enBody}\n`, "utf8");

    done += 1;
    console.log(`完成：${file} + 英文版`);
  } catch (e) {
    console.warn(`生成失败：${fm.title} — ${e.message}`);
  }
}

console.log(`本轮共补全 ${done} 篇。`);

/* ---------------- 工具函数 ---------------- */

function parse(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const fm = yaml.load(m[1]) || {};
  return { fmText: m[0], fm, body: text.slice(m[0].length).trim() };
}

function buildFrontMatter(fm) {
  const keys = ["title", "date", "kind", "categories", "tags", "summary", "featured", "draft", "source_name", "source_url"];
  const lines = ["---"];
  for (const key of keys) {
    const value = fm[key];
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

async function translate(text, target) {
  if (!text) return "";
  try {
    return await chat(
      [
        { role: "system", content: `把下面的 Markdown 内容翻译成${target}，保留标题层级、链接、代码与语气，只输出译文。` },
        { role: "user", content: text },
      ],
      0.2,
    );
  } catch (e) {
    console.warn(`翻译失败，退回原文：${e.message}`);
    return text;
  }
}

async function chat(messages, temperature = 0.4) {
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: LLM_MODEL, messages, temperature }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}
