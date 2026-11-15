import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverTelegramChats, getTelegramMe, sendTelegramVideo, TelegramApiError } from "../src/telegram";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function mockServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void,
): Promise<string> {
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    handler(request, response, Buffer.concat(chunks).toString("utf8"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function tempClip(): { directory: string; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clippi-telegram-"));
  const file = path.join(directory, "clip.mp4");
  fs.writeFileSync(file, "fake-video-bytes");
  return { directory, file };
}

describe("sendTelegramVideo", () => {
  it("uploads multipart form data to the sendVideo endpoint", async () => {
    const { directory, file } = tempClip();
    let captured: { url?: string; method?: string; contentType?: string; body?: string } = {};
    const apiBase = await mockServer((request, response, body) => {
      captured = {
        url: request.url,
        method: request.method,
        contentType: request.headers["content-type"],
        body,
      };
      json(response, 200, { ok: true, result: { message_id: 7 } });
    });

    try {
      await sendTelegramVideo({ token: "TEST_TOKEN", chatId: "12345", apiBase }, file, "Got hit — 42% taken");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }

    expect(captured.url).toBe("/botTEST_TOKEN/sendVideo");
    expect(captured.method).toBe("POST");
    expect(captured.contentType).toContain("multipart/form-data");
    expect(captured.body).toContain('name="chat_id"');
    expect(captured.body).toContain("12345");
    expect(captured.body).toContain('name="caption"');
    expect(captured.body).toContain("Got hit — 42% taken");
    expect(captured.body).toContain('filename="clip.mp4"');
  });

  it("surfaces Telegram API errors", async () => {
    const { directory, file } = tempClip();
    const apiBase = await mockServer((_request, response) => {
      json(response, 400, { ok: false, description: "Bad Request: chat not found" });
    });

    try {
      const error = await sendTelegramVideo({ token: "TEST_TOKEN", chatId: "missing", apiBase }, file, "caption").catch(
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(TelegramApiError);
      expect((error as Error).message).toMatch(/chat not found/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries once after a 429", async () => {
    const { directory, file } = tempClip();
    let calls = 0;
    const apiBase = await mockServer((_request, response) => {
      calls++;
      if (calls === 1) {
        json(response, 429, {
          ok: false,
          description: "Too Many Requests: retry later",
          parameters: { retry_after: 0 },
        });
      } else {
        json(response, 200, { ok: true, result: { message_id: 8 } });
      }
    });

    try {
      await sendTelegramVideo({ token: "TEST_TOKEN", chatId: "12345", apiBase }, file, "caption");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }

    expect(calls).toBe(2);
  });
});

describe("Telegram discovery", () => {
  it("returns the bot identity", async () => {
    const apiBase = await mockServer((_request, response) => {
      json(response, 200, { ok: true, result: { id: 42, username: "pook_clips_bot" } });
    });

    await expect(getTelegramMe("TEST_TOKEN", apiBase)).resolves.toEqual({
      id: 42,
      username: "pook_clips_bot",
    });
  });

  it("deduplicates chats from message and channel_post updates", async () => {
    const apiBase = await mockServer((_request, response) => {
      json(response, 200, {
        ok: true,
        result: [
          { message: { chat: { id: 1, type: "private", username: "pook" } } },
          { message: { chat: { id: 1, type: "private", username: "pook" } } },
          { channel_post: { chat: { id: -100, type: "channel", title: "Clip channel" } } },
        ],
      });
    });

    const chats = await discoverTelegramChats("TEST_TOKEN", apiBase);

    expect(chats).toHaveLength(2);
    expect(chats.map((chat) => chat.id)).toEqual([1, -100]);
    expect(chats[0]!.title).toBe("pook");
    expect(chats[1]!.title).toBe("Clip channel");
  });
});
