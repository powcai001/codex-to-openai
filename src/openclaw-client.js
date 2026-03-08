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
    .map((m) => {
      const normalized = { role: m.role };
      if (m.content !== undefined) normalized.content = m.content;
      if (m.name !== undefined) normalized.name = m.name;
      if (m.tool_calls !== undefined) normalized.tool_calls = m.tool_calls;
      if (m.tool_call_id !== undefined) normalized.tool_call_id = m.tool_call_id;
      return normalized;
    });
}

function getResponsesTextTypeByRole(role, fallback = config.upstream.responsesTextType) {
  if (role === "assistant") return "output_text";
  if (role === "user" || role === "system" || role === "developer") return "input_text";
  return fallback;
}

function extractToolOutputText(content) {
  if (typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content);
    const textFromArray = parsed?.output?.content
      ?.map((item) => (typeof item?.text === "string" ? item.text : ""))
      .join("\n")
      .trim();
    if (textFromArray) return textFromArray;
  } catch {
    // fallback to raw text
  }
  return content;
}

function toResponsesInput(messages = [], textType = config.upstream.responsesTextType) {
  const out = [];
  for (const m of messages) {
    if (m?.role === "tool") {
      out.push({
        type: "function_call_output",
        call_id: m.tool_call_id || "",
        output: extractToolOutputText(m.content)
      });
      continue;
    }

    if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      if (typeof m.content === "string" && m.content.trim()) {
        out.push({
          role: "assistant",
          content: [{ type: "output_text", text: m.content }]
        });
      }
      for (const toolCall of m.tool_calls) {
        out.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments || "{}"
        });
      }
      continue;
    }

    const roleType = getResponsesTextTypeByRole(m.role, textType);
    if (Array.isArray(m.content)) {
      out.push({
        role: m.role,
        content: m.content.map((item) => {
          if (typeof item === "string") {
            return { type: roleType, text: item };
          }
          if (item && typeof item === "object") {
            if (item.type === "text" || item.type === "output_text" || item.type === "input_text") {
              return { ...item, type: roleType };
            }
          }
          return item;
        })
      });
      continue;
    }
    if (typeof m.content === "string") {
      out.push({
        role: m.role,
        content: [{ type: roleType, text: m.content }]
      });
      continue;
    }
    out.push({ role: m.role, content: [] });
  }
  return out;
}

function normalizeResponsesInput(input, textType = config.upstream.responsesTextType) {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: textType, text: input }] }];
  }
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    if (typeof item === "string") {
      return { role: "user", content: [{ type: textType, text: item }] };
    }
    if (!item || typeof item !== "object") return item;
    const role = typeof item.role === "string" ? item.role : "user";
    const roleType = getResponsesTextTypeByRole(role, textType);
    if (!Array.isArray(item.content)) {
      if (typeof item.content === "string") {
        return { role, content: [{ type: roleType, text: item.content }] };
      }
      return { ...item, role };
    }
    return {
      ...item,
      role,
      content: item.content.map((c) => {
        if (typeof c === "string") return { type: roleType, text: c };
        if (!c || typeof c !== "object") return c;
        if (c.type === "text" || c.type === "output_text" || c.type === "input_text") {
          return { ...c, type: roleType };
        }
        return c;
      })
    };
  });
}

function setIfDefined(target, key, value) {
  if (value !== undefined) target[key] = value;
}

function normalizeToolsForResponses(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    if (tool.type !== "function") return tool;
    if (tool.function && typeof tool.function === "object") {
      return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict
      };
    }
    return tool;
  });
}

function normalizeToolChoiceForResponses(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return toolChoice;
  if (toolChoice.type !== "function") return toolChoice;
  if (typeof toolChoice.name === "string") return toolChoice;
  if (toolChoice.function && typeof toolChoice.function === "object") {
    return {
      type: "function",
      name: toolChoice.function.name
    };
  }
  return toolChoice;
}

export async function forwardToOpenClaw(openAiRequest) {
  const normalizedMessages = normalizeMessages(openAiRequest.messages);
  const useResponsesApi = config.upstream.wireApi === "responses";
  function buildUpstreamRequest(textTypeOverride) {
    if (useResponsesApi) {
      const textType = textTypeOverride || config.upstream.responsesTextType;
      const req = {
        model: openAiRequest.model,
        stream: Boolean(openAiRequest.stream),
        input:
          openAiRequest.input !== undefined
            ? normalizeResponsesInput(openAiRequest.input, textType)
            : toResponsesInput(normalizedMessages, textType)
      };
      setIfDefined(req, "instructions", openAiRequest.instructions);
      setIfDefined(req, "tools", normalizeToolsForResponses(openAiRequest.tools));
      setIfDefined(req, "tool_choice", normalizeToolChoiceForResponses(openAiRequest.tool_choice));
      setIfDefined(req, "parallel_tool_calls", openAiRequest.parallel_tool_calls);
      setIfDefined(req, "temperature", openAiRequest.temperature);
      setIfDefined(req, "top_p", openAiRequest.top_p);
      setIfDefined(req, "max_output_tokens", openAiRequest.max_tokens);
      setIfDefined(req, "reasoning", openAiRequest.reasoning);
      setIfDefined(req, "metadata", openAiRequest.metadata);
      return req;
    }
    return {
      model: openAiRequest.model,
      stream: Boolean(openAiRequest.stream),
      temperature: openAiRequest.temperature,
      top_p: openAiRequest.top_p,
      max_tokens: openAiRequest.max_tokens,
      tools: openAiRequest.tools,
      tool_choice: openAiRequest.tool_choice,
      parallel_tool_calls: openAiRequest.parallel_tool_calls,
      messages: normalizedMessages
    };
  }
  let upstreamRequest = buildUpstreamRequest();

  const targetPath = useResponsesApi ? config.upstream.responsesPath : config.upstream.chatPath;
  const url = `${config.upstream.baseUrl}${targetPath}`;
  const attempt = async () =>
    fetch(url, {
      method: "POST",
      headers: buildUpstreamHeaders(),
      body: JSON.stringify(upstreamRequest)
    });

  const shouldRetryWithAltType = async (response) => {
    if (!useResponsesApi || !openAiRequest.messages || response.status !== 400) return false;
    try {
      const text = await response.clone().text();
      if (!text) return false;
      const invalidInputText = text.includes("Invalid value: 'input_text'");
      const invalidOutputText = text.includes("Invalid value: 'output_text'");
      return invalidInputText || invalidOutputText;
    } catch {
      return false;
    }
  };

  let response = await attempt();
  if (response.status === 401 && config.upstream.authMode === "bearer") {
    const refreshed = await refreshToken();
    if (refreshed) response = await attempt();
  }
  if (await shouldRetryWithAltType(response)) {
    const altType = config.upstream.responsesTextType === "input_text" ? "output_text" : "input_text";
    upstreamRequest = buildUpstreamRequest(altType);
    response = await attempt();
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
