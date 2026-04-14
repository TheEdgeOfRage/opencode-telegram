import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Chat } from "grammy/types";
import type { Part } from "@opencode-ai/sdk";
import * as log from "./log.js";
import type { PermissionEvent } from "./events.js";
import {
  escapeMarkdownV2,
  formatParts,
  formatTextParts,
  splitMessage,
} from "./format.js";
import {
  getOrCreateSession,
  createNewSession,
  listSessions,
  getSessionId,
  switchSession,
  abortSession,
  sendPrompt,
  replyPermission,
  listAgents,
  getAgent,
  setAgent,
} from "./opencode.js";
import { registerSession, unregisterSession } from "./events.js";

export const BOT_COMMANDS = [
  { command: "new", description: "New session" },
  { command: "sessions", description: "List and switch sessions" },
  { command: "abort", description: "Abort current session" },
  { command: "agent", description: "Switch agent (/agent <name>)" },
];

function isChannel(chat: Chat): boolean {
  return chat.type === "channel" || chat.type === "supergroup";
}

function formatAsQuote(text: string): string {
  const escaped = escapeMarkdownV2(text);
  const lines = escaped.split("\n");
  const quoted = lines.map((line) => `> ${line}`).join("\n");
  return quoted;
}

const THROTTLE_MS = 2000;

// Track channel membership for quoting
let channelChatId: number | null = null;

// Telegram callback data is limited to 64 bytes. Permission IDs are too long,
// so we store them in a map keyed by a short incrementing counter.
let permCounter = 0;
const pendingPerms = new Map<
  string,
  { sessionId: string; permissionId: string }
>();

function formatPartsPreview(parts: Part[]): string {
  const text = formatParts(parts);
  if (!text) return escapeMarkdownV2("thinking...");
  // Truncate to fit Telegram's 4096 limit for edits
  if (text.length > 4000) return text.slice(0, 4000) + escapeMarkdownV2("...");
  return text;
}

async function editMessage(
  ctx: Context,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await ctx.api.editMessageText(ctx.chat!.id, messageId, text, {
      parse_mode: "MarkdownV2",
    });
  } catch {
    // Edit may fail if text unchanged or message deleted — ignore
  }
}

function formatPermissionMessage(perm: PermissionEvent): string {
  const lines = [escapeMarkdownV2(`Permission: ${perm.permission}`)];
  if (perm.patterns.length > 0) {
    lines.push(escapeMarkdownV2(perm.patterns.join("\n")));
  }
  return lines.join("\n");
}

function trackChannel(ctx: Context): void {
  const chat = ctx.chat;
  if (!chat) return;
  if (isChannel(chat)) {
    channelChatId = chat.id;
  }
}

export function createBot(token: string, allowedUsers: number[]): Bot {
  const bot = new Bot(token);

  const allowed = new Set(allowedUsers);

  // Auth middleware — reject users not in allowlist
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !allowed.has(userId)) {
      await ctx.reply("Not authorized.");
      return;
    }
    trackChannel(ctx);
    await next();
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat.id;
    log.info(`[cmd] /new chat=${chatId}`);
    try {
      const sessionId = await createNewSession(chatId);
      log.info(`[session] created session=${sessionId} chat=${chatId}`);
      await ctx.reply(
        `New session created: \`${escapeMarkdownV2(sessionId)}\``,
        {
          parse_mode: "MarkdownV2",
        },
      );
    } catch (err) {
      log.error(`[cmd] /new error:`, err);
      await ctx.reply(`Failed to create session: ${String(err)}`);
    }
  });

  bot.command("sessions", async (ctx) => {
    log.info(`[cmd] /sessions chat=${ctx.chat.id}`);
    try {
      const sessions = await listSessions();
      if (sessions.length === 0) {
        await ctx.reply("No sessions found\\.", { parse_mode: "MarkdownV2" });
        return;
      }

      const currentId = getSessionId(ctx.chat.id);
      const lines = sessions.map((s) => {
        const marker = s.id === currentId ? " \\(active\\)" : "";
        const title = escapeMarkdownV2(s.title || "untitled");
        const id = escapeMarkdownV2(s.id.slice(0, 8));
        return `• \`${id}\` ${title}${marker}`;
      });

      const keyboard = new InlineKeyboard();
      for (const s of sessions) {
        if (s.id === currentId) continue;
        const label = (s.title || "untitled").slice(0, 30);
        keyboard.text(label, `switch:${s.id}`).row();
      }

      await ctx.reply(lines.join("\n"), {
        parse_mode: "MarkdownV2",
        reply_markup:
          keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
      });
    } catch (err) {
      log.error(`[cmd] /sessions error:`, err);
      await ctx.reply(`Failed to list sessions: ${String(err)}`);
    }
  });

  bot.command("abort", async (ctx) => {
    const sessionId = getSessionId(ctx.chat.id);
    log.info(`[cmd] /abort chat=${ctx.chat.id} session=${sessionId ?? "none"}`);
    if (!sessionId) {
      await ctx.reply("No active session to abort.");
      return;
    }
    try {
      await abortSession(sessionId);
      log.info(`[session] aborted session=${sessionId}`);
      await ctx.reply("Session aborted\\.", { parse_mode: "MarkdownV2" });
    } catch (err) {
      log.error(`[cmd] /abort error:`, err);
      await ctx.reply(`Failed to abort: ${String(err)}`);
    }
  });

  // Handle callback queries (session switch, permissions)
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Session switch: switch:<sessionId>
    if (data.startsWith("switch:")) {
      const sessionId = data.slice("switch:".length);
      const chatId = ctx.chat?.id;
      if (!chatId || !sessionId) {
        await ctx.answerCallbackQuery({ text: "Invalid switch data" });
        return;
      }
      switchSession(chatId, sessionId);
      log.info(`[session] switched to session=${sessionId} chat=${chatId}`);
      await ctx.answerCallbackQuery({ text: "Session switched" });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      return;
    }

    // Format: p:<allow|deny>:<key>
    if (!data.startsWith("p:")) {
      await ctx.answerCallbackQuery();
      return;
    }
    const [, action, key] = data.split(":");
    const perm = key ? pendingPerms.get(key) : undefined;
    if (!action || !perm) {
      await ctx.answerCallbackQuery({ text: "Permission expired" });
      return;
    }
    pendingPerms.delete(key!);
    const responseMap: Record<string, "once" | "always" | "reject"> = {
      a: "once",
      s: "always",
      d: "reject",
    };
    const permResponse = responseMap[action] ?? "reject";
    try {
      await replyPermission(perm.sessionId, perm.permissionId, permResponse);
      log.info(
        `[permission] ${permResponse} session=${perm.sessionId} perm=${perm.permissionId}`,
      );
      await ctx.answerCallbackQuery({ text: `Permission: ${permResponse}` });
      await ctx.deleteMessage();
    } catch (err) {
      log.error(`[permission] reply error:`, err);
      await ctx.answerCallbackQuery({ text: `Error: ${String(err)}` });
    }
  });

  bot.command("agent", async (ctx) => {
    const chatId = ctx.chat.id;
    const name = ctx.match?.trim().toLowerCase();
    log.info(`[cmd] /agent chat=${chatId} arg=${name ?? "(none)"}`);

    if (!name) {
      // Show current agent and list available
      try {
        const agents = await listAgents();
        const current = getAgent(chatId) ?? escapeMarkdownV2("(default)");
        const list = agents.map((a) => escapeMarkdownV2(a)).join(", ");
        await ctx.reply(
          `Current agent: \`${current}\`\nAvailable: ${list}\n\nUsage: /agent \\<name\\>`,
          { parse_mode: "MarkdownV2" },
        );
      } catch (err) {
        log.error(`[cmd] /agent list error:`, err);
        await ctx.reply(`Failed to list agents: ${String(err)}`);
      }
      return;
    }

    try {
      const agents = await listAgents();
      const match = agents.find((a) => a.toLowerCase() === name);
      if (!match) {
        const list = agents.map((a) => escapeMarkdownV2(a)).join(", ");
        await ctx.reply(
          `Unknown agent \`${escapeMarkdownV2(name)}\`\\. Available: ${list}`,
          { parse_mode: "MarkdownV2" },
        );
        return;
      }
      setAgent(chatId, match);
      log.info(`[agent] set agent=${match} chat=${chatId}`);
      await ctx.reply(`Agent set to \`${escapeMarkdownV2(match)}\`\\.`, {
        parse_mode: "MarkdownV2",
      });
    } catch (err) {
      log.error(`[cmd] /agent error:`, err);
      await ctx.reply(`Error: ${String(err)}`);
    }
  });

  // Text message handler — forward to OpenCode with streaming
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    log.info(`[prompt] message received chat=${chatId}`);
    try {
      const { sessionId, fallback } = await getOrCreateSession(chatId);
      if (fallback) {
        log.info(
          `[session] previous session gone, created new session=${sessionId} chat=${chatId}`,
        );
        await ctx.reply(
          escapeMarkdownV2(
            "Previous session no longer available. Started a new session.",
          ),
          { parse_mode: "MarkdownV2" },
        );
      }

      // Typing indicator, refreshed every 4s
      let typingInterval: ReturnType<typeof setInterval> | null = setInterval(
        () => {
          void ctx.api.sendChatAction(chatId, "typing");
        },
        4000,
      );
      void ctx.api.sendChatAction(chatId, "typing");

      // Send "thinking..." immediately, then edit-in-place as streaming arrives
      let lastEditTime = 0;
      let editTimer: ReturnType<typeof setTimeout> | null = null;
      let latestPreview = "";
      const thinkingMsg = await ctx.api.sendMessage(
        chatId,
        escapeMarkdownV2("thinking..."),
        { parse_mode: "MarkdownV2" },
      );
      const responseMsgId = thinkingMsg.message_id;

      const cleanup = () => {
        if (editTimer) {
          clearTimeout(editTimer);
          editTimer = null;
        }
        if (typingInterval) {
          clearInterval(typingInterval);
          typingInterval = null;
        }
        unregisterSession(sessionId);
      };

      const flushEdit = () => {
        if (latestPreview) {
          const textToSend =
            channelChatId !== null
              ? formatAsQuote(latestPreview)
              : latestPreview;
          void editMessage(ctx, responseMsgId, textToSend);
          lastEditTime = Date.now();
        }
      };

      // Register SSE handlers for streaming and permissions before firing prompt
      registerSession(
        sessionId,
        // onPart — send first message on first data, then throttled edits
        (parts: Part[]) => {
          latestPreview = formatPartsPreview(parts);
          const elapsed = Date.now() - lastEditTime;
          if (elapsed >= THROTTLE_MS) {
            if (editTimer) clearTimeout(editTimer);
            editTimer = null;
            flushEdit();
          } else if (!editTimer) {
            editTimer = setTimeout(flushEdit, THROTTLE_MS - elapsed);
          }
        },
        // onPermission
        async (perm: PermissionEvent) => {
          log.info(
            `[permission] request permission=${perm.permission} session=${perm.sessionID} perm=${perm.id}`,
          );
          const key = String(++permCounter);
          pendingPerms.set(key, {
            sessionId: perm.sessionID,
            permissionId: perm.id,
          });
          const keyboard = new InlineKeyboard()
            .text("Allow", `p:a:${key}`)
            .text("Session", `p:s:${key}`)
            .text("Deny", `p:d:${key}`);
          await ctx.api.sendMessage(chatId, formatPermissionMessage(perm), {
            parse_mode: "MarkdownV2",
            reply_markup: keyboard,
          });
        },
      );

      // Fire prompt without blocking grammY's update loop (permissions need callback handling)
      const userText = ctx.message.text;
      const activeAgent = getAgent(chatId);
      log.info(
        `[prompt] sending to session=${sessionId} agent=${activeAgent ?? "(default)"}`,
      );
      sendPrompt(sessionId, userText, activeAgent)
        .then(async (parts) => {
          cleanup();
          // Final edit of the thinking message with full content (tools + text)
          const fullContent = formatParts(parts);
          if (fullContent) {
            const editText =
              fullContent.length > 4000
                ? fullContent.slice(0, 4000) + escapeMarkdownV2("...")
                : fullContent;
            const editToSend =
              channelChatId !== null ? formatAsQuote(editText) : editText;
            await editMessage(ctx, responseMsgId, editToSend);
          }
          // Send final summary (text-only) as new message, but only if it
          // differs from what's already in the edited message
          const textContent = formatTextParts(parts);
          if (textContent && textContent !== fullContent) {
            const chunks = splitMessage(textContent);
            log.info(
              `[prompt] done session=${sessionId} chunks=${chunks.length}`,
            );
            for (const chunk of chunks) {
              const textToSend =
                channelChatId !== null ? formatAsQuote(chunk) : chunk;
              await ctx.api.sendMessage(chatId, textToSend, {
                parse_mode: "MarkdownV2",
              });
            }
          }
        })
        .catch(async (err) => {
          cleanup();
          log.error(`[prompt] error session=${sessionId}:`, err);
          const errText = escapeMarkdownV2(`Error: ${String(err)}`);
          const errTextToSend =
            channelChatId !== null ? formatAsQuote(errText) : errText;
          await editMessage(ctx, responseMsgId, errTextToSend);
        });
    } catch (err) {
      log.error(`[prompt] unhandled error chat=${chatId}:`, err);
      await ctx.reply(`Error: ${String(err)}`);
    }
  });

  return bot;
}
