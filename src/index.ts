/// <reference types="@cloudflare/workers-types" />

export interface Env {
  TELEGRAM_BOT_TOKEN: string; // configured via wrangler vars
  WEBHOOK_SECRET?: string;    // configured via wrangler vars
  BOT_KV: KVNamespace;
  WEBHOOK_PATH?: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  OPENAI_VOICE_MODEL?: string;
  OPENAI_VOICE?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // --- Helper: send long text in safe chunks to Telegram ---
    const sendTelegramText = async (chatId: number, text: string) => {
      const telegramApiUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const MAX = 4000; // کمی کمتر از محدودیت 4096 تایی تلگرام
      for (let i = 0; i < text.length; i += MAX) {
        const chunk = text.slice(i, i + MAX);
        const resp = await fetch(telegramApiUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: chunk }),
        });
        if (!resp.ok) {
          const errorText = await resp.text();
          console.error("Telegram sendMessage failed", resp.status, errorText);
          // ادامه می‌دهیم تا بقیه‌ی تکه‌ها (اگر بود) هم تلاش شوند
        }
      }
    };

    const sendTelegramVoice = async (
      chatId: number,
      audioBuffer: ArrayBuffer,
      caption?: string
    ) => {
      const telegramApiUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendVoice`;
      const formData = new FormData();
      formData.append("chat_id", chatId.toString());
      const voiceBlob = new Blob([audioBuffer], { type: "audio/ogg" });
      formData.append("voice", voiceBlob, "response.ogg");
      if (caption) {
        formData.append("caption", caption);
      }

      const resp = await fetch(telegramApiUrl, {
        method: "POST",
        body: formData,
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        console.error("Telegram sendVoice failed", resp.status, errorText);
      }
    };

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

      // اول تلاش می‌کنیم output_text را بگیریم؛ در غیر این صورت از آرایه‌ی output استخراج می‌کنیم
      const outputText =
        (typeof data?.output_text === "string" && data.output_text.trim()) ||
        data?.output
          ?.flatMap((item: any) => item?.content || [])
          ?.find((part: any) => part?.type === "output_text")?.text ||
        "";

      const answerText = outputText.trim() || "پاسخی از مدل دریافت نشد.";

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

    const synthesizeVoice = async (text: string) => {
      const trimmedText = text.trim();
      if (!trimmedText) {
        throw new Error("Cannot synthesize empty text");
      }

      const voiceModel = env.OPENAI_VOICE_MODEL || "gpt-4o-mini-tts";
      const voiceName = env.OPENAI_VOICE || "alloy";

      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: voiceModel,
          voice: voiceName,
          input: trimmedText,
          response_format: "opus",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI TTS request failed (${response.status}): ${errorText}`);
      }

      return await response.arrayBuffer();
    };

    if (req.method === "GET" && url.pathname === "/") {
      return new Response("ok", { status: 200 });
    }

    const webhookPath = env.WEBHOOK_PATH || "/webhook";

    if (req.method === "POST" && url.pathname === webhookPath) {
      // امنیت وبهوک با secret token
      if (env.WEBHOOK_SECRET) {
        const token = req.headers.get("x-telegram-bot-api-secret-token");
        if (token !== env.WEBHOOK_SECRET) {
          return new Response("unauthorized", { status: 401 });
        }
      }

      // خواندن آپدیت تلگرام
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

        try {
          const DAILY_QUOTA = 20;
          const now = new Date();
          const currentDay = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
          const quotaKey = `quota:${chatId}:${currentDay}`;

          const existingCountRaw = await env.BOT_KV.get(quotaKey);
          const parsedExistingCount = existingCountRaw ? parseInt(existingCountRaw, 10) : 0;
          const existingCount = Number.isNaN(parsedExistingCount) ? 0 : parsedExistingCount;


          const trimmedText = text.trim();

          const respondWithQuotaStatus = async () => {
            const remaining = Math.max(0, DAILY_QUOTA - existingCount);
            const messageLines = [
              `سهمیهٔ امروز شما: ${existingCount} از ${DAILY_QUOTA} پیام مصرف شده است.`,
              `پیام‌های باقی‌مانده برای امروز: ${remaining}.`,
              "سهمیهٔ روزانه در نیمه‌شب UTC (حدود ساعت ۳:۳۰ به وقت ایران) مجدداً شارژ می‌شود.",
            ];
            await sendTelegramText(chatId, messageLines.join("\n"));
          };

          if (trimmedText === "/quota" || trimmedText.startsWith("/quota ")) {
            await respondWithQuotaStatus();
            return new Response("quota status sent", { status: 200 });
          }


          if (existingCount >= DAILY_QUOTA) {
            console.log("Daily quota exceeded", { chatId, existingCount, DAILY_QUOTA });
            await sendTelegramText(
              chatId,
              `سقف استفادهٔ رایگان روزانه ${DAILY_QUOTA} پیام است و شما امروز ${existingCount} پیام مصرف کرده‌اید. لطفاً فردا دوباره تلاش کنید.`
            );
            return new Response("daily quota exceeded", { status: 200 });
          }

          const ttlSecondsUntilTomorrow = (() => {
            const tomorrowUtcMidnight = new Date(Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              now.getUTCDate() + 1,
              0,
              0,
              0,
              0
            ));
            const diffMs = tomorrowUtcMidnight.getTime() - now.getTime();
            return Math.max(1, Math.ceil(diffMs / 1000));
          })();

          await env.BOT_KV.put(quotaKey, (existingCount + 1).toString(), {
            expirationTtl: ttlSecondsUntilTomorrow,
          });

          // اگر کاربر /debug فرستاد، خروجی کامل JSON را برگردان (برای عیب‌یابی)
          const isDebug = trimmedText.startsWith("/debug");
          const prompt = isDebug ? trimmedText.replace("/debug", "").trim() || "سلام" : text;

          const openAiResult = await invokeOpenAI(prompt);

          if (isDebug) {
            const debugJson = JSON.stringify(openAiResult, null, 2);
            await sendTelegramText(chatId, debugJson);
          } else {
            // ✅ فقط پاسخ مدل را ارسال کن
            const disclosure = "🔈 این صدا توسط هوش مصنوعی تولید شده است.";
            await sendTelegramText(chatId, `${openAiResult.answer}\n\n${disclosure}`);
            try {
              const voiceBuffer = await synthesizeVoice(openAiResult.answer);
              await sendTelegramVoice(chatId, voiceBuffer, disclosure);
            } catch (voiceError) {
              console.error("Failed to synthesize or send voice", voiceError);
            }
          }

          console.log("Sent response to Telegram");
        } catch (error) {
          console.error("Failed to call OpenAI API", error);
          await sendTelegramText(chatId, "خطایی در برقراری ارتباط با سرویس هوش مصنوعی رخ داد.");
          return new Response("openai error", { status: 502 });
        }
      } else {
        console.log("No message to handle in update", update);
      }

      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },
};
