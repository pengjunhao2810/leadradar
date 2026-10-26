import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

export function loadEnvFile() {
  const p = path.join(ROOT, ".env");
  const env = {};
  if (!fs.existsSync(p)) return env;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[k] = v;
  }
  return env;
}

export function loadConfig() {
  const env = { ...loadEnvFile(), ...process.env };
  const cfgPath = path.join(ROOT, "config.json");
  const exPath = path.join(ROOT, "config.example.json");
  const src = fs.existsSync(cfgPath) ? cfgPath : exPath;
  const cfg = JSON.parse(fs.readFileSync(src, "utf8"));

  const s = cfg.search || (cfg.search = {});
  const serper = s.serper || (s.serper = {});
  const bing = s.bing || (s.bing = {});
  const g = s.google_cse || (s.google_cse = {});
  if (env.SERPER_API_KEY) serper.apiKey = env.SERPER_API_KEY;
  if (env.BING_API_KEY) bing.apiKey = env.BING_API_KEY;
  if (env.GOOGLE_CSE_KEY) g.apiKey = env.GOOGLE_CSE_KEY;
  if (env.GOOGLE_CSE_CX) g.cx = env.GOOGLE_CSE_CX;

  const ef = cfg.contacts?.email_finder || (cfg.contacts.email_finder = {});
  const hunter = ef.hunter || (ef.hunter = {});
  const apollo = ef.apollo || (ef.apollo = {});
  const snov = ef.snov || (ef.snov = {});
  if (env.HUNTER_API_KEY) hunter.apiKey = env.HUNTER_API_KEY;
  if (env.APOLLO_API_KEY) apollo.apiKey = env.APOLLO_API_KEY;
  if (env.SNOV_USER_ID) snov.userId = env.SNOV_USER_ID;
  if (env.SNOV_SECRET) snov.secret = env.SNOV_SECRET;

  const llm = cfg.llm || (cfg.llm = {});
  if (env.LLM_API_KEY) llm.api_key = env.LLM_API_KEY;
  if (env.LLM_BASE_URL) llm.base_url = env.LLM_BASE_URL;
  if (env.LLM_MODEL) llm.model = env.LLM_MODEL;

  return cfg;
}

export function llmReady(cfg) {
  return !!(cfg.llm?.api_key && cfg.llm?.model);
}

export function searchReady(cfg) {
  const p = cfg.search.provider;
  if (p === "serper") return !!cfg.search.serper?.apiKey;
  if (p === "bing") return !!cfg.search.bing?.apiKey;
  if (p === "google_cse") return !!(cfg.search.google_cse?.apiKey && cfg.search.google_cse?.cx);
  return false;
}

export function emailFinderReady(cfg) {
  const p = cfg.contacts.email_finder.provider;
  if (p === "hunter") return !!cfg.contacts.email_finder.hunter?.apiKey;
  if (p === "apollo") return !!cfg.contacts.email_finder.apollo?.apiKey;
  if (p === "snov") return !!(cfg.contacts.email_finder.snov?.userId && cfg.contacts.email_finder.snov?.secret);
  return false;
}
