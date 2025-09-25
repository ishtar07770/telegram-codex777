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

    const invokeOpenAI = async (prompt: string) => {
      const model = env.OPENAI_MODEL || "gpt-4o-mini";
      const openaiRequestBody = {
        model,
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
                text: prompt,
              },
            ],
          },
        ],
      };

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(openaiRequestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
      }

      const data: any = await response.json();
      const outputText =
        typeof data?.output_text === "string" && data.output_text.trim().length > 0
          ? data.output_text.trim()
          : data?.output
              ?.flatMap((item: any) => item?.content || [])
              ?.find((part: any) => part?.type === "output_text")?.text;

      const answerText =
        typeof outputText === "string" && outputText.trim().length > 0
          ? outputText.trim()
          : "پاسخی از مدل دریافت نشد.";

      return {
        model,
        input: prompt,
        answer: answerText,
        usage: {
          input_tokens: data?.usage?.input_tokens ?? null,
          output_tokens: data?.usage?.output_tokens ?? null,
          total_tokens:
            data?.usage?.input_tokens != null && data?.usage?.output_tokens != null
              ? data.usage.input_tokens + data.usage.output_tokens
              : null,
        },
        meta: {
          id: data?.id ?? null,
          created: data?.created ?? null,
          stop_reason: data?.output?.[0]?.stop_reason ?? data?.output?.[0]?.finish_reason ?? null,
        },
      };
    };

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

        const telegramApiUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

        try {
          const openAiResult = await invokeOpenAI(text);
          const answerText =
            typeof openAiResult?.answer === "string" && openAiResult.answer.trim().length > 0
              ? openAiResult.answer.trim()
              : "پاسخی از مدل دریافت نشد.";

          const payload = {
            chat_id: chatId,
            text: answerText,

          const formattedResult = JSON.stringify(openAiResult, null, 2);
          const trimmedResult =
            formattedResult.length > 4000 ? `${formattedResult.slice(0, 3997)}...` : formattedResult;

          const payload = {
            chat_id: chatId,
            text: trimmedResult,
          };

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
            console.log("Sent OpenAI response to Telegram", payload);
          }
        } catch (error) {
          console.error("Failed to call OpenAI API", error);
          const fallbackPayload = {
            chat_id: chatId,
            text: "خطایی در برقراری ارتباط با سرویس هوش مصنوعی رخ داد.",
          };

          try {
            const response = await fetch(telegramApiUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: JSON.stringify(fallbackPayload),
            });

            if (!response.ok) {
              const errorText = await response.text();
              console.error("Telegram sendMessage failed", response.status, errorText);
              return new Response("telegram error", { status: 502 });
            }
          } catch (telegramError) {
            console.error("Failed to call Telegram sendMessage", telegramError);
            return new Response("telegram error", { status: 502 });
          }
        }
      } else {
        console.log("No message to echo in update", update);
      }

      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },
};
