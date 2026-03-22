/**
 * Anthropic (Claude) 原始 HTTP 健康检查模块
 *
 * 使用 raw fetch 直接发送 /v1/messages 格式的 HTTP 请求，
 * 完全模拟真实的 Claude CLI API 调用。
 *
 * 默认请求模板模拟 Claude Code CLI 的真实请求格式，包括：
 * - 完整的 Headers（anthropic-beta、User-Agent 等）
 * - 真实的请求体结构（messages、system、max_tokens、thinking、stream 等）
 *
 * 无需配置 metadata 即可使用，开箱即用。
 */

import type { CheckResult, HealthStatus, ProviderConfig } from "../types";
import { DEFAULT_ENDPOINTS } from "../types";
import { getSanitizedErrorDetail } from "../utils";
import { measureEndpointPing } from "./endpoint-ping";

/** 默认超时时间（毫秒）*/
const DEFAULT_TIMEOUT_MS = 45_000;

/** 性能降级阈值（毫秒）*/
const DEGRADED_THRESHOLD_MS = 6_000;

/* ============================================================================
 * 默认请求模板 - 模拟 Claude Code CLI 真实请求
 * ============================================================================ */

/** 判断是否为 Haiku 模型 */
function isHaikuModel(model: string): boolean {
  return model.toLowerCase().includes("haiku");
}

/** 共享 Headers */
const SHARED_HEADERS: Record<string, string> = {
  "Accept": "application/json",
  "Content-Type": "application/json",
  "User-Agent": "claude-cli/2.1.81 (external, cli)",
  "X-Stainless-Arch": "arm64",
  "X-Stainless-Lang": "js",
  "X-Stainless-OS": "MacOS",
  "X-Stainless-Package-Version": "0.74.0",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Runtime-Version": "v24.3.0",
  "X-Stainless-Timeout": "600",
  "anthropic-dangerous-direct-browser-access": "true",
  "anthropic-version": "2023-06-01",
  "x-app": "cli",
};

/** Haiku 专用 anthropic-beta */
const HAIKU_BETA =
  "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,structured-outputs-2025-12-15";

/** Opus/Sonnet 专用 anthropic-beta */
const OPUS_SONNET_BETA =
  "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24";

/** 根据模型返回对应的 Headers */
function getDefaultHeaders(model: string): Record<string, string> {
  return {
    ...SHARED_HEADERS,
    "anthropic-beta": isHaikuModel(model) ? HAIKU_BETA : OPUS_SONNET_BETA,
  };
}

/**
 * 构建默认请求体 - 根据模型类型模拟 Claude Code CLI 的真实请求
 */
function buildDefaultRequestBody(model: string): Record<string, unknown> {
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    },
  ];

  const system = [
    {
      type: "text",
      text: "You are Claude Code, an interactive agent. Respond concisely.",
    },
  ];

  if (isHaikuModel(model)) {
    // Haiku: 简单请求，无 thinking
    return {
      model,
      messages,
      system,
      max_tokens: 32000,
      temperature: 1,
      stream: true,
    };
  }

  // Opus/Sonnet: 带 thinking 和 effort
  return {
    model,
    messages,
    system,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    context_management: {
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    },
    output_config: { effort: "high" },
    stream: true,
  };
}

/* ============================================================================
 * SSE 流式解析
 * ============================================================================ */

interface SSEParseResult {
  collectedText: string;
  hasContent: boolean;
  errorMessage: string | null;
}

/**
 * 解析 Anthropic SSE 流式响应
 */
async function parseAnthropicSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<SSEParseResult> {
  const decoder = new TextDecoder();
  let buffer = "";
  let collectedText = "";
  let hasContent = false;
  let errorMessage: string | null = null;

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const event of events) {
        if (!event.trim()) continue;

        const lines = event.split("\n");
        let eventType = "";
        let eventData = "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            eventData = line.slice(5).trim();
          }
        }

        if (!eventData || eventData === "[DONE]") continue;

        try {
          const parsed = JSON.parse(eventData);

          if (eventType === "error" || parsed.type === "error") {
            errorMessage = parsed.error?.message || parsed.message || "SSE 错误";
            return { collectedText, hasContent, errorMessage };
          }

          if (
            eventType === "content_block_delta" ||
            parsed.type === "content_block_delta"
          ) {
            const delta = parsed.delta;
            if (delta?.type === "text_delta" && delta.text) {
              collectedText += delta.text;
              hasContent = true;
            }
            if (delta?.type === "thinking_delta") {
              hasContent = true;
            }
          }

          if (
            eventType === "message_start" ||
            parsed.type === "message_start"
          ) {
            hasContent = true;
          }
        } catch {
          // JSON 解析失败，跳过
        }
      }
    }
  } catch (error) {
    const err = error as Error & { name?: string };
    if (err?.name === "AbortError") {
      errorMessage = "请求超时";
    } else {
      errorMessage = err?.message || "流读取错误";
    }
  } finally {
    reader.releaseLock();
  }

  return { collectedText, hasContent, errorMessage };
}

/* ============================================================================
 * 请求体构建
 * ============================================================================ */

/**
 * 构建 Anthropic API 请求体
 *
 * 如果 metadata 中有 messages，使用 metadata 作为请求体（用户完全自定义）。
 * 否则使用默认模板（模拟 Claude CLI 真实请求）。
 */
function buildRequestBody(config: ProviderConfig): Record<string, unknown> {
  const metadata = config.metadata || {};

  // 用户在 metadata 中提供了完整请求体
  if (metadata.messages) {
    return {
      ...metadata,
      model: metadata.model || config.model,
      stream: true,
    };
  }

  // 使用默认模板
  const defaultBody = buildDefaultRequestBody(config.model);
  // 合并 metadata 中的其他配置（如 max_tokens 覆盖等）
  return { ...defaultBody, ...metadata, stream: true };
}

/* ============================================================================
 * 结果构建
 * ============================================================================ */

function buildResult(
  config: ProviderConfig,
  endpoint: string,
  pingLatencyMs: number | null,
  status: HealthStatus,
  latencyMs: number | null,
  message: string,
  logMessage?: string
): CheckResult {
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    endpoint,
    model: config.model,
    status,
    latencyMs,
    pingLatencyMs,
    checkedAt: new Date().toISOString(),
    message,
    ...(logMessage ? { logMessage } : {}),
    groupName: config.groupName || null,
  };
}

/* ============================================================================
 * 主检查函数
 * ============================================================================ */

/**
 * Anthropic 原始 HTTP 健康检查
 *
 * 默认模拟 Claude Code CLI 的真实请求格式，无需额外配置。
 * 收到 message_start 或 content_block_delta 即判定服务可用。
 */
export async function checkAnthropicRaw(config: ProviderConfig): Promise<CheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  const displayEndpoint = config.endpoint || DEFAULT_ENDPOINTS.anthropic;
  const pingPromise = measureEndpointPing(displayEndpoint);

  try {
    const body = buildRequestBody(config);

    // 构建 Headers：模型对应模板 + 认证 + 用户自定义覆盖
    const headers: Record<string, string> = {
      ...getDefaultHeaders(config.model),
      "x-api-key": config.apiKey,
      "Authorization": `Bearer ${config.apiKey}`,
      // 用户自定义 headers 最高优先级
      ...config.requestHeaders,
    };

    console.log(
      `[check-cx] Anthropic 原始 HTTP 检测: ${config.name} → ${displayEndpoint}`
    );

    // 添加 ?beta=true 参数，模拟 Claude CLI 请求
    const fetchUrl = displayEndpoint.includes("?")
      ? `${displayEndpoint}&beta=true`
      : `${displayEndpoint}?beta=true`;

    const response = await fetch(fetchUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const pingLatencyMs = await pingPromise;

    // HTTP 错误
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      let errorMsg = `[${response.status}] ${response.statusText}`;

      if (errorBody) {
        try {
          const parsed = JSON.parse(errorBody);
          const detail = parsed.error?.message || parsed.message;
          if (detail) errorMsg = `[${response.status}] ${detail}`;
        } catch {
          if (errorBody.length < 200) {
            errorMsg = `[${response.status}] ${errorBody}`;
          }
        }
      }

      return buildResult(config, displayEndpoint, pingLatencyMs, "error", null, errorMsg, errorBody);
    }

    // 非流式响应兜底
    if (!response.body) {
      const latencyMs = Date.now() - startedAt;
      const text = await response.text();
      if (!text.trim()) {
        return buildResult(config, displayEndpoint, pingLatencyMs, "failed", latencyMs, "回复为空");
      }
      const status: HealthStatus = latencyMs <= DEGRADED_THRESHOLD_MS ? "operational" : "degraded";
      return buildResult(config, displayEndpoint, pingLatencyMs, status, latencyMs, `响应成功 (${latencyMs}ms)`);
    }

    // 流式响应：解析 SSE
    const reader = response.body.getReader();
    const sseResult = await parseAnthropicSSE(reader, controller.signal);
    const latencyMs = Date.now() - startedAt;

    if (sseResult.errorMessage) {
      return buildResult(
        config, displayEndpoint, pingLatencyMs,
        "error", latencyMs, sseResult.errorMessage
      );
    }

    if (!sseResult.hasContent) {
      return buildResult(config, displayEndpoint, pingLatencyMs, "failed", latencyMs, "回复为空");
    }

    // 收到内容即视为成功
    const status: HealthStatus = latencyMs <= DEGRADED_THRESHOLD_MS ? "operational" : "degraded";
    const message = status === "degraded"
      ? `响应成功但耗时 ${latencyMs}ms`
      : `响应成功 (${latencyMs}ms)`;
    return buildResult(config, displayEndpoint, pingLatencyMs, status, latencyMs, message);
  } catch (error) {
    const pingLatencyMs = await pingPromise;
    const err = error as Error & { name?: string };

    if (err?.name === "AbortError") {
      return buildResult(config, displayEndpoint, pingLatencyMs, "error", null, "请求超时");
    }

    return buildResult(
      config, displayEndpoint, pingLatencyMs,
      "error", null,
      err?.message || "未知错误",
      getSanitizedErrorDetail(error)
    );
  } finally {
    clearTimeout(timeout);
  }
}
