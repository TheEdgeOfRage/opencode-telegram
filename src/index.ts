import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { StringEnum, Type } from "@mariozechner/pi-ai";
import type { Bot, Context as GrammyContext } from "grammy";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as log from "./log.js";
import { createBot, BOT_COMMANDS } from "./telegram.js";
import {
  escapeMarkdownV2,
  escapeWithCodeBlocks,
  formatAsQuote,
  formatToolBlock,
  splitMessage,
} from "./format.js";

interface Config {
  token: string;
  allowedUsers: number[];
}

interface ToolExecution {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "running" | "completed" | "error";
  result?: string;
  error?: string;
}

interface PendingRequest {
  chatId: number;
  api: GrammyContext["api"];
  responseMsgId: number;
  lastEditTime: number;
  editTimer: ReturnType<typeof setTimeout> | null;
  typingInterval: ReturnType<typeof setInterval>;
  currentTurnText: string;
  previousTurnsText: string[];
  toolExecutions: ToolExecution[];
  isChannel: boolean;
}

function loadConfig(): Config {
  const configPath = join(homedir(), ".config", "pi", "telegram.json");
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
    throw new Error(
      `"allowedUsers" must be a non-empty array in ${configPath}`,
    );
  }
  return { token, allowedUsers: users.map(Number) };
}

const THROTTLE_MS = 2000;

export default function (pi: ExtensionAPI) {
  let config: Config | null = null;
  let configError: string | null = null;
  try {
    config = loadConfig();
  } catch (err) {
    configError = String(err instanceof Error ? err.message : err);
    log.error("config load failed:", configError);
  }

  let bot: Bot | null = null;
  let pending: PendingRequest | null = null;
  let agentBusy = false;
  let currentCtx: ExtensionContext | undefined;

  const autoConnect = process.env.TELEGRAM_AUTOCONNECT === "1";

  // --- Helpers ---

  function getToolResultText(result: unknown): string {
    if (!result || typeof result !== "object") return "";
    const r = result as { content?: Array<{ type: string; text?: string }> };
    if (!Array.isArray(r.content)) return "";
    return r.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
  }

  function formatPreview(p: PendingRequest): string {
    const parts: string[] = [];

    // Tool executions
    for (const tool of p.toolExecutions) {
      parts.push(
        formatToolBlock(
          tool.toolName,
          tool.args,
          tool.status,
          tool.result,
          tool.error,
        ),
      );
    }

    // Current turn text
    if (p.currentTurnText) {
      parts.push(escapeWithCodeBlocks(p.currentTurnText));
    }

    const text = parts.join("\n") || escapeMarkdownV2("thinking...");
    if (text.length > 4000)
      return text.slice(0, 4000) + escapeMarkdownV2("...");
    return text;
  }

  function formatFinalContent(p: PendingRequest): string {
    const parts: string[] = [];

    for (const tool of p.toolExecutions) {
      parts.push(
        formatToolBlock(
          tool.toolName,
          tool.args,
          tool.status,
          tool.result,
          tool.error,
        ),
      );
    }

    if (p.currentTurnText) {
      parts.push(escapeWithCodeBlocks(p.currentTurnText));
    }

    return parts.join("\n");
  }

  function formatFinalTextOnly(p: PendingRequest): string {
    const allText = [...p.previousTurnsText, p.currentTurnText]
      .filter(Boolean)
      .join("\n\n");
    if (!allText) return "";
    return escapeWithCodeBlocks(allText);
  }

  async function editMessage(
    chatId: number,
    messageId: number,
    text: string,
    api: GrammyContext["api"],
  ): Promise<void> {
    try {
      await api.editMessageText(chatId, messageId, text, {
        parse_mode: "MarkdownV2",
      });
    } catch {
      // Edit may fail if text unchanged or message deleted — ignore
    }
  }

  function flushEdit(): void {
    if (!pending) return;
    const preview = formatPreview(pending);
    const text = pending.isChannel ? formatAsQuote(preview) : preview;
    void editMessage(pending.chatId, pending.responseMsgId, text, pending.api);
    pending.lastEditTime = Date.now();
  }

  function scheduleEdit(): void {
    if (!pending) return;
    const elapsed = Date.now() - pending.lastEditTime;
    if (elapsed >= THROTTLE_MS) {
      if (pending.editTimer) clearTimeout(pending.editTimer);
      pending.editTimer = null;
      flushEdit();
    } else if (!pending.editTimer) {
      pending.editTimer = setTimeout(flushEdit, THROTTLE_MS - elapsed);
    }
  }

  function cleanupPending(p: PendingRequest): void {
    if (p.editTimer) {
      clearTimeout(p.editTimer);
      p.editTimer = null;
    }
    clearInterval(p.typingInterval);
  }

  // --- Bot lifecycle ---

  async function connect(): Promise<string> {
    if (!config) return `error: ${configError}`;
    if (bot) return "already connected";
    bot = createBot(
      config.token,
      config.allowedUsers,
      onTelegramMessage,
      onTelegramAbort,
    );
    await bot.api.setMyCommands(BOT_COMMANDS);
    log.info("telegram bot starting long-polling...");
    bot.start();
    return "connected";
  }

  async function disconnect(): Promise<string> {
    if (!bot) return "not connected";
    await bot.stop();
    bot = null;
    if (pending) {
      cleanupPending(pending);
      pending = null;
    }
    log.info("telegram bot stopped");
    return "disconnected";
  }

  // --- Telegram handlers ---

  async function onTelegramMessage(
    chatId: number,
    text: string,
    grammyCtx: GrammyContext,
    isChannel: boolean,
  ): Promise<void> {
    if (agentBusy || pending) {
      await grammyCtx.reply("Agent is currently busy\\. Please wait\\.", {
        parse_mode: "MarkdownV2",
      });
      return;
    }

    log.info(`[prompt] sending to pi chat=${chatId}`);

    // Typing indicator, refreshed every 4s
    void grammyCtx.api.sendChatAction(chatId, "typing");
    const typingInterval = setInterval(() => {
      void grammyCtx.api.sendChatAction(chatId, "typing");
    }, 4000);

    // Send "thinking..." placeholder
    const thinkingMsg = await grammyCtx.api.sendMessage(
      chatId,
      escapeMarkdownV2("thinking..."),
      { parse_mode: "MarkdownV2" },
    );

    pending = {
      chatId,
      api: grammyCtx.api,
      responseMsgId: thinkingMsg.message_id,
      lastEditTime: 0,
      editTimer: null,
      typingInterval,
      currentTurnText: "",
      previousTurnsText: [],
      toolExecutions: [],
      isChannel,
    };

    try {
      pi.sendUserMessage(text);
    } catch (err) {
      cleanupPending(pending);
      log.error(`[prompt] error sending message:`, err);
      const errText = escapeMarkdownV2(`Error: ${String(err)}`);
      await editMessage(chatId, thinkingMsg.message_id, errText, grammyCtx.api);
      pending = null;
    }
  }

  async function onTelegramAbort(): Promise<void> {
    if (currentCtx && agentBusy) {
      await currentCtx.abort();
      log.info("[abort] aborted from Telegram");
    }
  }

  // --- pi event handlers ---

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
  });

  pi.on("agent_start", async (_event, ctx) => {
    currentCtx = ctx;
    agentBusy = true;
  });

  // Streaming text from assistant
  pi.on("message_update", async (event) => {
    if (!pending) return;
    const evt = event.assistantMessageEvent;
    if (evt.type === "text_delta") {
      pending.currentTurnText += evt.delta;
      scheduleEdit();
    }
  });

  // Track tool executions
  pi.on("tool_execution_start", async (event) => {
    if (!pending) return;
    pending.toolExecutions.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args as Record<string, unknown>,
      status: "running",
    });
    scheduleEdit();
  });

  pi.on("tool_execution_end", async (event) => {
    if (!pending) return;
    const tool = pending.toolExecutions.find(
      (t) => t.toolCallId === event.toolCallId,
    );
    if (tool) {
      tool.status = event.isError ? "error" : "completed";
      const text = getToolResultText(event.result);
      if (event.isError) {
        tool.error = text || "unknown error";
      } else {
        tool.result = text;
      }
    }
    scheduleEdit();
  });

  // New turn — save previous turn text and reset
  pi.on("turn_start", async () => {
    if (!pending) return;
    if (pending.currentTurnText) {
      pending.previousTurnsText.push(pending.currentTurnText);
    }
    pending.currentTurnText = "";
  });

  // Agent finished — send final response to Telegram
  pi.on("agent_end", async () => {
    agentBusy = false;
    if (!pending) return;

    const p = pending;
    pending = null;
    cleanupPending(p);

    // Final edit of the "thinking..." message with full content (tools + text)
    const fullContent = formatFinalContent(p);
    if (fullContent) {
      const editText =
        fullContent.length > 4000
          ? fullContent.slice(0, 4000) + escapeMarkdownV2("...")
          : fullContent;
      const textToSend = p.isChannel ? formatAsQuote(editText) : editText;
      await editMessage(p.chatId, p.responseMsgId, textToSend, p.api);
    }

    // Send final text-only summary as a new message if it differs from the edit
    const textContent = formatFinalTextOnly(p);
    if (textContent && textContent !== fullContent) {
      const chunks = splitMessage(textContent);
      log.info(`[prompt] done chat=${p.chatId} chunks=${chunks.length}`);
      for (const chunk of chunks) {
        const textToSend = p.isChannel ? formatAsQuote(chunk) : chunk;
        await p.api.sendMessage(p.chatId, textToSend, {
          parse_mode: "MarkdownV2",
        });
      }
    }
  });

  // --- Register tool (callable by the LLM) ---

  pi.registerTool({
    name: "telegram",
    label: "Telegram",
    description:
      "Connect or disconnect the Telegram bot. Actions: connect, disconnect, status.",
    parameters: Type.Object({
      action: StringEnum(["connect", "disconnect", "status"] as const),
    }),
    async execute(_toolCallId, params) {
      let result: string;
      if (params.action === "connect") {
        result = await connect();
      } else if (params.action === "disconnect") {
        result = await disconnect();
      } else {
        result = bot ? "connected" : "disconnected";
      }
      return {
        content: [{ type: "text" as const, text: result }],
        details: {},
      };
    },
  });

  // --- Register command (usable from pi TUI) ---

  pi.registerCommand("telegram", {
    description:
      "Control the Telegram bot. Usage: /telegram [connect|disconnect|status]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "connect") {
        const result = await connect();
        ctx.ui.notify(
          `Telegram: ${result}`,
          result.startsWith("error") ? "error" : "info",
        );
      } else if (action === "disconnect") {
        const result = await disconnect();
        ctx.ui.notify(`Telegram: ${result}`, "info");
      } else {
        ctx.ui.notify(
          bot ? "Telegram bot: connected" : "Telegram bot: disconnected",
          "info",
        );
      }
    },
  });

  // --- Autoconnect ---

  if (autoConnect) {
    connect().catch((err) => log.error("autoconnect failed:", err));
  }

  // --- Cleanup on shutdown ---

  pi.on("session_shutdown", async () => {
    await disconnect();
  });
}
