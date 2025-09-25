/// <reference types="@cloudflare/workers-types" />

export interface Env {
  TELEGRAM_BOT_TOKEN: string; // configured via wrangler vars
  WEBHOOK_SECRET?: string; // configured via wrangler vars
  BOT_KV: KVNamespace;
  WEBHOOK_PATH?: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
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
        if (!env.OPENAI_API_KEY) {
          console.error("Missing OPENAI_API_KEY binding");
          return new Response("missing openai api key", { status: 500 });
        }

        const model = env.OPENAI_MODEL || "gpt-5-mini";


        const quotaBackoffKey = "openai:quota:block-until";
        const now = Date.now();
        const blockUntilRaw = await env.BOT_KV.get(quotaBackoffKey);
        const blockUntil = blockUntilRaw ? Number(blockUntilRaw) : undefined;

        if (blockUntil && Number.isFinite(blockUntil) && now < blockUntil) {
          const waitMinutes = Math.ceil((blockUntil - now) / 60000);
          const assistantReply =
            waitMinutes > 0
              ? `سقف استفاده از سرویس هوش مصنوعی پر شده است. لطفاً ${waitMinutes} دقیقه دیگر دوباره تلاش کنید.`
              : "سقف استفاده از سرویس هوش مصنوعی پر شده است. لطفاً کمی بعد دوباره تلاش کنید.";

          try {
            await sendTelegramMessage(env, chatId, assistantReply);
          } catch (error) {
            return new Response("telegram error", { status: 502 });
          }

          return new Response("ok", { status: 200 });
        }

        const openaiRequestBody = {
          model,

        const openaiRequestBody = {
          model,


          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `You are a helpful AI assistant replying in the same language the user used.\n\nUser message: ${text}`,
                },
              ],
            },
          ],

          input: [
            {
              role: "system",
              content: [
                {

                  type: "input_text",

                  text: "You are a helpful AI assistant replying in the same language the user used.",
                },
              ],
            },
            {
              role: "user",
              content: [
                {

                  type: "input_text",

                  text,
                },
              ],
            },
          ],



          max_output_tokens: 800,
        };

        let assistantReply = "";

        let quotaExceeded = false;


        try {
          const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify(openaiRequestBody),
          });

          if (!openaiResponse.ok) {
            const errorText = await openaiResponse.text();
            console.error(
              "OpenAI API request failed",
              openaiResponse.status,
              errorText,
            );
            assistantReply =
              "متاسفم، در حال حاضر نمی‌توانم پاسخ بدهم. لطفاً بعداً دوباره تلاش کنید.";
          } else {
            const data = await openaiResponse.json();

            const responseText =
              data?.output_text ||
              data?.output?.flatMap((item: any) => item?.content || [])
                ?.find((part: any) => part?.type === "output_text")?.text ||

              data?.output?.[0]?.content?.find(
                (part: any) => part?.type === "output_text",
              )?.text;

              data?.output?.[0]?.content?.[0]?.text;


            assistantReply =
              typeof responseText === "string" && responseText.trim().length > 0
                ? responseText.trim()
                : "پاسخی از مدل دریافت نشد.";


            assistantReply =
              data?.output_text ||
              data?.output?.[0]?.content?.[0]?.text ||
              "پاسخی از مدل دریافت نشد.";


          }
        } catch (error) {
          console.error("Failed to call OpenAI API", error);
          assistantReply =
            "خطایی در برقراری ارتباط با سرویس هوش مصنوعی رخ داد.";
        }

        const telegramApiUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        const payload = { chat_id: chatId, text: assistantReply };


        try {
          const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify(openaiRequestBody),
          });

          if (!openaiResponse.ok) {
            const errorText = await openaiResponse.text();
            console.error(
              "OpenAI API request failed",
              openaiResponse.status,
              errorText,
            );

            if (openaiResponse.status === 429 && errorText.includes("insufficient_quota")) {
              quotaExceeded = true;
              assistantReply =
                "سقف استفاده از سرویس هوش مصنوعی موقتا تکمیل شده است. لطفاً بعداً دوباره تلاش کنید.";
            } else {
              assistantReply =
                "متاسفم، در حال حاضر نمی‌توانم پاسخ بدهم. لطفاً بعداً دوباره تلاش کنید.";
            }
          } else {
            const data = await openaiResponse.json();
            const responseText =
              data?.output_text ||
              data?.output?.flatMap((item: any) => item?.content || [])
                ?.find((part: any) => part?.type === "output_text")?.text ||
              data?.output?.[0]?.content?.find(
                (part: any) => part?.type === "output_text",
              )?.text;

            assistantReply =
              typeof responseText === "string" && responseText.trim().length > 0
                ? responseText.trim()
                : "پاسخی از مدل دریافت نشد.";
          }
        } catch (error) {
          console.error("Failed to call OpenAI API", error);
          assistantReply =
            "خطایی در برقراری ارتباط با سرویس هوش مصنوعی رخ داد.";
        }

        if (quotaExceeded) {
          const backoffUntil = (Date.now() + 60 * 60 * 1000).toString();
          await env.BOT_KV.put(quotaBackoffKey, backoffUntil, { expirationTtl: 60 * 60 * 2 });
        }

        try {
          await sendTelegramMessage(env, chatId, assistantReply);
        } catch (error) {
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

async function sendTelegramMessage(env: Env, chatId: number, text: string) {
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
      console.error("Telegram sendMessage failed", response.status, errorText);
    } else {
      console.log("Sent message to Telegram", payload);
    }
  } catch (error) {
    console.error("Failed to call Telegram sendMessage", error);
    throw error;
  }
}
