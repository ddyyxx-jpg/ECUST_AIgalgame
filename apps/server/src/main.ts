/**
 * 服务入口：只做装配和启动。业务全在 packages/engine。
 * 用法：GALGAME_LLM_BASE_URL=... GALGAME_LLM_API_KEY=... npm run dev:server
 */
import Fastify from "fastify";
import { loadConfig, hasLlm } from "./config.ts";
import { registerRoutes } from "./routes.ts";
import { createApp } from "./bootstrap.ts";

const cfg = loadConfig();
const app = Fastify({
  logger: { level: process.env.GALGAME_LOG_LEVEL ?? "info" },
  // P1-4：反代后按真实 IP 计数限流；默认不信任转发头（直连部署保持原样）
  trustProxy: cfg.trustProxy ?? false,
});

const deps = await createApp(cfg);
registerRoutes(app, deps);

app.get("/", async (_req, reply) => reply.type("text/html").send(landing(cfg, hasLlm(cfg))));

try {
  await app.listen({ port: cfg.port, host: cfg.host });
  app.log.info(`galgame engine ${deps.version} on http://${cfg.host}:${cfg.port}  llm=${hasLlm(cfg) ? cfg.llm.model : "MOCK(no key)"}`);
} catch (e) {
  app.log.error(e);
  process.exit(1);
}

function landing(c: ReturnType<typeof loadConfig>, llm: boolean): string {
  return `<!doctype html><meta charset="utf-8"><title>ECUST AI 校园</title>
<body style="font:16px/1.7 system-ui;max-width:44rem;margin:8vh auto;padding:0 1.2rem">
<h1>ECUST · AI 校园（引擎已启动）</h1>
<p>契约版本 <code>${deps.version}</code>；LLM：<b>${llm ? c.llm.model : "未配置（走 Mock）"}</b></p>
<ul><li><code>GET /api/v1/health</code></li><li><code>POST /api/v1/rooms</code> → 建房</li>
<li><code>POST /api/v1/rooms/:id/turns</code> → SSE 行动流</li><li><code>GET /api/v1/rooms/:id/state</code></li></ul>
<p>前端开发：<code>npm run dev:web</code>（默认 5173，代理到 8787）</p></body>`;
}
