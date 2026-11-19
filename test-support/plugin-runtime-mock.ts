// Lean replacement for createPluginRuntimeMock from the OpenClaw monorepo
// (src/plugin-sdk/test-helpers/plugin-runtime-mock.ts), which the published package lacks.
//
// Real host logic where the tests need it (through published SDK exports):
// - Access decision: resolveStableChannelMessageIngress
// - Mention patterns: buildMentionRegexes/matchesMentionPatterns (like upstream with /\bbert\b/i)
// Everything else is a vi.fn spy with the defaults of the upstream mock; unknown paths
// return spies automatically so code unrelated to a test does not fail.
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { vi } from "vitest";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (...args: never[]) => unknown ? T[K] : DeepPartial<T[K]> };

// Wie upstream (TEST_SAVED_MEDIA in plugin-runtime-mock.ts).
export const TEST_SAVED_MEDIA = {
  id: "test-media.jpg",
  path: "/tmp/test-media.jpg",
  size: 0,
  contentType: "image/jpeg",
};

type BuildContextParams = Record<string, any>;

function buildContextDefault(params: BuildContextParams) {
  const extra = { ...(params.extra ?? {}) };
  delete extra.UntrustedStructuredContext;
  return {
    Body: params.message.body ?? params.message.rawBody,
    BodyForAgent: params.message.bodyForAgent ?? params.message.rawBody,
    RawBody: params.message.rawBody,
    CommandBody: params.message.commandBody ?? params.message.rawBody,
    BodyForCommands: params.message.commandBody ?? params.message.rawBody,
    From: params.from,
    To: params.reply?.to,
    SessionKey: params.route?.dispatchSessionKey ?? params.route?.routeSessionKey,
    AccountId: params.route?.accountId ?? params.accountId,
    MessageSid: params.messageId,
    MessageSidFull: params.messageIdFull,
    ReplyToId: params.reply?.replyToId ?? params.supplemental?.quote?.id,
    media: params.media,
    ChatType: params.conversation?.kind,
    ConversationLabel: params.conversation?.label,
    SenderName: params.sender?.name ?? params.sender?.displayLabel,
    SenderId: params.sender?.id,
    Timestamp: params.timestamp,
    WasMentioned: params.access?.mentions?.wasMentioned,
    Provider: params.provider ?? params.channel,
    Surface: params.surface ?? params.provider ?? params.channel,
    OriginatingChannel: params.channel,
    OriginatingTo: params.reply?.originatingTo,
    CommandAuthorized: params.access?.commands?.authorized ?? false,
    MessageThreadId: params.thread?.id,
    ...extra,
  };
}

function baseRuntime(getRuntime: () => any) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return {
    version: "test",
    logging: { getChildLogger: vi.fn(() => logger), shouldLogVerbose: vi.fn(() => false) },
    channel: {
      inbound: {
        ingress: { resolveStable: vi.fn(resolveStableChannelMessageIngress) },
        buildContext: vi.fn(buildContextDefault),
        // Like upstream: dispatch hands the assembled turn on to dispatchReply.
        dispatch: vi.fn(async (params: Record<string, unknown>) =>
          getRuntime().channel.inbound.dispatchReply(params),
        ),
        dispatchReply: vi.fn(async () => undefined),
      },
      pairing: {
        buildPairingReply: vi.fn(() => "Pairing code: TESTCODE"),
        readAllowFromStore: vi.fn().mockResolvedValue([]),
        removeAllowFromStoreEntry: vi.fn().mockResolvedValue({ changed: false, allowFrom: [] }),
        upsertPairingRequest: vi.fn().mockResolvedValue({ code: "TESTCODE", created: true }),
      },
      media: {
        readRemoteMediaBuffer: vi.fn(),
        fetchRemoteMedia: vi.fn(),
        saveRemoteMedia: vi.fn().mockResolvedValue(TEST_SAVED_MEDIA),
        saveResponseMedia: vi.fn().mockResolvedValue(TEST_SAVED_MEDIA),
        saveMediaBuffer: vi.fn().mockResolvedValue(TEST_SAVED_MEDIA),
        deleteMediaBuffer: vi.fn().mockResolvedValue(undefined),
      },
      mentions: {
        buildMentionRegexes: vi.fn(() => [/\bbert\b/i]),
        matchesMentionPatterns: vi.fn((text: string, regexes: RegExp[]) =>
          regexes.some((regex) => regex.test(text)),
        ),
      },
      commands: { shouldHandleTextCommands: vi.fn(() => false) },
      text: {
        hasControlCommand: vi.fn(() => false),
        chunkMarkdownText: vi.fn((text: string) => [text]),
      },
      activity: { record: vi.fn(), get: vi.fn(() => ({ inboundAt: null, outboundAt: null })) },
      session: { resolveStorePath: vi.fn(() => "/tmp/openclaw-test-sessions") },
    },
    state: { resolveStateDir: vi.fn(() => "/tmp/openclaw-test-state") },
    config: {
      current: vi.fn(() => ({})),
      replaceConfigFile: vi.fn(async () => undefined),
      mutateConfigFile: vi.fn(async () => ({ result: undefined })),
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !vi.isMockFunction(value);
}

function merge(target: Record<string, unknown>, overrides: Record<string, unknown>) {
  for (const [key, value] of Object.entries(overrides)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      merge(target[key] as Record<string, unknown>, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/** Unknown paths return spies (like createGenericMock upstream). */
function withFallback<T extends object>(value: T): T {
  return new Proxy(value, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") {
        return Reflect.get(target, prop, receiver);
      }
      if (!(prop in target)) {
        (target as Record<string, unknown>)[prop] = withFallback(vi.fn());
      }
      const current = Reflect.get(target, prop, receiver);
      return isPlainObject(current) ? withFallback(current) : current;
    },
  });
}

export function createPluginRuntimeMock(overrides: DeepPartial<PluginRuntime> = {}): PluginRuntime {
  let proxy: PluginRuntime | undefined;
  const runtime = merge(
    baseRuntime(() => proxy) as Record<string, unknown>,
    overrides as Record<string, unknown>,
  );
  proxy = withFallback(runtime) as unknown as PluginRuntime;
  return proxy;
}

/**
 * Host plugin registry: not available as a test helper in the published package.
 * Tests that need the host's durable reply delivery (registry + state database) cannot
 * run with it and are marked accordingly.
 */
export function createTestRegistry<T>(entries: T[]): { entries: T[] } {
  return { entries };
}
export function setActivePluginRegistry(_registry: unknown): void {}
