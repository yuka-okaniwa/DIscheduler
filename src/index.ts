// Worker のエントリ（fetch / scheduled）
import { Hono } from "hono";
import type { Env } from "./core/env";
import { api } from "./api";
import { runCron } from "./jobs/cron";
import { handleInteraction } from "./discord/interactions";
import { verifyDiscordRequest } from "./discord/verify";
import { AppError, isQuotaError, nowSec, QUOTA_MSG, randomToken } from "./core/lib";
import { pick, requestLang } from "./shared/i18n";

/** すべての応答に付けるセキュリティヘッダー（docs/security-design.md §4.2） */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'; upgrade-insecure-requests",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  const res = new Response(c.res.body, c.res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  c.res = res;
});

/** 入力リンクや案内に使う、正式な公開アドレス */
export function publicOrigin(env: Env, url: string): string {
  return env.PUBLIC_ORIGIN || new URL(url).origin;
}

// 正式なアドレス以外（旧アドレスの Worker、Pages のデプロイごとの別名のアドレス）へのアクセスは、正式なアドレスへ転送する。
// Discord からの通信だけは、Interactions Endpoint URL を切り替えるまでの間も受けられるよう、そのまま処理する
// （Discord は転送に従わないため）。入力リンクは正式なアドレスで発行する。
app.use("*", async (c, next) => {
  const canonical = c.env.PUBLIC_ORIGIN;
  const url = new URL(c.req.url);
  if (!canonical || url.origin === canonical) return next();
  if (c.req.method === "POST" && url.pathname === "/discord/interactions") return next();
  if (c.req.method === "GET" || c.req.method === "HEAD") return c.redirect(canonical + url.pathname + url.search, 301);
  return c.text("Not Found", 404);
});

app.onError((err, c) => {
  // エラーの文言は、画面の言語（X-DI-Lang）か Accept-Language に合わせる（§6.12）
  const lang = requestLang((n) => c.req.header(n));
  // messages には両方の言語を入れる（画面で言語を切り替えたとき、読み込み直さずに文言を入れ替えられるように）
  if (err instanceof AppError) return c.json({ error: { code: err.code, message: pick(err.text, lang), messages: err.text } }, err.status as 400);
  if (isQuotaError(err)) return c.json({ error: { code: "free_tier_exceeded", message: pick(QUOTA_MSG, lang), messages: QUOTA_MSG } }, 503);
  const ref = randomToken(6);
  console.error(JSON.stringify({ event: "unhandled_error", ref, error: err instanceof Error ? err.message : "unknown" }));
  const messages = {
    ja: `エラーが発生しました。時間をおいてもう一度お試しください（参照番号: ${ref}）。`,
    en: `Something went wrong. Please try again later (reference: ${ref}).`,
  };
  return c.json({ error: { code: "internal", message: pick(messages, lang), messages } }, 500);
});

app.post("/discord/interactions", async (c) => {
  const body = await verifyDiscordRequest(c.req.raw, c.env.DISCORD_PUBLIC_KEY, nowSec());
  if (body === null) return c.text("invalid request signature", 401);
  const interaction = JSON.parse(body);
  return handleInteraction(c.env, c.executionCtx, interaction, publicOrigin(c.env, c.req.url));
});

app.route("/api", api);

// Web 画面（S1〜S5・S7）は 1 つの HTML から表示する
async function appShell(c: { env: Env; req: { url: string } }): Promise<Response> {
  const res = await c.env.ASSETS.fetch(new Request(new URL("/app/", c.req.url)));
  return new Response(res.body, { status: res.ok ? 200 : 500, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
app.get("/l", (c) => appShell(c));
app.get("/p/:id", (c) => appShell(c));
app.get("/p/:id/:page{(edit|answer|done)}", (c) => appShell(c));
app.get("/g/:guildId/polls", (c) => appShell(c));

app.notFound((c) => c.text("Not Found", 404));

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env, controller.scheduledTime, controller.cron));
  },
} satisfies ExportedHandler<Env>;
