/// <reference types="@cloudflare/workers-types" />

export interface Env {
  TELEGRAM_BOT_TOKEN: string; // configured via wrangler vars
  WEBHOOK_SECRET?: string;    // configured via wrangler vars
  BOT_KV: KVNamespace;
  WEBHOOK_PATH?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return new Response("ok", { status: 200 });
    }

    const webhookPath = env.WEBHOOK_PATH || "/webhook";

    if (req.method === "POST" && url.pathname === webhookPath) {
      if (env.WEBHOOK_SECRET) {
        const token = req.headers.get("x-telegram-bot-api-secret-token");
        if (token !== env.WEBHOOK_SECRET) {
          return new Response("unauthorized", { status: 401 });
        }
      }

      try {
        await req.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }

      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }
};
