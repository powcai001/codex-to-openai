import http from "node:http";
import crypto from "node:crypto";
import { config } from "./config.js";
import { extractTextFromPayload, forwardToOpenClaw } from "./openclaw-client.js";

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function makeOpenAiError(message, code, type = "invalid_request_error") {
  return { error: { message, type, code } };
}

function getRouteType(req) {
  if (req.method !== "POST") return null;
  let pathname = req.url || "";
  try {
    pathname = new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    // fallback to raw req.url
  }
  if (
    pathname === "/v1/chat/completions" ||
    pathname === "/v1/chat/completions/" ||
    pathname === "/chat/completions" ||
    pathname === "/chat/completions/"
  ) {
    return "chat";
  }
  if (
    pathname === "/v1/responses" ||
    pathname === "/v1/responses/" ||
    pathname === "/responses" ||
    pathname === "/responses/"
  ) {
    return "responses";
  }
  return null;
}

function buildMessagesFromResponsesInput(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (Array.isArray(input)) {
    const text = input
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.content === "string") return item.content;
        if (Array.isArray(item?.content)) {
          return item.content
            .map((c) => (typeof c?.text === "string" ? c.text : typeof c === "string" ? c : ""))
            .join("\n");
        }
        return "";
      })
      .join("\n");
    return [{ role: "user", content: text }];
  }
  return [];
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function verifyInboundApiKey(req) {
  if (!config.openAiProxyApiKey) return true;
  const auth = req.headers.authorization || "";
  const expected = `Bearer ${config.openAiProxyApiKey}`;
  return auth === expected;
}

function openAiCompletionShape({ model, content }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: now,
    model: model || "unknown",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content }
      }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

function openAiResponsesShape({ model, content }) {
  return {
    id: `resp_${crypto.randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: model || "unknown",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: content,
            annotations: []
          }
        ]
      }
    ],
    output_text: content,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0
    }
  };
}

function sendSseStart(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
}

function writeSseData(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function createDeltaChunk({ id, model, content, finishReason = null }) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model || "unknown",
    choices: [
      {
        index: 0,
        delta: content ? { content } : {},
        finish_reason: finishReason
      }
    ]
  };
}

function parseSseText(raw) {
  const lines = raw.split(/\r?\n/);
  let currentEvent = "";
  let finalText = "";
  let payload = null;
  for (const line of lines) {
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      const parsed = JSON.parse(data);
      if (currentEvent === "response.output_text.delta" && typeof parsed.delta === "string") {
        finalText += parsed.delta;
      }
      if (currentEvent === "response.output_text.done" && typeof parsed.text === "string") {
        finalText = parsed.text;
      }
      if (currentEvent === "response.completed" && parsed.response) {
        payload = parsed.response;
      }
    } catch {
      // ignore non-JSON SSE lines
    }
  }
  return { finalText, payload };
}

async function readUpstreamResult(upstream) {
  const contentType = upstream.headers.get("content-type") || "";
  const raw = await upstream.text();
  if (contentType.includes("application/json")) {
    try {
      return { payload: JSON.parse(raw), text: "" };
    } catch {
      return { payload: null, text: raw || "" };
    }
  }
  if (contentType.includes("text/event-stream") || raw.includes("event:")) {
    const parsed = parseSseText(raw);
    return { payload: parsed.payload, text: parsed.finalText };
  }
  return { payload: null, text: raw || "" };
}

async function pipeUpstreamAsOpenAiSse({ upstream, reqBody, res }) {
  sendSseStart(res);
  const responseId = `chatcmpl-${crypto.randomUUID()}`;

  if (!upstream.body) {
    writeSseData(res, createDeltaChunk({ id: responseId, model: reqBody.model, content: "" }));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const contentType = upstream.headers.get("content-type") || "";
  const isEventStream = contentType.includes("text/event-stream");
  let buffer = "";
  let completed = false;
  while (true) {
    const read = await reader.read();
    if (read.done) break;
    const text = decoder.decode(read.value, { stream: true });

    if (!isEventStream) {
      const trimmed = text.trim();
      if (trimmed) {
        writeSseData(res, createDeltaChunk({ id: responseId, model: reqBody.model, content: trimmed }));
      }
      continue;
    }

    buffer += text;
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      let eventName = "";
      let eventData = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        if (line.startsWith("data:")) eventData += `${line.slice(5).trim()}\n`;
      }
      if (!eventData) continue;
      try {
        const parsed = JSON.parse(eventData.trim());
        if (eventName === "response.output_text.delta" && typeof parsed.delta === "string") {
          writeSseData(
            res,
            createDeltaChunk({ id: responseId, model: reqBody.model, content: parsed.delta })
          );
        }
        if (eventName === "response.completed") {
          completed = true;
        }
      } catch {
        // ignore non-JSON chunks
      }
    }
  }

  if (!completed && buffer.trim()) {
    const fallback = buffer.replace(/^data:\s?/gm, "").trim();
    if (fallback) {
      writeSseData(res, createDeltaChunk({ id: responseId, model: reqBody.model, content: fallback }));
    }
  }

  writeSseData(res, createDeltaChunk({ id: responseId, model: reqBody.model, content: "", finishReason: "stop" }));
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }

    const routeType = getRouteType(req);
    if (!routeType) {
      sendJson(res, 404, makeOpenAiError("Not found", "not_found_error"));
      return;
    }

    if (!verifyInboundApiKey(req)) {
      sendJson(res, 401, makeOpenAiError("Invalid API key", "invalid_api_key", "auth_error"));
      return;
    }

    const reqBody = await readJsonBody(req);
    if (routeType === "responses" && reqBody.stream) {
      sendJson(
        res,
        400,
        makeOpenAiError("`/v1/responses` stream is not supported in this proxy yet", "unsupported_stream")
      );
      return;
    }

    if (routeType === "responses") {
      reqBody.messages = buildMessagesFromResponsesInput(reqBody.input);
    }

    if (!Array.isArray(reqBody.messages) || reqBody.messages.length === 0) {
      sendJson(
        res,
        400,
        makeOpenAiError("`messages` must be a non-empty array", "invalid_messages")
      );
      return;
    }

    const upstream = await forwardToOpenClaw(reqBody);
    if (!upstream.ok) {
      let detail = `${upstream.status} ${upstream.statusText}`;
      try {
        const errorText = await upstream.text();
        if (errorText) detail = `${detail} - ${errorText.slice(0, 400)}`;
      } catch {
        // ignore payload parse error
      }
      sendJson(res, 502, makeOpenAiError(`Upstream error: ${detail}`, "upstream_error"));
      return;
    }

    if (routeType === "chat" && reqBody.stream) {
      await pipeUpstreamAsOpenAiSse({ upstream, reqBody, res });
      return;
    }

    const upstreamResult = await readUpstreamResult(upstream);
    const payload = upstreamResult.payload;
    if (payload?.object === "chat.completion" && Array.isArray(payload?.choices)) {
      sendJson(res, 200, payload);
      return;
    }

    const content = extractTextFromPayload(payload) || upstreamResult.text || "";
    if (routeType === "responses") {
      sendJson(res, 200, openAiResponsesShape({ model: reqBody.model, content }));
      return;
    }

    sendJson(res, 200, openAiCompletionShape({ model: reqBody.model, content }));
  } catch (error) {
    sendJson(res, 500, makeOpenAiError(error.message || "Internal server error", "server_error"));
  }
});

server.listen(config.port, config.host, () => {
  console.log(`openclaw-openai-proxy running at http://${config.host}:${config.port}`);
});
