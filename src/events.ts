import type {
  Event,
  EventMessageUpdated,
  EventMessagePartUpdated,
  Part,
} from "@opencode-ai/sdk";
import * as log from "./log.js";

// Server sends `permission.asked` with this shape, which diverges from the SDK's
// v1 Permission type. Keep a local interface until the SDK aligns.
export interface PermissionEvent {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always?: string[];
  tool?: { messageID: string; callID: string };
}

export type PartHandler = (parts: Part[]) => void;
export type PermissionHandler = (perm: PermissionEvent) => void;

interface SessionHandler {
  onPart: PartHandler;
  onPermission: PermissionHandler;
  parts: Map<string, Part>;
  assistantMessageIDs: Set<string>;
}

const handlers = new Map<string, SessionHandler>();

export function registerSession(
  sessionId: string,
  onPart: PartHandler,
  onPermission: PermissionHandler,
): void {
  handlers.set(sessionId, {
    onPart,
    onPermission,
    parts: new Map(),
    assistantMessageIDs: new Set(),
  });
}

export function unregisterSession(sessionId: string): void {
  handlers.delete(sessionId);
}

export function handleEvent(event: Event): void {
  const type = event.type as string;

  if (type === "message.updated") {
    const info = (event as EventMessageUpdated).properties.info;
    if (info.role !== "assistant") return;
    const handler = handlers.get(info.sessionID);
    if (!handler) return;
    handler.assistantMessageIDs.add(info.id);
    return;
  }

  if (type === "message.part.updated") {
    const part = (event as EventMessagePartUpdated).properties.part;
    const handler = handlers.get(part.sessionID);
    if (!handler) return;
    if (!handler.assistantMessageIDs.has(part.messageID)) return;
    handler.parts.set(part.id, part);
    handler.onPart(Array.from(handler.parts.values()));
    return;
  }

  if (type === "permission.asked" || type === "permission.updated") {
    const perm = event.properties as unknown as PermissionEvent;
    log.info(
      `[events] ${type} session=${perm.sessionID} perm=${perm.id} permission=${perm.permission}`,
    );
    const handler = handlers.get(perm.sessionID);
    if (!handler) return;
    handler.onPermission(perm);
    return;
  }
}
