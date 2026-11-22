import type { NextcloudTalkInboundMessage, NextcloudTalkInboundQuote } from "../types.js";
import { renderNextcloudTalkRichObject } from "./rich-object.js";

/**
 * Turns a message from the Talk chat API (Talk 25) into the message object that
 * inbound.ts processes.
 */

export type NextcloudTalkChatMessage = {
  id: number;
  token: string;
  actorType: string;
  actorId: string;
  actorDisplayName?: string;
  timestamp: number;
  message: string;
  messageParameters?: Record<string, Record<string, unknown>> | unknown[];
  systemMessage?: string;
  messageType: string;
  referenceId?: string;
  silent?: boolean;
  threadId?: number;
  isThread?: boolean;
  threadTitle?: string;
  parent?: NextcloudTalkChatMessage | { id: number; deleted: true };
};

export type NextcloudTalkRoomSummary = {
  token: string;
  type: number;
  displayName?: string;
  name?: string;
};

export type NextcloudTalkNormalizeOutcome =
  | { kind: "deliver"; message: NextcloudTalkInboundMessage }
  | { kind: "skip"; reason: NextcloudTalkSkipReason };

export type NextcloudTalkSkipReason =
  | "own_message"
  | "bot_message"
  | "system_message"
  | "deleted_message"
  | "unsupported_type";

/** Talk room type 1 = 1:1, 5 = former 1:1, 6 = note to self; anything else is a group. */
export function isNextcloudTalkDirectRoom(type: number): boolean {
  return type === 1 || type === 5 || type === 6;
}

function params(message: Pick<NextcloudTalkChatMessage, "messageParameters">): Record<string, Record<string, unknown>> {
  const value = message.messageParameters;
  return value && !Array.isArray(value) && typeof value === "object" ? value : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/**
 * Replaces {placeholders} with readable text; mentions become @Name, files are dropped,
 * rich objects (locations, polls, …) become a labelled summary.
 */
export function renderNextcloudTalkMessageText(message: Pick<NextcloudTalkChatMessage, "message" | "messageParameters">): string {
  const parameters = params(message);
  return message.message
    .replace(/\{([a-z0-9_-]+)\}/giu, (whole, key: string) => {
      const parameter = parameters[key];
      if (!parameter) {
        return whole;
      }
      if (key === "file") {
        return "";
      }
      if (key === "object" || str(parameter.type) === "geo-location") {
        return renderNextcloudTalkRichObject(parameter);
      }
      const name = str(parameter.name) || str(parameter.id);
      if (key.startsWith("mention-")) {
        return `@${name}`;
      }
      return name;
    })
    .trim();
}

function isSelfMention(message: NextcloudTalkChatMessage, selfUser: string, mentionAll: boolean): boolean {
  const self = selfUser.toLowerCase();
  return Object.entries(params(message)).some(
    ([key, parameter]) =>
      key.startsWith("mention-") &&
      // Only parameters whose placeholder actually appears in the text.
      message.message.includes(`{${key}}`) &&
      ((str(parameter.type) === "user" && str(parameter.id).toLowerCase() === self) ||
        // @all appears as type "call" (mention-call1).
        (mentionAll && str(parameter.type) === "call")),
  );
}

function senderIdOf(message: Pick<NextcloudTalkChatMessage, "actorType" | "actorId">): string {
  return `${message.actorType}/${message.actorId}`;
}

function quoteOf(parent: NextcloudTalkChatMessage["parent"]): NextcloudTalkInboundQuote | undefined {
  if (!parent || "deleted" in parent) {
    return undefined;
  }
  return {
    id: String(parent.id),
    senderId: senderIdOf(parent),
    senderName: parent.actorDisplayName ?? "",
    body: renderNextcloudTalkMessageText(parent),
  };
}

export function normalizeNextcloudTalkChatMessage(params_: {
  message: NextcloudTalkChatMessage;
  room: NextcloudTalkRoomSummary;
  selfUser: string;
  ignoreBots: boolean;
  /** Treat @all as a mention of the account (default: no). */
  mentionAll?: boolean;
}): NextcloudTalkNormalizeOutcome {
  const { message, room, selfUser, ignoreBots, mentionAll = false } = params_;
  if (message.actorType === "users" && message.actorId.toLowerCase() === selfUser.toLowerCase()) {
    return { kind: "skip", reason: "own_message" };
  }
  if (ignoreBots && message.actorType === "bots") {
    return { kind: "skip", reason: "bot_message" };
  }
  if (message.messageType === "system" || message.systemMessage) {
    return { kind: "skip", reason: "system_message" };
  }
  if (message.messageType === "comment_deleted") {
    return { kind: "skip", reason: "deleted_message" };
  }
  if (message.messageType !== "comment" && message.messageType !== "voice-message") {
    return { kind: "skip", reason: "unsupported_type" };
  }

  const file = params(message).file;
  const text = renderNextcloudTalkMessageText(message);
  const parent = message.parent && !("deleted" in message.parent) ? message.parent : undefined;
  const repliesToSelf =
    parent?.actorType === "users" && parent.actorId.toLowerCase() === selfUser.toLowerCase();

  let attachment: NextcloudTalkInboundMessage["attachment"];
  let attachmentIssue: NextcloudTalkInboundMessage["attachmentIssue"];
  if (file) {
    const size = Number(str(file.size));
    const link = str(file.link);
    const name = str(file.name);
    const mimeType = str(file.mimetype);
    if (link && name && mimeType && Number.isSafeInteger(size) && size >= 0) {
      attachment = {
        fileId: str(file.id) || undefined,
        name,
        mimeType,
        declaredSizeBytes: size,
        shareUrl: link,
        hideDownload: str(file["hide-download"]) === "yes",
      };
    } else {
      attachmentIssue = "media_missing_metadata";
    }
  }

  const roomName = room.displayName || room.name || room.token;
  return {
    kind: "deliver",
    message: {
      messageId: String(message.id),
      roomToken: message.token || room.token,
      roomName,
      senderId: senderIdOf(message),
      senderName: message.actorDisplayName ?? "",
      text,
      mentionText: text,
      mediaType: message.messageType === "voice-message" ? "voice-message" : file ? "file" : "text",
      timestamp: message.timestamp * 1000,
      isGroupChat: !isNextcloudTalkDirectRoom(room.type),
      ...(attachment ? { attachment } : {}),
      ...(attachmentIssue ? { attachmentIssue } : {}),
      ...(quoteOf(message.parent) ? { quote: quoteOf(message.parent) } : {}),
      mentionsSelf: isSelfMention(message, selfUser, mentionAll) || repliesToSelf,
      ...(message.silent ? { silent: true } : {}),
      ...(message.isThread && message.threadId
        ? {
            thread: {
              id: String(message.threadId),
              ...(message.threadTitle ? { title: message.threadTitle } : {}),
            },
          }
        : {}),
    },
  };
}
