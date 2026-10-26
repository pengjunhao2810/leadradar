import fs from "node:fs";
import path from "node:path";
import { loadConfig, searchReady, emailFinderReady, llmReady, ROOT } from "./config.mjs";
import { search, providerName } from "./search.mjs";
import { enrichSite, domainOf } from "./enrich.mjs";
import { scoreLead, dedupeByDomain, recompute, TYPES } from "./score.mjs";
import { analyzeLead } from "./llm.mjs";
import { enrichSocial, isSocialUrl, buildSocialQueries, parseSocialUrl } from "./social.mjs";
import { writeReport, notify, ymd } from "./report.mjs";

const PRODUCT_QUERY = {
  compression_tights: "compression tights",
  running_singlet: "running singlet",
  running_shorts: "running shorts",
  quick_dry: "quick dry shirt",
};

const COUNTRY_TERM = { KR: "Korea", TH: "Thailand", US: "USA", UK: "UK", ID: "Indonesia", MY: "Malaysia" };

const BUYER_TERM = {
  brand: "brand",
  distributor: "wholesale distributor",
  retail: "running store",
  event: "run club",
};

export function buildQueries(cfg) {
  const qs = [];
  const combos = [];
  for (const p of cfg.products) for (const c of cfg.markets) combos.push([p, c]);
  const max = cfg.search.max_queries_per_run || 30;
  const btKeys = cfg.buyer_types && cfg.buyer_types.length ? cfg.buyer_types : ["brand"];

  combos.forEach(([p, c], idx) => {
    const prod = PRODUCT_QUERY[p] || p;
    const ct = COUNTRY_TERM[c] || c;
    const b = btKeys[idx % btKeys.length];
    qs.push({ q: `${prod} ${BUYER_TERM[b] || b} ${ct}`, product: p, country: c, type: b });
  });

  let i = 0;
  while (qs.length < max && i < combos.length * 3) {
    const [p, c] = combos[i % combos.length];
    const prod = PRODUCT_QUERY[p] || p;
    const ct = COUNTRY_TERM[c] || c;
    const oem = Math.floor(i / combos.length) % 2 === 0;
    qs.push({ q: `${prod} ${oem ? "OEM" : "private label"} ${ct}`, product: p, country: c, type: "brand" });
    i++;
  }
  return qs.slice(0, max);
}

function countryOf(text) {
  const m = { KR: /韩国|Korea|서울|首尔|Seoul/i, TH: /泰国|Thailand|Bangkok|曼谷/i, US: /美国|USA|United States/i, UK: /英国|UK|United Kingdom/i, ID: /印尼|Indonesia|Jakarta|雅加达/i, MY: /马来|Malaysia|Kuala Lumpur|吉隆坡/i };
  for (const [k, re] of Object.entries(m)) if (re.test(text)) return k;
  return "";
}

function tldCountry(url) {
  const h = domainOf(url);
  if (!h) return "";
  if (/\.kr$/.test(h)) return "KR";
  if (/\.(co\.)?th$/.test(h)) return "TH";
  if (/\.(co\.)?id$/.test(h)) return "ID";
  if (/\.my$/.test(h)) return "MY";
  if (/\.(co\.)?uk$/.test(h)) return "UK";
  return "";
}

const NOISE_RE = /(^|\.)(alibaba|aliexpress|made-in-china|globalsources|tradeindia|indiamart|dhgate|amazon|ebay|etsy|shopee|lazada|tokopedia|walmart|yellowpages|yelp|manta|kompass|europages|importyeti|panjiva|reddit|quora|pinterest|wikipedia|linkedin|twitter|youtube|google|bing)\./i;

function isNoiseUrl(url) {
  const h = domainOf(url);
  return !h || NOISE_RE.test(h);
}

function seedLeads(cfg) {
  const seeds = [];
  const seen = new Set();

  const srcPath = path.join(ROOT, "daily", "sources.json");
  if (fs.existsSync(srcPath)) {
    const src = JSON.parse(fs.readFileSync(srcPath, "utf8"));
    for (const s of src.watchlist || []) {
      if (s.channel !== "website") continue;
      if (!s.url || seen.has(s.url)) continue;
      seen.add(s.url);
      seeds.push({ name: s.name, url: s.url, country: s.country, type: s.type, products: (s.products || "").split(";"), evidence: "directory" });
    }
  }

  const wmPath = path.join(ROOT, "wm-report.json");
  if (fs.existsSync(wmPath)) {
    const wm = JSON.parse(fs.readFileSync(wmPath, "utf8"));
    const sec = (wm.sections || []).find((s) => (s.heading || "").includes("官网"));
    for (const row of sec?.table?.rows || []) {
      const name = row[0];
      const site = row[1];
      const url = typeof site === "object" ? site.url : (typeof site === "string" && /^https?:/.test(site) ? site : "");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const country = countryOf(`${name} ${row[2] || ""} ${row[3] || ""}`);
      seeds.push({ name: String(name).split("（")[0].trim(), url, country, type: "", products: cfg.products, evidence: "news" });
    }
  }
  return seeds;
}

export async function discover(cfg) {
  if (searchReady(cfg)) {
    const candidates = [];
    const seen = new Set();
    const queries = buildQueries(cfg);
    if (cfg.search.include_social !== false) queries.push(...buildSocialQueries(cfg));
    for (const q of queries) {
      try {
        const results = await search(cfg, q.q, cfg.search.results_per_query);
        for (const r of results || []) {
          if (isNoiseUrl(r.url)) continue;
          const dom = isSocialUrl(r.url) ? `${parseSocialUrl(r.url).platform}:${parseSocialUrl(r.url).handle}` : domainOf(r.url);
          if (!dom || seen.has(dom)) continue;
          seen.add(dom);
          const tld = tldCountry(r.url);
          let country, countrySource;
          if (tld) { country = tld; countrySource = "tld"; }
          else {
            const kw = countryOf(`${r.title || ""} ${r.snippet || ""}`);
            if (kw) { country = kw; countrySource = "keyword"; }
            else { country = q.country; countrySource = "query_guess"; }
          }
          candidates.push({ name: r.title, url: r.url, snippet: r.snippet, domain: dom, country, countrySource, type: q.type, products: [q.product], evidence: isSocialUrl(r.url) ? "social" : "search" });
        }
      } catch (e) {
        /* 单条查询失败继续 */
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    return { candidates, source: providerName(cfg), search: true };
  }
  const seeds = seedLeads(cfg);
  return { candidates: seeds, source: "本地样本库（未配置搜索 key，仅官网/社媒公开信息）", search: false };
}

export async function runPipeline(cfg, opts = {}) {
  const startedAt = Date.now();
  const warnings = [];
  const emailFinder = emailFinderReady(cfg) ? cfg.contacts.email_finder.provider : "none";

  if (!searchReady(cfg)) warnings.push("未配置搜索 API key：当前使用本地样本库的官网/社媒抓取联系方式。填好 config.json 或 .env 中的 key 后即为真实全网搜索。");
  if (!emailFinderReady(cfg) && cfg.contacts.email_finder.provider !== "none") warnings.push("邮箱查找 API 未配置 key，仅使用官网公开邮箱。");
  if (!llmReady(cfg)) warnings.push("未配置大模型 key：当前为规则评分，无 AI 判断与开发信草稿。填 LLM_API_KEY 后自动启用。");

  const { candidates, source } = await discover(cfg);
  const max = cfg.report.max_candidates_per_run;
  const leads = [];

  const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

  for (const c of candidates.slice(0, max)) {
    try {
      const social = isSocialUrl(c.url);
      const en = await withTimeout(social ? enrichSocial(cfg, c.url) : enrichSite(cfg, c.url), 45000, null);
      const lead = {
        name: en?.title ? en.title.slice(0, 60) : c.name,
        url: c.url,
        domain: c.domain || domainOf(c.url),
        country: c.country || countryOf(c.name + " " + (c.snippet || "")),
        countrySource: c.countrySource || "",
        type: c.type,
        products: c.products || cfg.products,
        evidence: c.evidence || (social ? "social" : "search"),
        emails: en?.emails || [],
        phones: en?.phones || [],
        social: en?.social || [],
        signals: en?.signals || [],
        text: en?.text || "",
        snippet: c.snippet || "",
        fetched_at: new Date(Date.now() + 8 * 3600e3).toISOString().replace("Z", "+08:00"),
      };
      scoreLead(lead, cfg);

      if (llmReady(cfg)) {
        const ai = await analyzeLead(cfg, lead);
        if (ai && !ai.parse_error && !ai.error && ai.is_buyer !== undefined) {
          lead.ai = ai;
          if (Number.isFinite(Number(ai.oem_need))) lead.scores.oem = Math.max(0, Math.min(13, Number(ai.oem_need)));
          if (ai.buyer_type && TYPES[ai.buyer_type]) {
            lead.type = ai.buyer_type;
            lead.typeLabel = TYPES[ai.buyer_type].label;
            lead.scores.role = TYPES[ai.buyer_type].role;
          }
          if (ai.is_buyer === false) lead.scores.product = Math.min(lead.scores.product, 5);
          lead.ai_fit = ai.fit || "";
          lead.draft = ai.draft || "";
          lead.contact_hint = ai.contact_hint || "";
          lead.language = ai.language || "";
          recompute(lead);
        }
      }

      leads.push(lead);
      console.log(`  [${lead.total}] ${lead.name}　邮箱${lead.emails.length} 电话${lead.phones.length} 社媒${lead.social.length}${lead.draft ? "　AI✓" : ""}`);
    } catch (e) {
      warnings.push(`${c.name || c.url}：抓取失败 ${String(e.message || e).slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  const deduped = dedupeByDomain(leads);
  const kept = deduped.filter((l) => l.total >= (cfg.scoring.min_score ?? 60));
  kept.sort((a, b) => b.total - a.total);

  const stats = {
    date: opts.date || ymd(),
    generated_at: new Date(Date.now() + 8 * 3600e3).toISOString().replace("Z", "+08:00"),
    duration_s: +((Date.now() - startedAt) / 1000).toFixed(1),
    source,
    search_ready: searchReady(cfg),
    email_finder: emailFinder,
    candidates: candidates.length,
    leads: kept.length,
    qualified: kept.filter((l) => l.status === "qualified").length,
    review: kept.filter((l) => l.status === "review").length,
    with_email: kept.filter((l) => (l.emails || []).length).length,
    with_phone: kept.filter((l) => (l.phones || []).length).length,
  };

  const { outDir, reportPath } = writeReport({ stats, leads: kept, cfg, warnings });
  return { stats, outDir, reportPath, warnings };
}
