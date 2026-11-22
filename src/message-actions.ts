import {
  jsonResult,
  readNumberParam,
  readStringOrNumberParam,
  readStringParam,
  resolveReactionMessageId,
} from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import {
  isNextcloudTalkAccountConfigured,
  listNextcloudTalkAccountIds,
  resolveNextcloudTalkAccount,
  type ResolvedNextcloudTalkAccount,
} from "./accounts.js";
import { readNextcloudTalkHistory } from "./history.js";
import { readNextcloudTalkPoll, voteNextcloudTalkPoll } from "./poll.js";
import { stripNextcloudTalkTargetPrefix } from "./normalize.js";
import { sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";
import { NEXTCLOUD_TALK_CHANNEL_ID } from "./channel-id.js";

const providerId = NEXTCLOUD_TALK_CHANNEL_ID;

function isAccountConfigured(account: ResolvedNextcloudTalkAccount): boolean {
  return Boolean(
    account.enabled && account.apiPassword && isNextcloudTalkAccountConfigured(account),
  );
}

/** Reading history is allowed unless actions.messages is explicitly false. */
function isHistoryReadEnabled(account: ResolvedNextcloudTalkAccount): boolean {
  return account.config.actions?.messages !== false;
}

/** Reading and voting on polls is allowed unless actions.polls is explicitly false. */
function isPollsEnabled(account: ResolvedNextcloudTalkAccount): boolean {
  return account.config.actions?.polls !== false;
}

function requireConfiguredAccount(cfg: CoreConfig, accountId: string | null | undefined) {
  const account = resolveNextcloudTalkAccount({ cfg, accountId });
  if (!isAccountConfigured(account)) {
    throw new Error(`Nextcloud Talk account "${account.accountId}" is disabled or not configured.`);
  }
  return account;
}

function requireRoomToken(params: Record<string, unknown>): string {
  const target = readStringParam(params, "to", { required: true, label: "to (room token)" });
  const roomToken = stripNextcloudTalkTargetPrefix(target);
  if (!roomToken) {
    throw new Error("to (room token) is required");
  }
  return roomToken;
}

function readPollId(params: Record<string, unknown>): string | undefined {
  const value = readStringOrNumberParam(params, "pollId");
  return value === undefined || value === null || value === "" ? undefined : String(value).trim();
}

function toIntegers(value: unknown, label: string): number[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
  return list.map((entry) => {
    const number = typeof entry === "number" ? entry : typeof entry === "string" && /^\d+$/u.test(entry.trim()) ? Number(entry) : NaN;
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(`${label} must contain whole numbers.`);
    }
    return number;
  });
}

/** Talk option ids (0-based) from pollOptionId(s) or the 1-based pollOptionIndex(es). */
function readPollOptionIds(params: Record<string, unknown>): number[] {
  const ids = [
    ...toIntegers(params.pollOptionId, "pollOptionId"),
    ...toIntegers(params.pollOptionIds, "pollOptionIds"),
  ];
  const indexes = [
    ...toIntegers(params.pollOptionIndex, "pollOptionIndex"),
    ...toIntegers(params.pollOptionIndexes, "pollOptionIndexes"),
  ];
  if (indexes.some((index) => index < 1)) {
    throw new Error("pollOptionIndex is 1-based.");
  }
  if (ids.length > 0 && indexes.length > 0) {
    throw new Error("Use either pollOptionId(s) or pollOptionIndex(es), not both.");
  }
  return ids.length > 0 ? ids : indexes.map((index) => index - 1);
}

function hasConfiguredAccount(cfg: CoreConfig, accountId: string | null | undefined): boolean {
  if (accountId) {
    const account = resolveNextcloudTalkAccount({ cfg, accountId });
    return isAccountConfigured(account);
  }
  return listNextcloudTalkAccountIds(cfg)
    .map((id) => resolveNextcloudTalkAccount({ cfg, accountId: id }))
    .some(isAccountConfigured);
}

export const nextcloudTalkMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    if (!hasConfiguredAccount(cfg as CoreConfig, accountId)) {
      return null;
    }
    const actions: ChannelMessageActionName[] = ["send", "react"];
    const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
    if (isAccountConfigured(account) && (isHistoryReadEnabled(account) || isPollsEnabled(account))) {
      actions.push("read");
    }
    if (isAccountConfigured(account) && isPollsEnabled(account)) {
      actions.push("poll-vote");
    }
    return { actions };
  },

  supportsAction: ({ action }) => action === "react" || action === "read" || action === "poll-vote",

  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    if (action === "send") {
      throw new Error("Send should be handled by outbound, not actions handler.");
    }

    if (action === "react") {
      // describeMessageTool only offers `react` for enabled, configured accounts.
      // An explicit accountId can still target a disabled or uncredentialed
      // account, so enforce the same gate at dispatch before it reaches the
      // sender — otherwise a disabled account with leftover credentials still
      // emits reactions.
      const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
      if (!isAccountConfigured(account)) {
        throw new Error(
          `Nextcloud Talk account "${account.accountId}" is disabled or not configured.`,
        );
      }

      const target = readStringParam(params, "to", {
        required: true,
        label: "to (room token)",
      });

      const messageIdRaw = resolveReactionMessageId({ args: params, toolContext });
      if (messageIdRaw == null) {
        throw new Error("messageId required");
      }
      const messageId = String(messageIdRaw);

      const emoji = readStringParam(params, "emoji", { required: true });

      // Reaction removal is part of the shared `react` tool contract but is not
      // yet wired through to a Nextcloud Talk DELETE sender. Reject explicitly
      // so callers do not get the opposite of what they requested.
      if (params.remove === true) {
        throw new Error(
          "Nextcloud Talk reaction removal is not supported yet; only adding reactions is implemented.",
        );
      }

      await sendReactionNextcloudTalk(target, messageId, emoji, {
        accountId: accountId ?? undefined,
        cfg: cfg as CoreConfig,
      });
      return jsonResult({ ok: true, added: emoji });
    }

    if (action === "poll-vote") {
      const account = requireConfiguredAccount(cfg as CoreConfig, accountId);
      if (!isPollsEnabled(account)) {
        throw new Error(
          `Polls are disabled for Nextcloud Talk account "${account.accountId}" (actions.polls: false).`,
        );
      }
      const roomToken = requireRoomToken(params);
      const pollId = readPollId(params);
      if (!pollId) {
        throw new Error("pollId is required for poll-vote.");
      }
      const result = await voteNextcloudTalkPoll({
        cfg: cfg as CoreConfig,
        account,
        roomToken,
        pollId,
        optionIds: readPollOptionIds(params),
      });
      return jsonResult(result);
    }

    if (action === "read") {
      const account = requireConfiguredAccount(cfg as CoreConfig, accountId);
      const pollId = readPollId(params);
      if (pollId) {
        if (!isPollsEnabled(account)) {
          throw new Error(
            `Polls are disabled for Nextcloud Talk account "${account.accountId}" (actions.polls: false).`,
          );
        }
        const result = await readNextcloudTalkPoll({
          cfg: cfg as CoreConfig,
          account,
          roomToken: requireRoomToken(params),
          pollId,
        });
        return jsonResult(result);
      }
      if (!isHistoryReadEnabled(account)) {
        throw new Error(
          `Reading history is disabled for Nextcloud Talk account "${account.accountId}" (actions.messages: false).`,
        );
      }
      const target = readStringParam(params, "to", { required: true, label: "to (room token)" });
      const roomToken = stripNextcloudTalkTargetPrefix(target);
      if (!roomToken) {
        throw new Error("to (room token) is required");
      }
      const optionalId = (key: string) => {
        const value = readStringOrNumberParam(params, key);
        return value === undefined || value === null || value === "" ? undefined : String(value);
      };
      const result = await readNextcloudTalkHistory({
        cfg: cfg as CoreConfig,
        account,
        query: {
          roomToken,
          limit: readNumberParam(params, "limit", { integer: true }) ?? undefined,
          before: optionalId("before"),
          after: optionalId("after"),
          around: optionalId("around"),
          messageId: optionalId("messageId"),
          threadId: optionalId("threadId"),
          includeSystem: params.includeSystem === true,
        },
      });
      return jsonResult(result);
    }

    throw new Error(`Action ${action} not supported for ${providerId}.`);
  },
};
