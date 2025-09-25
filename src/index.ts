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

      return {
        answer:
          typeof outputText === "string" && outputText.trim().length > 0
            ? outputText.trim()
            : "پاسخی از مدل دریافت نشد.",
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

        let assistantReply = "";
        let usageSummary: string | null = null;

        try {
          const { answer, usage } = await invokeOpenAI(text);
          assistantReply = answer;

          if (usage.input_tokens != null || usage.output_tokens != null) {
            const tokensInfo = [
              usage.input_tokens != null ? `Input tokens: ${usage.input_tokens}` : null,
              usage.output_tokens != null ? `Output tokens: ${usage.output_tokens}` : null,
              usage.total_tokens != null ? `Total tokens: ${usage.total_tokens}` : null,
            ].filter(Boolean);

            if (tokensInfo.length > 0) {
              usageSummary = tokensInfo.join(" | ");
            }
          }
        } catch (error) {
          console.error("Failed to call OpenAI API", error);
          assistantReply =
            "خطایی در برقراری ارتباط با سرویس هوش مصنوعی رخ داد.";
        }

        const telegramApiUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        const payload = {
          chat_id: chatId,
          text: usageSummary ? `${assistantReply}\n\n${usageSummary}` : assistantReply,
        };

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
