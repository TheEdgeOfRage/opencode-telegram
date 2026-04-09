import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { Bot } from "grammy";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as log from "./log.js";
import { init, setAttachedSession, clearAttachedSession } from "./opencode.js";
import { handleEvent } from "./events.js";
import { BOT_COMMANDS, createBot } from "./telegram.js";

interface Config {
  token: string;
  allowedUsers: number[];
}

function loadConfig(): Config {
  const configPath = join(homedir(), ".config", "opencode", "telegram.json");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`cannot read config: ${configPath}`);
  }
  const json = JSON.parse(raw) as Record<string, unknown>;
  const token = json.token;
  if (typeof token !== "string" || !token) {
    throw new Error(`"token" missing in ${configPath}`);
  }
  const users = json.allowedUsers;
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error(`"allowedUsers" must be a non-empty array in ${configPath}`);
  }
  return { token, allowedUsers: users.map(Number) };
}

export const OpenCodeTelegram: Plugin = async ({ client, directory }) => {
  init(client, directory);

  let config: Config | null = null;
  let configError: string | null = null;
  try {
    config = loadConfig();
  } catch (err) {
    configError = String(err instanceof Error ? err.message : err);
    log.error("config load failed:", configError);
  }

  let bot: Bot | null = null;
  const autoConnect = process.env.TELEGRAM_AUTOCONNECT === "1";

  async function connect(): Promise<string> {
    if (!config) return `error: ${configError}`;
    if (bot) return "already connected";
    bot = createBot(config.token, config.allowedUsers);
    await bot.api.setMyCommands(BOT_COMMANDS);
    log.info("telegram bot starting long-polling...");
    bot.start();
    return "connected";
  }

  async function disconnect(): Promise<string> {
    if (!bot) return "not connected";
    await bot.stop();
    bot = null;
    clearAttachedSession();
    log.info("telegram bot stopped");
    return "disconnected";
  }

  if (autoConnect) {
    connect().catch((err) => log.error("autoconnect failed:", err));
  }

  return {
    event: async ({ event }) => {
      try {
        handleEvent(event);
      } catch (err) {
        log.error("event handler error:", err);
      }
    },
    tool: {
      telegram: tool({
        description:
          "Connect or disconnect the Telegram bot. Actions: connect, disconnect, status.",
        args: {
          action: tool.schema.enum(["connect", "disconnect", "status"]),
        },
        async execute(args, context) {
          if (args.action === "connect") {
            setAttachedSession(context.sessionID);
            return connect();
          }
          if (args.action === "disconnect") return disconnect();
          return bot ? "connected" : "disconnected";
        },
      }),
    },
  };
};
