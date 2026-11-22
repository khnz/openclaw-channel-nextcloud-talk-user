import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { resolveNextcloudTalkAccount, type ResolvedNextcloudTalkAccount } from "../accounts.js";
import { handleNextcloudTalkInbound } from "../inbound.js";
import { getNextcloudTalkRuntime } from "../runtime.js";
import type { CoreConfig } from "../types.js";
import { createNextcloudTalkReceiveMonitor, type NextcloudTalkWebSocketLike } from "./monitor.js";
import { resolveNextcloudTalkAutoJoinPolicy } from "./auto-join.js";
import { resolveNextcloudTalkNotificationLevel } from "./notification-level.js";
import { createNextcloudTalkFileReceiveStateStore, resolveNextcloudTalkReceiveStatePath } from "./state.js";
import { createNextcloudTalkGuardedRawHttp, createNextcloudTalkClient } from "./talk-client.js";
import { NEXTCLOUD_TALK_CHANNEL_ID } from "../channel-id.js";

/** Starts receiving for an account as its configured user and runs until the stop signal. */
export async function startNextcloudTalkAccount(
  ctx: ChannelGatewayContext<ResolvedNextcloudTalkAccount>,
): Promise<void> {
  const account = ctx.account;
  if (!account.baseUrl || !account.apiUser || !account.apiPassword) {
    throw new Error(
      `Nextcloud Talk not configured for account "${account.accountId}" (missing baseUrl, apiUser or app password)`,
    );
  }
  const prefix = `[nextcloud-talk-user:${account.accountId}]`;
  const statusSink = createAccountStatusSink(ctx);

  await runPassiveAccountLifecycle({
    abortSignal: ctx.abortSignal,
    start: async () => {
      const core = getNextcloudTalkRuntime();
      const cfg = ctx.cfg as CoreConfig;
      const current = resolveNextcloudTalkAccount({ cfg, accountId: account.accountId });
      const runtime = resolveLoggerBackedRuntime(ctx.runtime, core.logging.getChildLogger());
      const logger = core.logging.getChildLogger({
        channel: NEXTCLOUD_TALK_CHANNEL_ID,
        accountId: current.accountId,
      });
      const stop = new AbortController();
      const onAbort = () => stop.abort();
      ctx.abortSignal.addEventListener("abort", onAbort, { once: true });

      const client = createNextcloudTalkClient({
        baseUrl: current.baseUrl,
        user: current.apiUser,
        appPassword: current.apiPassword,
        http: createNextcloudTalkGuardedRawHttp(current.config.network?.dangerouslyAllowPrivateNetwork),
      });
      const monitor = createNextcloudTalkReceiveMonitor({
        client,
        store: createNextcloudTalkFileReceiveStateStore(resolveNextcloudTalkReceiveStatePath(current.accountId)),
        signal: stop.signal,
        ignoreBots: current.config.ignoreBots !== false,
        mentionAll: current.config.mentionAll === true,
        markRead: current.config.markRead !== false,
        presence: current.config.presence ?? "online",
        pushDebounceMs: current.config.pushDebounceMs,
        createWebSocket: (url) => new WebSocket(url) as unknown as NextcloudTalkWebSocketLike,
        resolveNotificationLevel: (room) =>
          resolveNextcloudTalkNotificationLevel({ cfg, account: current, room }),
        autoJoin: resolveNextcloudTalkAutoJoinPolicy(current),
        log: (message) => logger.info(`${prefix} ${message}`),
        error: (message) => logger.error(`${prefix} ${message}`),
        onReady: () => statusSink(channelReadyPatch()),
        onStopped: (error) => {
          // Sign-in rejected or IP throttled: stop everything, retry nothing.
          logger.error(`${prefix} ${error.message}`);
          stop.abort();
        },
        deliver: async (message) => {
          core.channel.activity.record({
            channel: NEXTCLOUD_TALK_CHANNEL_ID,
            accountId: current.accountId,
            direction: "inbound",
            at: message.timestamp,
          });
          return await handleNextcloudTalkInbound({
            message,
            account: current,
            config: cfg,
            runtime,
            statusSink,
          });
        },
      });
      logger.info(`${prefix} starting receive as Nextcloud user "${current.apiUser}"`);
      const running = monitor.run();
      return {
        stop: async () => {
          stop.abort();
          ctx.abortSignal.removeEventListener("abort", onAbort);
          await running;
        },
      };
    },
    stop: async (monitor) => {
      await monitor.stop();
    },
  });
}
