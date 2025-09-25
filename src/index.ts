/// <reference types="@cloudflare/workers-types" />

export interface Env {
  TELEGRAM_BOT_TOKEN: string; // configured via wrangler vars
  WEBHOOK_SECRET?: string; // configured via wrangler vars
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

      let update: any;
      try {
        update = await req.json();
      } catch (err) {
        console.error("Failed to parse Telegram update", err);
        return new Response("bad json", { status: 400 });
      }

      console.log("Incoming update", update);

      const message = update?.message;
      const chatId = message?.chat?.id;
      const text = message?.text;

      if (chatId && typeof text === "string") {
        const telegramApiUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        const payload = { chat_id: chatId, text };

        try {
          const response = await fetch(telegramApiUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error(
              "Telegram sendMessage failed",
              response.status,
              errorText,
            );
          } else {
            console.log("Echoed message to Telegram", payload);
          }
        } catch (error) {
          console.error("Failed to call Telegram sendMessage", error);
          return new Response("telegram error", { status: 502 });
        }
      } else {
        console.log("No message to echo in update", update);
      }

      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },
};
