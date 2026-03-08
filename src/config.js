import fs from "node:fs";
import path from "node:path";

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!key || process.env[key] !== undefined) continue;
    const value = trimmed.slice(idx + 1).trim();
    process.env[key] = value;
  }
}

function parseJsonEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

function parseModelCatalog(name) {
  const entries = parseJsonEnv(name, []);
  if (!Array.isArray(entries)) {
    throw new Error(`${name} must be a JSON array`);
  }
  return entries
    .map((item) => {
      if (typeof item === "string") {
        return { id: item.trim() };
      }
      if (item && typeof item === "object") {
        return {
          id: typeof item.id === "string" ? item.id.trim() : "",
          type: typeof item.type === "string" ? item.type.trim() : "",
          owned_by: typeof item.owned_by === "string" ? item.owned_by.trim() : "",
          description: typeof item.description === "string" ? item.description.trim() : "",
          current: Boolean(item.current)
        };
      }
      return { id: "" };
    })
    .filter((item) => item.id);
}

loadDotEnv();

const modelCatalogFromEnv = parseModelCatalog("OPENAI_MODEL_CATALOG");
const defaultModelId = process.env.OPENAI_DEFAULT_MODEL || "gpt-5.3-codex";
const defaultModelType =
  process.env.OPENAI_DEFAULT_MODEL_TYPE ||
  (process.env.OPENCLAW_WIRE_API === "responses" ? "responses" : "chat_completions");

export const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || "0.0.0.0",
  openAiProxyApiKey: process.env.OPENAI_PROXY_API_KEY || "",
  upstream: {
    baseUrl: (process.env.OPENCLAW_API_BASE_URL || "").replace(/\/+$/, ""),
    wireApi: process.env.OPENCLAW_WIRE_API || "chat_completions",
    chatPath: process.env.OPENCLAW_CHAT_PATH || "/chat/completions",
    responsesPath: process.env.OPENCLAW_RESPONSES_PATH || "/responses",
    authMode: process.env.OPENCLAW_AUTH_MODE || "bearer",
    accessToken: process.env.OPENCLAW_ACCESS_TOKEN || "",
    cookie: process.env.OPENCLAW_COOKIE || "",
    refreshUrl: process.env.OPENCLAW_REFRESH_URL || "",
    refreshMethod: process.env.OPENCLAW_REFRESH_METHOD || "POST",
    refreshHeaders: parseJsonEnv("OPENCLAW_REFRESH_HEADERS", {
      "Content-Type": "application/json"
    }),
    refreshBody: parseJsonEnv("OPENCLAW_REFRESH_BODY", {}),
    refreshTokenPath: process.env.OPENCLAW_REFRESH_TOKEN_PATH || "access_token"
  },
  models:
    modelCatalogFromEnv.length > 0
      ? modelCatalogFromEnv
      : [{ id: defaultModelId, type: defaultModelType, owned_by: "openclaw-proxy" }]
};

if (!config.upstream.baseUrl) {
  throw new Error("OPENCLAW_API_BASE_URL is required");
}
