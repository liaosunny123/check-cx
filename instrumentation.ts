/**
 * Next.js Instrumentation Hook
 * 在服务器启动时执行，确保 poller 在 standalone 模式下也能初始化
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@/lib/core/poller");
  }
}
