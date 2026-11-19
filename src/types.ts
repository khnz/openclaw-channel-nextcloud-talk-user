import type { MessageReceipt } from "openclaw/plugin-sdk/channel-outbound";
import type { z } from "zod";
import type { OpenClawConfig } from "../runtime-api.js";
import type {
  NextcloudTalkAccountSchemaBase,
  NextcloudTalkConfigSchema,
  NextcloudTalkRoomSchema,
} from "./config-schema.js";

export type NextcloudTalkRoomConfig = NonNullable<z.input<typeof NextcloudTalkRoomSchema>>;
type NextcloudTalkAccountSchemaInput = z.input<typeof NextcloudTalkAccountSchemaBase>;
export type NextcloudTalkAccountConfig = Omit<NextcloudTalkAccountSchemaInput, "rooms"> & {
    rooms?: Record<string, NextcloudTalkRoomConfig>;
  };
type NextcloudTalkConfig = Omit<z.input<typeof NextcloudTalkConfigSchema>, "accounts" | "rooms"> & {
    accounts?: Record<string, NextcloudTalkAccountConfig>;
    rooms?: Record<string, NextcloudTalkRoomConfig>;
  };

export type CoreConfig = {
  channels?: NonNullable<OpenClawConfig["channels"]> & {
    "nextcloud-talk-user"?: NextcloudTalkConfig;
  };
  gateway?: OpenClawConfig["gateway"];
  [key: string]: unknown;
};

export type NextcloudTalkSendResult = {
  messageId: string;
  roomToken: string;
  /** referenceId of the sent message, to recognize it as our own when receiving. */
  referenceId?: string;
  receipt: MessageReceipt;
  timestamp?: number;
};

/** Untrusted file metadata from a Talk chat message (`messageParameters.file`). */
export type NextcloudTalkInboundAttachment = {
  fileId?: string;
  name: string;
  mimeType: string;
  declaredSizeBytes: number;
  shareUrl: string;
  hideDownload: boolean;
};

export type NextcloudTalkInboundQuote = {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
};

export type NextcloudTalkInboundMessage = {
  messageId: string;
  roomToken: string;
  roomName: string;
  senderId: string;
  senderName: string;
  text: string;
  /** Caption text with referenced user mentions resolved, excluding file metadata. */
  mentionText?: string;
  mediaType: string;
  timestamp: number;
  isGroupChat: boolean;
  attachment?: NextcloudTalkInboundAttachment;
  attachmentIssue?: "media_missing_metadata";
  quote?: NextcloudTalkInboundQuote;
  /**
   * The account was mentioned as structured data (messageParameters mention-user = account)
   * or the message replies to a message of the account. Complements the pattern matching.
   */
  mentionsSelf?: boolean;
  /** Silent message (sent without notification). */
  silent?: boolean;
  /** Real Talk thread (isThread) the message belongs to. */
  thread?: { id: string; title?: string };
};
