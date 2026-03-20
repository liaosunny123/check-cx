/**
 * Anthropic (Claude) 原始 HTTP 健康检查模块
 *
 * 1:1 复刻 Claude Code CLI 的真实请求，包括完整的 Headers 和 Body。
 * endpoint 和 apiKey 从数据库配置读取，其余完全硬编码。
 */

import type { CheckResult, HealthStatus, ProviderConfig } from "../types";
import { DEFAULT_ENDPOINTS } from "../types";
import { getSanitizedErrorDetail } from "../utils";
import { measureEndpointPing } from "./endpoint-ping";
import defaultBody from "./anthropic-default-body.json";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEGRADED_THRESHOLD_MS = 6_000;

/* ============================================================================
 * 1:1 复刻 Claude Code CLI Headers
 * ============================================================================ */

const DEFAULT_HEADERS: Record<string, string> = {
  "Accept": "application/json",
  "Content-Type": "application/json",
  "User-Agent": "claude-cli/2.1.71 (external, cli)",
  "X-Stainless-Arch": "arm64",
  "X-Stainless-Lang": "js",
  "X-Stainless-OS": "MacOS",
  "X-Stainless-Package-Version": "0.74.0",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Runtime-Version": "v24.3.0",
  "X-Stainless-Timeout": "600",
  "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07,adaptive-thinking-2026-01-28,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24",
  "anthropic-dangerous-direct-browser-access": "true",
  "anthropic-version": "2023-06-01",
  "x-app": "cli",
};

/* ============================================================================
 * SSE 解析
 * ============================================================================ */

interface SSEParseResult {
  collectedText: string;
  hasContent: boolean;
  errorMessage: string | null;
}

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
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) eventData = line.slice(5).trim();
        }
        if (!eventData || eventData === "[DONE]") continue;
        try {
          const parsed = JSON.parse(eventData);
          if (eventType === "error" || parsed.type === "error") {
            errorMessage = parsed.error?.message || parsed.message || "SSE 错误";
            return { collectedText, hasContent, errorMessage };
          }
          if (eventType === "content_block_delta" || parsed.type === "content_block_delta") {
            const delta = parsed.delta;
            if (delta?.type === "text_delta" && delta.text) { collectedText += delta.text; hasContent = true; }
            if (delta?.type === "thinking_delta") hasContent = true;
          }
          if (eventType === "message_start" || parsed.type === "message_start") hasContent = true;
        } catch { /* skip */ }
      }
    }
  } catch (error) {
    const err = error as Error & { name?: string };
    errorMessage = err?.name === "AbortError" ? "请求超时" : (err?.message || "流读取错误");
  } finally {
    reader.releaseLock();
  }
  return { collectedText, hasContent, errorMessage };
}

/* ============================================================================
 * 结果构建
 * ============================================================================ */

function buildResult(
  config: ProviderConfig, endpoint: string, pingLatencyMs: number | null,
  status: HealthStatus, latencyMs: number | null, message: string, logMessage?: string
): CheckResult {
  return {
    id: config.id, name: config.name, type: config.type, endpoint,
    model: config.model, status, latencyMs, pingLatencyMs,
    checkedAt: new Date().toISOString(), message,
    ...(logMessage ? { logMessage } : {}),
    groupName: config.groupName || null,
  };
}

/* ============================================================================
 * 主检查函数
 * ============================================================================ */

export async function checkAnthropicRaw(config: ProviderConfig): Promise<CheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  const displayEndpoint = config.endpoint || DEFAULT_ENDPOINTS.anthropic;
  // 原始请求 URL 带 ?beta=true
  const requestUrl = displayEndpoint.includes("?") ? displayEndpoint : `${displayEndpoint}?beta=true`;
  const pingPromise = measureEndpointPing(displayEndpoint);

  try {
    // 构建请求体：用默认 body，覆盖 model
    const metadata = config.metadata || {};
    let body: Record<string, unknown>;
    if (metadata.messages) {
      // 用户完全自定义
      body = { ...metadata, model: metadata.model || config.model, stream: true };
    } else {
      // 1:1 复刻默认 body，只替换 model
      body = { ...defaultBody, model: config.model };
    }

    // 构建 Headers
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      "Authorization": `Bearer ${config.apiKey}`,
      ...config.requestHeaders,
    };

    console.log(`[check-cx] Anthropic 原始 HTTP 检测: ${config.name} → ${displayEndpoint}`);

    const response = await fetch(requestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const pingLatencyMs = await pingPromise;

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      let errorMsg = `[${response.status}] ${response.statusText}`;
      if (errorBody) {
        try {
          const parsed = JSON.parse(errorBody);
          const detail = parsed.error?.message || parsed.message;
          if (detail) errorMsg = `[${response.status}] ${detail}`;
        } catch {
          if (errorBody.length < 200) errorMsg = `[${response.status}] ${errorBody}`;
        }
      }
      return buildResult(config, displayEndpoint, pingLatencyMs, "error", null, errorMsg, errorBody);
    }

    if (!response.body) {
      const latencyMs = Date.now() - startedAt;
      const text = await response.text();
      if (!text.trim()) return buildResult(config, displayEndpoint, pingLatencyMs, "failed", latencyMs, "回复为空");
      const status: HealthStatus = latencyMs <= DEGRADED_THRESHOLD_MS ? "operational" : "degraded";
      return buildResult(config, displayEndpoint, pingLatencyMs, status, latencyMs, `响应成功 (${latencyMs}ms)`);
    }

    const reader = response.body.getReader();
    const sseResult = await parseAnthropicSSE(reader, controller.signal);
    const latencyMs = Date.now() - startedAt;

    if (sseResult.errorMessage) {
      return buildResult(config, displayEndpoint, pingLatencyMs, "error", latencyMs, sseResult.errorMessage);
    }
    if (!sseResult.hasContent) {
      return buildResult(config, displayEndpoint, pingLatencyMs, "failed", latencyMs, "回复为空");
    }

    const status: HealthStatus = latencyMs <= DEGRADED_THRESHOLD_MS ? "operational" : "degraded";
    const message = status === "degraded" ? `响应成功但耗时 ${latencyMs}ms` : `响应成功 (${latencyMs}ms)`;
    return buildResult(config, displayEndpoint, pingLatencyMs, status, latencyMs, message);
  } catch (error) {
    const pingLatencyMs = await pingPromise;
    const err = error as Error & { name?: string };
    if (err?.name === "AbortError") {
      return buildResult(config, displayEndpoint, pingLatencyMs, "error", null, "请求超时");
    }
    return buildResult(config, displayEndpoint, pingLatencyMs, "error", null,
      err?.message || "未知错误", getSanitizedErrorDetail(error));
  } finally {
    clearTimeout(timeout);
  }
}
