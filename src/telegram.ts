import { Bot, type Context } from "grammy";
import type { Chat } from "grammy/types";
import * as log from "./log.js";

export const BOT_COMMANDS = [
  { command: "abort", description: "Abort current operation" },
];

function isChannel(chat: Chat): boolean {
  return chat.type === "channel" || chat.type === "supergroup";
}

export type MessageHandler = (
  chatId: number,
  text: string,
  ctx: Context,
  isChannel: boolean,
) => Promise<void>;

export type AbortHandler = () => Promise<void>;

export function createBot(
  token: string,
  allowedUsers: number[],
  onMessage: MessageHandler,
  onAbort: AbortHandler,
): Bot {
  const bot = new Bot(token);
  const allowed = new Set(allowedUsers);

  // Auth middleware — reject users not in allowlist
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !allowed.has(userId)) {
      await ctx.reply("Not authorized.");
      return;
    }
    await next();
  });

  bot.command("abort", async (ctx) => {
    const chatId = ctx.chat.id;
    log.info(`[cmd] /abort chat=${chatId}`);
    try {
      await onAbort();
      log.info(`[cmd] /abort success chat=${chatId}`);
      await ctx.reply("Aborted\\.", { parse_mode: "MarkdownV2" });
    } catch (err) {
      log.error(`[cmd] /abort error:`, err);
      await ctx.reply(`Failed to abort: ${String(err)}`);
    }
  });

  // Text message handler — forward to pi
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    const channel = isChannel(ctx.chat);
    log.info(`[prompt] message received chat=${chatId}`);
    await onMessage(chatId, text, ctx, channel);
  });

  return bot;
}
