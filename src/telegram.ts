import fs from "node:fs/promises";
import path from "node:path";

/**
 * Minimal Telegram Bot API client for sending rendered clips.
 *
 * Credentials come from the environment, never argv:
 *   TELEGRAM_BOT_TOKEN  token from @BotFather
 *   TELEGRAM_CHAT_ID    numeric chat id or @channelusername
 *   TELEGRAM_API_BASE   optional override (tests / local Bot API server)
 */

const DEFAULT_API_BASE = "https://api.telegram.org";
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // Bot API upload limit

export interface TelegramConfig {
  token: string;
  chatId: string;
  apiBase?: string;
}

export interface TelegramChat {
  id: number | string;
  type: string;
  title: string;
  username: string | null;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

interface TelegramUpdate {
  message?: { chat?: { id: number | string; type?: string; title?: string; username?: string } };
  channel_post?: { chat?: { id: number | string; type?: string; title?: string; username?: string } };
}

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export class TelegramApiError extends Error {
  readonly status: number;
  readonly retryAfter: number | null;

  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message);
    this.name = "TelegramApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Read credentials from the environment. Throws a message the user can act on. */
export function telegramConfigFromEnv(overrides: { chatId?: string | null } = {}): TelegramConfig {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather, then export " +
        "TELEGRAM_BOT_TOKEN=... in the environment that runs the cron job.",
    );
  }
  const chatId = overrides.chatId?.trim() || process.env.TELEGRAM_CHAT_ID?.trim();
  if (!chatId) {
    throw new Error(
      "TELEGRAM_CHAT_ID is not set. Send /start to your bot, run " +
        "`npx tsx src/hit-review-cli.ts --telegram-check` to discover the chat id, " +
        "then export TELEGRAM_CHAT_ID=...",
    );
  }
  const apiBase = process.env.TELEGRAM_API_BASE?.trim() || DEFAULT_API_BASE;
  return { token, chatId, apiBase };
}

/** Verify the token and return the bot account. */
export async function getTelegramMe(token: string, apiBase = DEFAULT_API_BASE): Promise<TelegramUser> {
  return apiCall<TelegramUser>(token, "getMe", undefined, apiBase);
}

/**
 * Read recent updates and return unique chats. Telegram only retains updates
 * for ~24h and returns nothing until someone messages the bot, so a chat id
 * may still need to be copied from the bot's update or another tool.
 */
export async function discoverTelegramChats(token: string, apiBase = DEFAULT_API_BASE): Promise<TelegramChat[]> {
  const updates = await apiCall<TelegramUpdate[]>(
    token,
    "getUpdates",
    { limit: 100, allowed_updates: ["message", "channel_post"] },
    apiBase,
  );
  const chats = new Map<string, TelegramChat>();
  for (const update of updates) {
    const chat = update.message?.chat ?? update.channel_post?.chat;
    if (!chat) continue;
    const key = String(chat.id);
    if (chats.has(key)) continue;
    chats.set(key, {
      id: chat.id,
      type: chat.type ?? "unknown",
      title: chat.title ?? chat.username ?? key,
      username: chat.username ?? null,
    });
  }
  return [...chats.values()];
}

/** Send a rendered MP4 with a plain-text caption. */
export async function sendTelegramVideo(config: TelegramConfig, filePath: string, caption: string): Promise<void> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_VIDEO_BYTES) {
    throw new Error(
      `Video is ${(stat.size / 1024 / 1024).toFixed(1)} MB; Telegram's Bot API limit is 50 MB. ` +
        "Render at a lower resolution or bitrate.",
    );
  }
  const bytes = new Uint8Array(await fs.readFile(filePath));
  const form = new FormData();
  form.append("chat_id", config.chatId);
  form.append("caption", caption.slice(0, 1024));
  form.append("supports_streaming", "true");
  form.append("video", new Blob([bytes], { type: "video/mp4" }), path.basename(filePath));

  await apiCall(config.token, "sendVideo", form, config.apiBase ?? DEFAULT_API_BASE, 120_000);
}

/** Send a plain-text message (used for pipeline summaries/tests). */
export async function sendTelegramMessage(config: TelegramConfig, text: string): Promise<void> {
  await apiCall(
    config.token,
    "sendMessage",
    { chat_id: config.chatId, text: text.slice(0, 4096), disable_web_page_preview: true },
    config.apiBase ?? DEFAULT_API_BASE,
  );
}

async function apiCall<T>(
  token: string,
  method: string,
  body: FormData | Record<string, unknown> | undefined,
  apiBase: string,
  timeoutMs = 30_000,
): Promise<T> {
  const url = `${apiBase.replace(/\/+$/, "")}/bot${token}/${method}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const init: RequestInit & { signal: AbortSignal } = {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Telegram ${method} request failed: ${reason}`);
    }

    const raw = await response.text();
    let parsed: TelegramApiResponse<T>;
    try {
      parsed = JSON.parse(raw) as TelegramApiResponse<T>;
    } catch {
      throw new TelegramApiError(
        `Telegram ${method} returned HTTP ${response.status} with a non-JSON body`,
        response.status,
      );
    }

    if (parsed.ok) {
      if (parsed.result === undefined) throw new Error(`Telegram ${method} returned no result`);
      return parsed.result;
    }

    const retryAfter = parsed.parameters?.retry_after ?? null;
    if (response.status === 429 && retryAfter !== null && attempt === 0) {
      await sleep((retryAfter + 1) * 1000);
      continue;
    }
    throw new TelegramApiError(
      parsed.description ?? `Telegram ${method} failed with HTTP ${response.status}`,
      response.status,
      retryAfter,
    );
  }

  throw new Error(`Telegram ${method} failed after retrying`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
