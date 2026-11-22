import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { renderNextcloudTalkMessageText, type NextcloudTalkChatMessage } from "./receive/normalize-message.js";
import { parseNextcloudTalkGeoLocation } from "./receive/rich-object.js";
import {
  createNextcloudTalkGuardedRawHttp,
  createNextcloudTalkClient,
  NextcloudTalkAuthStoppedError,
  readNextcloudTalkOcsData,
  type NextcloudTalkRawHttp,
} from "./receive/talk-client.js";
import { NEXTCLOUD_TALK_CHANNEL_ID } from "./channel-id.js";
import { assertNextcloudTalkRoomAccess } from "./room-access.js";
import type { CoreConfig } from "./types.js";

/**
 * History tool (message action "read").
 *
 * Reads a room's history as the configured user via the Talk chat API, without side
 * effects: no read marker, no clearing of notifications, no online status. Only what the
 * user may see in the room is visible.
 */

export const DEFAULT_NEXTCLOUD_TALK_HISTORY_LIMIT = 30;
export const NEXTCLOUD_TALK_HISTORY_MAX_LIMIT = 100;

export type NextcloudTalkHistoryQuery = {
  roomToken: string;
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
  messageId?: string;
  threadId?: string;
  includeSystem?: boolean;
};

export type NextcloudTalkHistoryMessage = {
  id: string;
  timestampMs: number;
  timestampUtc: string;
  sender: { id: string; name: string };
  isOwn: boolean;
  messageType: string;
  text: string;
  deleted?: true;
  systemMessage?: string;
  silent?: true;
  edited?: { timestampUtc: string; by?: string };
  threadId?: string;
  threadTitle?: string;
  replyTo?: { id: string; deleted?: true; sender?: { id: string; name: string }; text?: string };
  attachment?: { fileId?: string; name: string; mimeType: string; sizeBytes?: number; path?: string };
  object?: { type: string; id?: string; name?: string; latitude?: number; longitude?: number };
  reactions?: Record<string, number>;
};

export type NextcloudTalkHistoryResult = {
  channel: typeof NEXTCLOUD_TALK_CHANNEL_ID;
  roomToken: string;
  mode: "latest" | "before" | "after" | "around" | "message";
  messages: NextcloudTalkHistoryMessage[];
  /** Use as `before` for the next older page. */
  nextBefore?: string;
  /** Use as `after` for the next newer page. */
  nextAfter?: string;
  skippedSystemMessages?: number;
  /** Notes, e.g. when a threadId was ignored. */
  notes?: string[];
};

const ROOM_TOKEN_PATTERN = /^[a-z0-9]{4,30}$/u;
const ID_PATTERN = /^\d{1,19}$/u;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_NEXTCLOUD_TALK_HISTORY_LIMIT;
  }
  return Math.max(1, Math.min(NEXTCLOUD_TALK_HISTORY_MAX_LIMIT, Math.trunc(limit)));
}

function requireId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!ID_PATTERN.test(trimmed)) {
    throw new Error(`${label} must be a numeric Nextcloud Talk message id.`);
  }
  return trimmed;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

type RawMessage = NextcloudTalkChatMessage & {
  lastEditTimestamp?: number;
  lastEditActorId?: string;
  threadTitle?: string;
  reactions?: Record<string, number> | unknown[];
};

export function toNextcloudTalkHistoryMessage(raw: RawMessage, selfUser: string): NextcloudTalkHistoryMessage {
  const parameters =
    raw.messageParameters && !Array.isArray(raw.messageParameters) ? raw.messageParameters : {};
  const file = parameters.file;
  const object = parameters.object;
  const parent = raw.parent;
  const own = raw.actorType === "users" && raw.actorId.toLowerCase() === selfUser.toLowerCase();
  const message: NextcloudTalkHistoryMessage = {
    id: String(raw.id),
    timestampMs: raw.timestamp * 1000,
    timestampUtc: iso(raw.timestamp),
    sender: { id: `${raw.actorType}/${raw.actorId}`, name: raw.actorDisplayName ?? "" },
    isOwn: own,
    messageType: raw.messageType,
    text: raw.messageType === "comment_deleted" ? "" : renderNextcloudTalkMessageText(raw),
  };
  if (raw.messageType === "comment_deleted") {
    message.deleted = true;
  }
  if (raw.systemMessage) {
    message.systemMessage = raw.systemMessage;
  }
  if (raw.silent) {
    message.silent = true;
  }
  if (raw.lastEditTimestamp) {
    message.edited = {
      timestampUtc: iso(raw.lastEditTimestamp),
      ...(raw.lastEditActorId ? { by: raw.lastEditActorId } : {}),
    };
  }
  // threadId is set on every message; only report real threads.
  if (raw.threadTitle && raw.threadId) {
    message.threadId = String(raw.threadId);
    message.threadTitle = raw.threadTitle;
  }
  if (parent) {
    message.replyTo =
      "deleted" in parent
        ? { id: String(parent.id), deleted: true }
        : {
            id: String(parent.id),
            sender: { id: `${parent.actorType}/${parent.actorId}`, name: parent.actorDisplayName ?? "" },
            text: renderNextcloudTalkMessageText(parent).slice(0, 500),
          };
  }
  if (file) {
    const size = Number(str(file.size));
    message.attachment = {
      ...(str(file.id) ? { fileId: str(file.id) } : {}),
      name: str(file.name),
      mimeType: str(file.mimetype),
      ...(Number.isSafeInteger(size) ? { sizeBytes: size } : {}),
      ...(str(file.path) ? { path: str(file.path) } : {}),
    };
  }
  if (object) {
    message.object = {
      type: str(object.type),
      ...(str(object.id) ? { id: str(object.id) } : {}),
      ...(str(object.name) ? { name: str(object.name) } : {}),
    };
    const location = parseNextcloudTalkGeoLocation(object);
    if (location) {
      message.object.latitude = Number(location.latitude);
      message.object.longitude = Number(location.longitude);
    }
  }
  if (raw.reactions && !Array.isArray(raw.reactions) && Object.keys(raw.reactions).length > 0) {
    message.reactions = raw.reactions as Record<string, number>;
  }
  return message;
}

export async function readNextcloudTalkHistory(params: {
  cfg: CoreConfig;
  account: ResolvedNextcloudTalkAccount;
  query: NextcloudTalkHistoryQuery;
  http?: NextcloudTalkRawHttp;
  signal?: AbortSignal;
}): Promise<NextcloudTalkHistoryResult> {
  const { account, query } = params;
  if (!account.baseUrl || !account.apiUser || !account.apiPassword) {
    throw new Error(`Nextcloud Talk account "${account.accountId}" is not configured.`);
  }
  const roomToken = query.roomToken.trim();
  if (!ROOM_TOKEN_PATTERN.test(roomToken)) {
    throw new Error("A Nextcloud Talk room token is required (letters and digits).");
  }
  const cursors = [query.before, query.after, query.around, query.messageId].filter(
    (value) => value !== undefined && value !== "",
  );
  if (cursors.length > 1) {
    throw new Error("Use only one of before, after, around or messageId.");
  }
  const limit = clampLimit(query.limit);
  // Membership alone does not release a room: the config decides (see room-access.ts).
  await assertNextcloudTalkRoomAccess({ cfg: params.cfg, account, roomToken });
  const client = createNextcloudTalkClient({
    baseUrl: account.baseUrl,
    user: account.apiUser,
    appPassword: account.apiPassword,
    http:
      params.http ?? createNextcloudTalkGuardedRawHttp(account.config.network?.dangerouslyAllowPrivateNetwork),
  });
  const chatPath = `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(roomToken)}`;
  const quiet = { setReadMarker: 0, markNotificationsAsRead: 0, noStatusUpdate: 1 };
  const notes: string[] = [];
  // Agents often fill threadId generically (like for Slack). Talk only knows real threads
  // with a numeric id; anything else is ignored instead of rejected.
  const requestedThread = query.threadId?.trim();
  let thread: { threadId?: string } = {};
  if (requestedThread) {
    if (ID_PATTERN.test(requestedThread)) {
      thread = { threadId: requestedThread };
    } else {
      notes.push(`threadId "${requestedThread}" is not a Nextcloud Talk thread id and was ignored.`);
    }
  }

  let mode = "latest" as NextcloudTalkHistoryResult["mode"];
  const buildRequest = (threadFilter: { threadId?: string }): Parameters<typeof client.request>[0] => {
  let request: Parameters<typeof client.request>[0];
  if (query.around || query.messageId) {
    const id = requireId((query.around ?? query.messageId) as string, query.around ? "around" : "messageId");
    mode = query.around ? "around" : "message";
    request = {
      method: "GET",
      path: `${chatPath}/${id}/context`,
      query: { limit: query.around ? Math.ceil(limit / 2) : 1, ...threadFilter },
    };
  } else if (query.after) {
    mode = "after";
    request = {
      method: "GET",
      path: chatPath,
      query: {
        lookIntoFuture: 1,
        timeout: 0,
        limit,
        lastKnownMessageId: requireId(query.after, "after"),
        ...quiet,
        ...threadFilter,
      },
    };
  } else {
    mode = query.before ? "before" : "latest";
    request = {
      method: "GET",
      path: chatPath,
      query: {
        lookIntoFuture: 0,
        limit,
        ...(query.before ? { lastKnownMessageId: requireId(query.before, "before") } : {}),
        ...quiet,
        ...threadFilter,
      },
    };
  }
  return request;
  };

  const send = async (request: Parameters<typeof client.request>[0]) => {
    try {
      return await client.request({ ...request, signal: params.signal });
    } catch (error) {
      if (error instanceof NextcloudTalkAuthStoppedError) {
        throw new Error(error.message);
      }
      throw error;
    }
  };
  let response = await send(buildRequest(thread));
  // 404 {"error":"thread"}: not a real Talk thread id (not a room 404, does not count for
  // brute-force protection). Read once without the thread filter.
  const errorCode = (response.json as { ocs?: { data?: { error?: unknown } } } | undefined)?.ocs?.data
    ?.error;
  if (response.status === 404 && thread.threadId && errorCode === "thread") {
    notes.push(
      `threadId ${thread.threadId} is not a Nextcloud Talk thread; read the whole room instead.`,
    );
    response = await send(buildRequest({}));
  }
  if (response.status === 404) {
    throw new Error(`Nextcloud Talk: room ${roomToken} or message not found for the configured user.`);
  }
  if (response.status === 412) {
    throw new Error(`Nextcloud Talk: room ${roomToken} has an active lobby.`);
  }
  let raw: RawMessage[] = [];
  if (response.status === 200) {
    const data = readNextcloudTalkOcsData(response);
    raw = Array.isArray(data) ? (data as RawMessage[]) : [];
  } else if (response.status !== 304) {
    throw new Error(`Nextcloud Talk history read failed (HTTP ${response.status}).`);
  }

  if (mode === "message") {
    raw = raw.filter((entry) => String(entry.id) === query.messageId?.trim());
  }
  const sorted = [...raw].sort((a, b) => a.id - b.id);
  const visible = query.includeSystem
    ? sorted
    : sorted.filter((entry) => entry.messageType !== "system" && !entry.systemMessage);
  const messages = visible.map((entry) => toNextcloudTalkHistoryMessage(entry, account.apiUser));
  const oldest = sorted[0]?.id;
  const newest = sorted.at(-1)?.id;
  return {
    channel: NEXTCLOUD_TALK_CHANNEL_ID,
    roomToken,
    mode,
    messages,
    ...(oldest !== undefined && mode !== "message" ? { nextBefore: String(oldest) } : {}),
    ...(newest !== undefined && mode !== "message" ? { nextAfter: String(newest) } : {}),
    ...(sorted.length !== visible.length ? { skippedSystemMessages: sorted.length - visible.length } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}
