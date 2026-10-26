import { llmReady } from "./config.mjs";
import { proxiedFetch } from "./net.mjs";

function normalizeBaseUrl(base) {
  let b = String(base || "").trim().replace(/\/+$/, "");
  if (!b) return "";
  if (b.endsWith("/chat/completions")) return b;
  return b + "/chat/completions";
}

export async function callLLM(cfg, messages, { temperature = 0.3, maxTokens = 1500 } = {}) {
  const llm = cfg.llm || {};
  const url = normalizeBaseUrl(llm.base_url);
  if (!url || !llm.api_key) throw new Error("LLM 未配置");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await proxiedFetch(cfg, url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.api_key}` },
      body: JSON.stringify({ model: llm.model, messages, temperature, max_tokens: maxTokens }),
    }, 60000);
    const text = await res.text();
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(t);
  }
}

export function parseJson(content) {
  if (!content) return null;
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  let candidate = fence ? fence[1] : (content.match(/\{[\s\S]*\}/) || [""])[0];
  candidate = String(candidate || "").trim();
  const attempt = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const first = attempt(candidate);
  if (first) return first;
  return attempt(candidate.replace(/,\s*([}\]])/g, "$1"));
}

const SYSTEM_PROMPT = `你是外贸获客助手。根据给定公司信息，判断它是否是中国跑步服饰供应商（压缩裤/跑步背心/跑步短裤/速干衣，支持定制 LOGO 和版型）的潜在 B2B 买家。
只输出一个 JSON 对象，不要输出任何其他文字。字段：
{
 "is_buyer": true/false,
 "buyer_type": "brand|distributor|retail|event|manufacturer",
 "oem_need": 0到13的整数（判断该公司是否需要贴牌/定制/OEM，需求越明确分越高）,
 "fit": "一句话匹配理由（中文）",
 "contact_hint": "建议联系谁、走什么渠道（如：官网 wholesale 表单 / Instagram DM / LINE 官方号）",
 "language": "开发信用什么语言，如 en / ko / th",
 "draft": "用上述语言写的开发信草稿，3-5句，自然口语，点到其卖点或定制需求，不要空话套话，不要画册式推销"
}`;

export async function analyzeLead(cfg, lead) {
  if (!llmReady(cfg)) return null;
  const user = [
    `公司名：${lead.name || ""}`,
    `官网：${lead.url || ""}`,
    `国家：${lead.country || "未知"}`,
    `已检测信号：${(lead.signals || []).join("、") || "无"}`,
    `页面摘要：${(lead.text || lead.snippet || "").slice(0, 2000)}`,
  ].join("\n");

  try {
    const content = await callLLM(cfg, [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ], { temperature: 0.3 });
    const j = parseJson(content);
    if (!j) return { raw: content.slice(0, 400), parse_error: true };
    return j;
  } catch (e) {
    return { error: String(e.message || e).slice(0, 120) };
  }
}
