import { randomBytes } from "node:crypto";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { ssrfPolicyFromPrivateNetworkOptIn } from "openclaw/plugin-sdk/ssrf-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { fetchWithSsrFGuard } from "../runtime-api.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import {
  readNextcloudTalkErrorBody,
  releaseNextcloudTalkGuardedResponse,
} from "./guarded-response.js";
import { parseNextcloudTalkTarget, stripNextcloudTalkTargetPrefix } from "./normalize.js";
import { resolveNextcloudTalkAllowlistMatch } from "./policy.js";
import { getOptionalNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkSendResult } from "./types.js";

const NEXTCLOUD_TALK_ERROR_SNIPPET_MAX_CHARS = 200;
const NEXTCLOUD_TALK_SEND_TIMEOUT_MS = 30_000;

/** Collapses and caps an already-redacted error body for display. */
function collapseErrorSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length > NEXTCLOUD_TALK_ERROR_SNIPPET_MAX_CHARS) {
    return `${truncateUtf16Safe(collapsed, NEXTCLOUD_TALK_ERROR_SNIPPET_MAX_CHARS)}…`;
  }
  return collapsed;
}

/** Random referenceId (sha256 length) so the plugin can recognize its own messages. */
export function createNextcloudTalkReferenceId(): string {
  return randomBytes(32).toString("hex");
}

type NextcloudTalkSendOpts = {
  cfg: CoreConfig;
  accountId?: string;
  replyTo?: string;
};

/** Delay before the referenceId check after an unclear send result. */
const NEXTCLOUD_TALK_RECONCILE_DELAY_MS = 1_000;
/** Number of latest messages searched for the own referenceId. */
const NEXTCLOUD_TALK_RECONCILE_LOOKBACK = 50;

/**
 * OpenClaw passes the resolved runtime config with every send call (ctx.cfg). Replaces
 * requireRuntimeConfig from openclaw/plugin-sdk/plugin-config-runtime, which OpenClaw
 * removes after 2026-12-01; same check and error message.
 */
export function requireNextcloudTalkRuntimeConfig(cfg: CoreConfig | undefined, context: string): CoreConfig {
  if (cfg) {
    return cfg;
  }
  throw new Error(
    `${context} requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.`,
  );
}

function resolveNextcloudTalkSendContext(opts: NextcloudTalkSendOpts) {
  const cfg = requireNextcloudTalkRuntimeConfig(opts.cfg, "Nextcloud Talk send");
  const account = resolveNextcloudTalkAccount({ cfg, accountId: opts.accountId });
  const { baseUrl, apiUser, apiPassword } = account;

  if (!baseUrl) {
    throw new Error(
      `Nextcloud Talk baseUrl missing for account "${account.accountId}" (set channels.nextcloud-talk-user.baseUrl).`,
    );
  }
  if (!apiUser || !apiPassword) {
    throw new Error(
      account.credentialStatus === "configured_unavailable"
        ? `Nextcloud Talk app password is configured but unavailable for account "${account.accountId}" (check channels.nextcloud-talk-user.apiPassword/apiPasswordFile).`
        : `Nextcloud Talk user credentials missing for account "${account.accountId}" (set channels.nextcloud-talk-user.apiUser and apiPassword).`,
    );
  }

  return { cfg, account, baseUrl, apiUser, apiPassword };
}

function normalizeRoomToken(to: string): string {
  const normalized = stripNextcloudTalkTargetPrefix(to);
  if (!normalized) {
    throw new Error("Room token is required for Nextcloud Talk sends");
  }
  return normalized;
}

/** OCS request as the configured user (Basic auth with the app password). */
async function requestNextcloudTalkAsUser(params: {
  context: ReturnType<typeof resolveNextcloudTalkSendContext>;
  method: "GET" | "POST" | "DELETE";
  path: string;
  form?: Record<string, string>;
  auditContext: string;
  beforeRequest?: () => void;
}) {
  const { account, baseUrl, apiUser, apiPassword } = params.context;
  const body = params.form ? new URLSearchParams(params.form).toString() : undefined;
  const guarded = await fetchWithSsrFGuard({
    url: `${baseUrl}/ocs/v2.php/apps/spreed/api/${params.path}`,
    beforeRequest: params.beforeRequest,
    init: {
      method: params.method,
      headers: {
        Accept: "application/json",
        "OCS-APIRequest": "true",
        Authorization: `Basic ${Buffer.from(`${apiUser}:${apiPassword}`).toString("base64")}`,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(body ? { body } : {}),
    },
    auditContext: params.auditContext,
    policy: ssrfPolicyFromPrivateNetworkOptIn(
      account.config.network?.dangerouslyAllowPrivateNetwork,
    ),
    timeoutMs: NEXTCLOUD_TALK_SEND_TIMEOUT_MS,
  });
  return guarded;
}

function describeSendFailure(status: number, roomToken: string, errorBody: string): string {
  switch (status) {
    case 400:
      return `Nextcloud Talk: bad request - ${errorBody || "invalid message format"}`;
    case 401:
      // Never retry automatically: Nextcloud counts failed sign-ins (brute-force protection).
      return "Nextcloud Talk: sign-in as the configured user was rejected - the app password may be revoked; run the device sign-in again";
    case 403:
      return "Nextcloud Talk: forbidden - the conversation is read-only or the user lacks permission";
    case 404:
      return `Nextcloud Talk: conversation not found for the user (token=${roomToken})`;
    case 412:
      return "Nextcloud Talk: the conversation lobby is active";
    case 413:
      return "Nextcloud Talk: message too long";
    case 429:
      return "Nextcloud Talk: too many requests or the client IP is throttled by brute-force protection";
    default:
      return errorBody
        ? `Nextcloud Talk send failed: ${errorBody}`
        : `Nextcloud Talk send failed (${status})`;
  }
}

type SendAttempt =
  | { kind: "response"; response: Response; release: () => Promise<void> }
  | { kind: "reconciled"; messageId: string; timestamp?: number };

/** Unclear result: timeout, network error or 5xx (the message may have arrived anyway). */
function isUncertainStatus(status: number): boolean {
  return status >= 500;
}

/** Looks up the own message by referenceId in the chat (read-only, no read marker). */
async function findSentMessageByReferenceId(params: {
  context: ReturnType<typeof resolveNextcloudTalkSendContext>;
  roomToken: string;
  referenceId: string;
}): Promise<{ messageId: string; timestamp?: number } | undefined> {
  const query = new URLSearchParams({
    lookIntoFuture: "0",
    limit: String(NEXTCLOUD_TALK_RECONCILE_LOOKBACK),
    setReadMarker: "0",
    markNotificationsAsRead: "0",
    noStatusUpdate: "1",
  });
  const { response, release } = await requestNextcloudTalkAsUser({
    context: params.context,
    method: "GET",
    path: `v1/chat/${encodeURIComponent(params.roomToken)}?${query}`,
    auditContext: "nextcloud-talk-user-send-reconcile",
  });
  try {
    if (response.status === 304) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`reference lookup failed (${response.status})`);
    }
    const data = await readProviderJsonResponse<{
      ocs?: { data?: { id?: number; referenceId?: string; actorType?: string; actorId?: string; timestamp?: number }[] };
    }>(response, "Nextcloud Talk send reconcile");
    const user = params.context.apiUser.toLowerCase();
    const match = (data.ocs?.data ?? []).find(
      (entry) =>
        entry.referenceId === params.referenceId &&
        entry.actorType === "users" &&
        entry.actorId?.toLowerCase() === user,
    );
    return match?.id != null
      ? { messageId: String(match.id), ...(match.timestamp ? { timestamp: match.timestamp } : {}) }
      : undefined;
  } finally {
    await release();
  }
}

/**
 * Sends with exactly one retry after an unclear result (timeout, network error, 5xx).
 * Before retrying, the referenceId check makes sure the message did not arrive already,
 * so nothing is sent twice. 4xx (including 401/429) is never retried (brute-force
 * protection). If the check itself fails, the original error is reported without a retry.
 */
async function postWithReconcile(params: {
  context: ReturnType<typeof resolveNextcloudTalkSendContext>;
  roomToken: string;
  path: string;
  form: Record<string, string>;
  referenceId: string;
  beforeRequest?: () => void;
  auditContext: string;
}): Promise<SendAttempt> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let dispatched = false;
    let handoffRejected = false;
    try {
      const guarded = await requestNextcloudTalkAsUser({
        context: params.context,
        method: "POST",
        path: params.path,
        form: params.form,
        beforeRequest: () => {
          try {
            params.beforeRequest?.();
          } catch (error) {
            // Handoff cancelled (before a request or a redirect hop):
            // send nothing more and do not look the message up either.
            handoffRejected = true;
            throw error;
          }
          dispatched = true;
        },
        auditContext: params.auditContext,
      });
      if (!isUncertainStatus(guarded.response.status)) {
        return { kind: "response", ...guarded };
      }
      lastError = new Error(describeSendFailure(guarded.response.status, params.roomToken, ""));
      await releaseNextcloudTalkGuardedResponse(guarded);
    } catch (error) {
      if (!dispatched || handoffRejected) {
        // Handoff not released, cancelled or request never started: no lookup.
        throw error;
      }
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, NEXTCLOUD_TALK_RECONCILE_DELAY_MS));
    let found: Awaited<ReturnType<typeof findSentMessageByReferenceId>>;
    try {
      found = await findSentMessageByReferenceId({
        context: params.context,
        roomToken: params.roomToken,
        referenceId: params.referenceId,
      });
    } catch {
      throw lastError;
    }
    if (found) {
      return { kind: "reconciled", ...found };
    }
  }
  throw lastError;
}

/** Cache: 1:1 room per account and person. */
const directRoomCache = new Map<string, string>();

export function clearNextcloudTalkDirectRoomCache(): void {
  directRoomCache.clear();
}

/**
 * Resolves a send target to a room token. For a person (user:<uid>, users/<uid>) the 1:1
 * room is fetched or created, unless proactiveDm is "off" or the person does not match
 * allowFrom. Talk also creates the room with people who have no Talk access, so "sent"
 * does not mean "delivered".
 */
async function resolveSendRoomToken(
  context: ReturnType<typeof resolveNextcloudTalkSendContext>,
  to: string,
): Promise<string> {
  const target = parseNextcloudTalkTarget(to);
  if (!target) {
    throw new Error("Room token or user:<uid> is required for Nextcloud Talk sends");
  }
  if (target.kind === "room") {
    return target.token;
  }
  const { account, apiUser } = context;
  const userId = target.userId;
  if (userId.toLowerCase() === apiUser.toLowerCase()) {
    throw new Error("Nextcloud Talk: cannot start a direct conversation with the plugin's own user");
  }
  if ((account.config.proactiveDm ?? "allowFrom") === "off") {
    throw new Error(
      "Nextcloud Talk: starting direct conversations is disabled (channels.nextcloud-talk-user.proactiveDm: off)",
    );
  }
  const allowed = resolveNextcloudTalkAllowlistMatch({
    allowFrom: account.config.allowFrom,
    senderId: `users/${userId}`,
  }).allowed;
  if (!allowed) {
    throw new Error(
      `Nextcloud Talk: direct conversation with "${userId}" not allowed (not in channels.nextcloud-talk-user.allowFrom)`,
    );
  }
  const cacheKey = `${account.accountId}:${userId}`;
  const cached = directRoomCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const { response, release } = await requestNextcloudTalkAsUser({
    context,
    method: "POST",
    path: "v4/room",
    form: { roomType: "1", invite: userId },
    auditContext: "nextcloud-talk-user-direct-room",
  });
  try {
    if (response.status !== 200 && response.status !== 201) {
      const errorBody = collapseErrorSnippet(
        await readNextcloudTalkErrorBody(response, context.apiPassword),
      );
      throw new Error(
        response.status === 404
          ? `Nextcloud Talk: user "${userId}" not found`
          : response.status === 403
            ? `Nextcloud Talk: the plugin's user may not start conversations with "${userId}"`
            : `Nextcloud Talk: direct conversation with "${userId}" failed (${response.status}) ${errorBody}`.trim(),
      );
    }
    const data = await readProviderJsonResponse<{ ocs?: { data?: { token?: string } } }>(
      response,
      "Nextcloud Talk direct room",
    );
    const token = data.ocs?.data?.token;
    if (!token) {
      throw new Error(`Nextcloud Talk: direct conversation with "${userId}" returned no token`);
    }
    directRoomCache.set(cacheKey, token);
    return token;
  } finally {
    await releaseNextcloudTalkGuardedResponse({ response, release });
  }
}

/** For files (outbound-media): resolve the target like for text messages. */
export async function resolveNextcloudTalkSendRoomToken(opts: {
  cfg: CoreConfig;
  accountId?: string;
  to: string;
}): Promise<string> {
  return await resolveSendRoomToken(resolveNextcloudTalkSendContext(opts), opts.to);
}

export async function sendMessageNextcloudTalk(
  to: string,
  text: string,
  opts: NextcloudTalkSendOpts & {
    silent?: boolean;
    /** Talk thread (threadId); with replyTo Talk stays in the thread anyway. */
    threadId?: string;
    referenceId?: string;
    onPlatformSendDispatch?: () => Promise<void>;
    assertDirectAdapterHandoff?: () => void;
  },
): Promise<NextcloudTalkSendResult> {
  const context = resolveNextcloudTalkSendContext(opts);
  const { cfg, account } = context;

  if (!text?.trim()) {
    throw new Error("Message must be non-empty for Nextcloud Talk sends");
  }

  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "nextcloud-talk-user",
    accountId: account.accountId,
  });
  const message = convertMarkdownTables(text.trim(), tableMode);
  const referenceId = opts.referenceId ?? createNextcloudTalkReferenceId();
  const roomToken = await resolveSendRoomToken(context, to);

  await opts.onPlatformSendDispatch?.();
  const attempt = await postWithReconcile({
    context,
    roomToken,
    path: `v1/chat/${encodeURIComponent(roomToken)}`,
    form: {
      message,
      referenceId,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.threadId && /^[1-9]\d*$/u.test(opts.threadId) ? { threadId: opts.threadId } : {}),
      ...(opts.silent ? { silent: "true" } : {}),
    },
    referenceId,
    beforeRequest: opts.assertDirectAdapterHandoff,
    auditContext: "nextcloud-talk-user-send",
  });
  if (attempt.kind === "reconciled") {
    return buildSendResult({
      account,
      roomToken,
      referenceId,
      replyTo: opts.replyTo,
      messageId: attempt.messageId,
      timestamp: attempt.timestamp,
    });
  }
  const { response, release } = attempt;

  try {
    if (!response.ok) {
      const errorBody = collapseErrorSnippet(
        await readNextcloudTalkErrorBody(response, context.apiPassword),
      );
      throw new Error(describeSendFailure(response.status, roomToken, errorBody));
    }

    let messageId = "unknown";
    let timestamp: number | undefined;
    try {
      const data = await readProviderJsonResponse<{
        ocs?: {
          data?: {
            id?: number | string;
            timestamp?: number;
          };
        };
      }>(response, "Nextcloud Talk send");
      if (data.ocs?.data?.id != null) {
        messageId = String(data.ocs.data.id);
      }
      if (typeof data.ocs?.data?.timestamp === "number") {
        timestamp = data.ocs.data.timestamp;
      }
    } catch {
      // Response parsing failed (including an over-limit body), but the message
      // was already accepted by the server, so keep the "unknown" receipt.
    }

    return buildSendResult({
      account,
      roomToken,
      referenceId,
      replyTo: opts.replyTo,
      messageId,
      timestamp,
    });
  } finally {
    await release();
  }
}

function buildSendResult(params: {
  account: ReturnType<typeof resolveNextcloudTalkAccount>;
  roomToken: string;
  referenceId: string;
  replyTo?: string;
  messageId: string;
  timestamp?: number;
}): NextcloudTalkSendResult {
  const { account, roomToken, referenceId, replyTo, messageId, timestamp } = params;
  getOptionalNextcloudTalkRuntime()?.channel.activity.record({
    channel: "nextcloud-talk-user",
    accountId: account.accountId,
    direction: "outbound",
  });
  const receiptMessageId = messageId.trim();
  return {
    messageId,
    roomToken,
    referenceId,
    receipt: createMessageReceiptFromOutboundResults({
      results:
        receiptMessageId && receiptMessageId !== "unknown"
          ? [{ channel: "nextcloud-talk-user", messageId: receiptMessageId, conversationId: roomToken }]
          : [],
      kind: "text",
      ...(replyTo ? { replyToId: replyTo } : {}),
    }),
    timestamp,
  };
}

export async function sendReactionNextcloudTalk(
  roomToken: string,
  messageId: string,
  reaction: string,
  opts: Omit<NextcloudTalkSendOpts, "replyTo">,
): Promise<void> {
  const context = resolveNextcloudTalkSendContext(opts);
  const normalizedToken = normalizeRoomToken(roomToken);

  const { response, release } = await requestNextcloudTalkAsUser({
    context,
    method: "POST",
    path: `v1/reaction/${encodeURIComponent(normalizedToken)}/${encodeURIComponent(messageId)}`,
    form: { reaction },
    auditContext: "nextcloud-talk-user-reaction",
  });

  try {
    if (!response.ok) {
      const errorBody = collapseErrorSnippet(
        await readNextcloudTalkErrorBody(response, context.apiPassword),
      );
      throw new Error(`Nextcloud Talk reaction failed: ${response.status} ${errorBody}`.trim());
    }
  } finally {
    await release();
  }
}
