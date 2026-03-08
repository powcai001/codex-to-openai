import { config } from "./config.js";

function getByPath(input, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), input);
}

function buildUpstreamHeaders(extra = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra
  };

  if (config.upstream.authMode === "cookie") {
    if (!config.upstream.cookie) {
      throw new Error("OPENCLAW_COOKIE is required when OPENCLAW_AUTH_MODE=cookie");
    }
    headers.Cookie = config.upstream.cookie;
  } else {
    if (!config.upstream.accessToken) {
      throw new Error("OPENCLAW_ACCESS_TOKEN is required when OPENCLAW_AUTH_MODE=bearer");
    }
    headers.Authorization = `Bearer ${config.upstream.accessToken}`;
  }

  return headers;
}

async function refreshToken() {
  if (!config.upstream.refreshUrl) return false;
  const response = await fetch(config.upstream.refreshUrl, {
    method: config.upstream.refreshMethod,
    headers: config.upstream.refreshHeaders,
    body: JSON.stringify(config.upstream.refreshBody)
  });
  if (!response.ok) return false;
  const payload = await response.json();
  const accessToken = getByPath(payload, config.upstream.refreshTokenPath);
  if (!accessToken || typeof accessToken !== "string") return false;
  config.upstream.accessToken = accessToken;
  return true;
}

function normalizeMessages(messages = []) {
  return messages
    .filter((m) => m && typeof m.role === "string")
    .map((m) => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.map((item) => (typeof item === "string" ? item : item?.text || "")).join("\n")
        : (m.content ?? "").toString()
    }));
}

export async function forwardToOpenClaw(openAiRequest) {
  const normalizedMessages = normalizeMessages(openAiRequest.messages);
  const asInputText = normalizedMessages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const useResponsesApi = config.upstream.wireApi === "responses";
  const upstreamRequest = useResponsesApi
    ? {
        model: openAiRequest.model,
        stream: Boolean(openAiRequest.stream),
        input: asInputText
      }
    : {
        model: openAiRequest.model,
        stream: Boolean(openAiRequest.stream),
        temperature: openAiRequest.temperature,
        top_p: openAiRequest.top_p,
        max_tokens: openAiRequest.max_tokens,
        messages: normalizedMessages
      };

  const targetPath = useResponsesApi ? config.upstream.responsesPath : config.upstream.chatPath;
  const url = `${config.upstream.baseUrl}${targetPath}`;
  const attempt = async () =>
    fetch(url, {
      method: "POST",
      headers: buildUpstreamHeaders(),
      body: JSON.stringify(upstreamRequest)
    });

  let response = await attempt();
  if (response.status === 401 && config.upstream.authMode === "bearer") {
    const refreshed = await refreshToken();
    if (refreshed) response = await attempt();
  }
  return response;
}

export function extractTextFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";

  const chatChoice = payload?.choices?.[0]?.message?.content;
  if (typeof chatChoice === "string") return chatChoice;

  if (Array.isArray(chatChoice)) {
    return chatChoice.map((x) => (typeof x === "string" ? x : x?.text || "")).join("");
  }

  if (typeof payload.output_text === "string") return payload.output_text;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.content === "string") return payload.content;
  return "";
}
