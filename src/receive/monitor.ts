import type { NextcloudTalkInboundMessage } from "../types.js";
import {
  normalizeNextcloudTalkChatMessage,
  type NextcloudTalkChatMessage,
  type NextcloudTalkRoomSummary,
} from "./normalize-message.js";
import type { NextcloudTalkReceiveState, NextcloudTalkReceiveStateStore } from "./state.js";
import { NextcloudTalkAuthStoppedError, readNextcloudTalkOcsData, type NextcloudTalkClient } from "./talk-client.js";

/**
 * Receive layer:
 * - Trigger: notify_push (WebSocket) -> notifications API (ETag) -> room tokens
 * - Safety net: room list with modifiedSince (every 60 s, every 5 s without push) and a full
 *   sync (every fullSyncIntervalMs); catches silent messages and lost signals
 * - Source: chat API from the cursor (lookIntoFuture=1, timeout=0); the cursor only advances
 *   after a successful handoff; dedupe via cursor plus seen ids
 * - Presence: user_status heartbeat when available
 * - Errors: 401/throttling stops everything (NextcloudTalkClient); 404 disables the room until
 *   the next full sync, without retries (Talk counts them for brute-force protection)
 */

export type NextcloudTalkWebSocketLike = {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type NextcloudTalkReceiveMonitorOptions = {
  client: NextcloudTalkClient;
  store: NextcloudTalkReceiveStateStore;
  /** Hands a message over; true = dispatched to the agent (may then be marked as read). */
  deliver: (message: NextcloudTalkInboundMessage, room: NextcloudTalkRoomSummary) => Promise<boolean>;
  log?: (message: string) => void;
  error?: (message: string) => void;
  onReady?: () => void;
  onStopped?: (error: Error) => void;
  /**
   * Desired notification level of the account in a room (1 = always, 2 = on mention);
   * undefined = leave untouched. Applied via /notify when it differs.
   */
  resolveNotificationLevel?: (room: NextcloudTalkRoomSummary) => 1 | 2 | undefined;
  /**
   * Join allowed open rooms on its own (config autoJoin).
   * isAllowed checks the room allowlist from groupPolicy/rooms.
   */
  autoJoin?: { enabled: boolean; isAllowed: (token: string) => boolean };
  createWebSocket?: (url: string) => NextcloudTalkWebSocketLike;
  ignoreBots?: boolean;
  mentionAll?: boolean;
  markRead?: boolean;
  presence?: "online" | "silent";
  pushUrl?: string;
  pollIntervalMs?: number;
  pollIntervalWithoutPushMs?: number;
  fullSyncIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxCatchUp?: number;
  /**
   * Delays between handoff attempts for a message whose handoff fails. The message holds the
   * room meanwhile (order is preserved); after the last failed attempt it is skipped with an
   * error, so a permanent failure cannot block the room.
   */
  deliveryRetryDelaysMs?: readonly number[];
  signal: AbortSignal;
};

/** 5 s, 30 s, 2 min, 5 min, 10 min: about 17 minutes, longer than a short maintenance window. */
export const DEFAULT_NEXTCLOUD_TALK_DELIVERY_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000, 600_000] as const;

const CHAT_PAGE_LIMIT = 100;
const SEEN_LIMIT = 2_000;

type Capabilities = {
  pushWebsocket?: string;
  pushPreAuth?: string;
  userStatus: boolean;
};

function effectivePort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  return url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80";
}

/**
 * WebSocket URL for notify_push. The pre_auth token is sent over this connection, so the
 * advertised endpoint is only used on the server URL's host and port, and with an HTTPS
 * server URL only as `wss:` (never downgraded to `ws:`). Otherwise `/push/ws` on the server
 * URL's host is used, with `wss:` for HTTPS and `ws:` for HTTP.
 */
export function resolveNextcloudTalkPushUrl(
  baseUrl: string,
  advertisedUrl: string,
): { url: string; ignoredAdvertised?: string } {
  const base = new URL(baseUrl);
  const secure = base.protocol === "https:";
  const fallback = new URL("/push/ws", base);
  fallback.protocol = secure ? "wss:" : "ws:";
  let advertised: URL;
  try {
    advertised = new URL(advertisedUrl);
  } catch {
    return { url: fallback.toString(), ignoredAdvertised: "invalid URL" };
  }
  const allowedProtocols = secure ? ["wss:"] : ["ws:", "wss:"];
  const reason = !allowedProtocols.includes(advertised.protocol)
    ? secure
      ? "not wss: although the server URL uses HTTPS"
      : "not a WebSocket URL"
    : advertised.hostname !== base.hostname
      ? "different host"
      : effectivePort(advertised) !== effectivePort(base)
        ? "different port"
        : undefined;
  return reason
    ? { url: fallback.toString(), ignoredAdvertised: reason }
    : { url: advertised.toString() };
}

export function createNextcloudTalkReceiveMonitor(options: NextcloudTalkReceiveMonitorOptions) {
  const {
    client,
    store,
    signal,
    log = () => {},
    error = () => {},
    ignoreBots = true,
    mentionAll = false,
    markRead = true,
    presence = "online",
    pollIntervalMs = 60_000,
    pollIntervalWithoutPushMs = 5_000,
    fullSyncIntervalMs = 5 * 60_000,
    heartbeatIntervalMs = 5 * 60_000,
    maxCatchUp = 50,
    deliveryRetryDelaysMs = DEFAULT_NEXTCLOUD_TALK_DELIVERY_RETRY_DELAYS_MS,
  } = options;

  let state: NextcloudTalkReceiveState = { version: 1, rooms: {} };
  const rooms = new Map<
    string,
    NextcloudTalkRoomSummary & { lastMessageId?: number; notificationLevel?: number }
  >();
  const disabledRooms = new Set<string>();
  const seen = new Set<string>();
  let modifiedSince: string | undefined;
  let notificationsEtag: string | undefined;
  let pushConnected = false;
  let stoppedError: Error | undefined;
  const pendingRooms = new Set<string>();
  /** Failed handoffs per message (token:id): attempt count and earliest next attempt. */
  const deliveryFailures = new Map<string, { attempts: number; nextAt: number }>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  signal.addEventListener(
    "abort",
    () => {
      for (const timer of retryTimers) {
        clearTimeout(timer);
      }
      retryTimers.clear();
    },
    { once: true },
  );

  const remember = (key: string) => {
    seen.add(key);
    if (seen.size > SEEN_LIMIT) {
      const first = seen.values().next().value;
      if (first !== undefined) {
        seen.delete(first);
      }
    }
  };

  const handleError = (where: string, err: unknown) => {
    if (err instanceof NextcloudTalkAuthStoppedError) {
      if (!stoppedError) {
        stoppedError = err;
        error(`[receive] ${err.message}`);
        options.onStopped?.(err);
      }
      return;
    }
    if (signal.aborted) {
      return;
    }
    error(`[receive] ${where}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

  const active = () => !signal.aborted && !stoppedError;

  // ---------------------------------------------------------------- Rooms
  function rememberRoom(
    raw: Record<string, unknown>,
  ): (NextcloudTalkRoomSummary & { lastMessageId?: number; notificationLevel?: number }) | undefined {
    const token = typeof raw.token === "string" ? raw.token : "";
    if (!token) {
      return undefined;
    }
    const lastMessage = raw.lastMessage as { id?: unknown } | undefined;
    const lastMessageId = Number(lastMessage?.id);
    const notificationLevel = Number(raw.notificationLevel);
    const room = {
      token,
      type: Number(raw.type),
      displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
      name: typeof raw.name === "string" ? raw.name : undefined,
      lastMessageId: Number.isSafeInteger(lastMessageId) ? lastMessageId : undefined,
      notificationLevel: Number.isSafeInteger(notificationLevel) ? notificationLevel : undefined,
    };
    rooms.set(token, room);
    return room;
  }

  /** Sets the account's notification level when it differs from the desired one. */
  async function applyNotificationLevel(room: NextcloudTalkRoomSummary & { notificationLevel?: number }) {
    const desired = options.resolveNotificationLevel?.(room);
    if (desired === undefined || room.notificationLevel === desired || disabledRooms.has(room.token)) {
      return;
    }
    try {
      const response = await client.request({
        method: "POST",
        path: `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(room.token)}/notify`,
        form: { level: String(desired) },
        signal,
      });
      if (response.status === 200) {
        const previous = room.notificationLevel;
        room.notificationLevel = desired;
        log(
          `[receive] room ${room.token}: notification level set to ${
            desired === 1 ? "always" : "mention"
          } (was ${previous ?? "?"})`,
        );
      } else {
        error(`[receive] room ${room.token}: notification level not set (HTTP ${response.status})`);
      }
    } catch (err) {
      if (err instanceof NextcloudTalkAuthStoppedError) {
        throw err;
      }
      handleError(`notification level ${room.token}`, err);
    }
  }

  async function syncRooms(full: boolean) {
    const response = await client.request({
      method: "GET",
      path: "/ocs/v2.php/apps/spreed/api/v4/room",
      query: { noStatusUpdate: 1, ...(full || !modifiedSince ? {} : { modifiedSince }) },
      signal,
    });
    if (response.status !== 200) {
      throw new Error(`Raumliste: HTTP ${response.status}`);
    }
    const list = Array.isArray(readNextcloudTalkOcsData(response)) ? (readNextcloudTalkOcsData(response) as Record<string, unknown>[]) : [];
    modifiedSince = response.headers.get("x-nextcloud-talk-modified-before") ?? modifiedSince;
    const present = new Set<string>();
    let stateChanged = false;
    for (const raw of list) {
      const room = rememberRoom(raw);
      if (!room) {
        continue;
      }
      present.add(room.token);
      await applyNotificationLevel(room);
      if (full) {
        // Allow again after being removed and re-added.
        disabledRooms.delete(room.token);
      }
      const known = state.rooms[room.token];
      if (!known) {
        // First contact: do not replay old history.
        state.rooms[room.token] = { cursor: room.lastMessageId ?? 0 };
        stateChanged = true;
        log(`[receive] new room ${room.token} (${room.displayName ?? ""}), cursor ${room.lastMessageId ?? 0}`);
        continue;
      }
      if ((room.lastMessageId ?? 0) > known.cursor && !disabledRooms.has(room.token)) {
        pendingRooms.add(room.token);
      }
    }
    if (full) {
      for (const token of [...rooms.keys()]) {
        if (!present.has(token)) {
          rooms.delete(token);
          log(`[receive] room ${token} is no longer in the room list (removed or deleted)`);
          const joined = state.autoJoin?.[token];
          if (joined && joined.removedAt === undefined) {
            // Joined on its own and removed again: respect the moderator's decision.
            joined.removedAt = Date.now();
            stateChanged = true;
            log(`[receive] room ${token}: removed after auto-join; not joining again`);
          }
        }
      }
    }
    if (stateChanged) {
      await store.save(state);
    }
  }

  // ---------------------------------------------------------------- Auto-join
  /**
   * With autoJoin, joins every open room from listed-room that the config allows, only
   * without an active lobby and without a password. The session is ended right away (the
   * account stays a member). No rejoin after removal until autoJoin is switched off and on.
   */
  async function runAutoJoin(): Promise<boolean> {
    const policy = options.autoJoin;
    const enabled = policy?.enabled === true;
    if (state.autoJoinEnabled !== enabled) {
      // Switching autoJoin off and on again allows a rejoin after removal.
      if (enabled && state.autoJoin) {
        for (const entry of Object.values(state.autoJoin)) {
          delete entry.removedAt;
        }
      }
      state.autoJoinEnabled = enabled;
      await store.save(state);
    }
    if (!enabled || !policy) {
      return false;
    }
    const listedResponse = await client.request({
      method: "GET",
      path: "/ocs/v2.php/apps/spreed/api/v4/listed-room",
      signal,
    });
    if (listedResponse.status !== 200) {
      throw new Error(`Listed rooms: HTTP ${listedResponse.status}`);
    }
    const listedData = readNextcloudTalkOcsData(listedResponse);
    const listed = Array.isArray(listedData) ? (listedData as Record<string, unknown>[]) : [];
    let joinedAny = false;
    for (const entry of listed) {
      const token = typeof entry.token === "string" ? entry.token : "";
      if (!token || rooms.has(token) || !active()) {
        continue;
      }
      if (state.autoJoin?.[token]?.removedAt !== undefined) {
        continue;
      }
      if (!policy.isAllowed(token)) {
        continue;
      }
      if (Number(entry.lobbyState) !== 0) {
        log(`[receive] autoJoin ${token}: lobby active; not joining`);
        continue;
      }
      if (entry.hasPassword === true) {
        log(`[receive] autoJoin ${token}: room has a password; not joining`);
        continue;
      }
      const join = await client.request({
        method: "POST",
        path: `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(token)}/participants/active`,
        signal,
      });
      if (join.status !== 200) {
        // 403/404/412: do not retry (brute-force counter, moderation decision).
        log(`[receive] autoJoin ${token}: join rejected (HTTP ${join.status})`);
        continue;
      }
      // End the Talk session right away within the same Nextcloud session; the account stays a member.
      const cookies = (join.headers.getSetCookie?.() ?? [])
        .map((cookie) => cookie.split(";")[0])
        .filter(Boolean)
        .join("; ");
      await client
        .request({
          method: "DELETE",
          path: `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(token)}/participants/active`,
          headers: cookies ? { Cookie: cookies } : {},
          signal,
        })
        .catch((err) => handleError(`autoJoin ${token} leave session`, err));
      (state.autoJoin ??= {})[token] = { joinedAt: Date.now() };
      await store.save(state);
      joinedAny = true;
      log(`[receive] autoJoin ${token}: joined room (${String(entry.displayName ?? "")})`);
    }
    return joinedAny;
  }

  // ---------------------------------------------------------------- Chat
  async function fetchNewMessages(token: string, cursor: number) {
    const collected: NextcloudTalkChatMessage[] = [];
    let lastKnown = cursor;
    for (let page = 0; page < 10; page++) {
      const response = await client.request({
        method: "GET",
        path: `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(token)}`,
        query: {
          lookIntoFuture: 1,
          timeout: 0,
          limit: CHAT_PAGE_LIMIT,
          lastKnownMessageId: lastKnown,
          setReadMarker: 0,
          markNotificationsAsRead: 1,
          noStatusUpdate: 1,
        },
        signal,
      });
      if (response.status === 304) {
        break;
      }
      if (response.status === 404 || response.status === 412) {
        return { status: response.status, messages: collected };
      }
      if (response.status !== 200) {
        throw new Error(`Chat ${token}: HTTP ${response.status}`);
      }
      const data = readNextcloudTalkOcsData(response);
      const batch = Array.isArray(data) ? (data as NextcloudTalkChatMessage[]) : [];
      collected.push(...batch);
      const lastGiven = Number(response.headers.get("x-chat-last-given"));
      const maxId = batch.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), lastKnown);
      lastKnown = Number.isSafeInteger(lastGiven) && lastGiven > lastKnown ? lastGiven : maxId;
      if (batch.length < CHAT_PAGE_LIMIT) {
        break;
      }
    }
    return { status: 200, messages: collected };
  }

  async function processRoom(token: string) {
    const room = rooms.get(token) ?? { token, type: 2 };
    const entry = (state.rooms[token] ??= { cursor: 0 });
    const result = await fetchNewMessages(token, entry.cursor);
    if (result.status === 404) {
      // Do not retry: Talk counts 404s for brute-force protection.
      disabledRooms.add(token);
      log(`[receive] room ${token}: no access anymore (404); paused until the next full sync`);
      return;
    }
    if (result.status === 412) {
      disabledRooms.add(token);
      log(`[receive] room ${token}: lobby active (412); paused until the next full sync`);
      return;
    }
    let messages = result.messages
      .filter((message) => Number(message.id) > entry.cursor)
      .sort((a, b) => a.id - b.id);
    if (messages.length > maxCatchUp) {
      const skipped = messages.length - maxCatchUp;
      log(`[receive] room ${token}: skipped ${skipped} older messages (maxCatchUp ${maxCatchUp})`);
      messages = messages.slice(-maxCatchUp);
    }
    let lastDispatched: number | undefined;
    for (const message of messages) {
      if (!active()) {
        return;
      }
      const key = `${token}:${message.id}`;
      if (!seen.has(key)) {
        const outcome = normalizeNextcloudTalkChatMessage({
          message,
          room,
          selfUser: client.user,
          ignoreBots,
          mentionAll,
        });
        if (outcome.kind === "deliver") {
          const failure = deliveryFailures.get(key);
          if (failure && failure.nextAt > Date.now()) {
            // Still waiting after a failed attempt; the retry timer reschedules the room.
            break;
          }
          let dispatched = false;
          try {
            dispatched = await options.deliver(outcome.message, room);
            deliveryFailures.delete(key);
          } catch (err) {
            if (err instanceof NextcloudTalkAuthStoppedError || !active()) {
              throw err;
            }
            const attempts = (failure?.attempts ?? 0) + 1;
            const reason = err instanceof Error ? err.message : String(err);
            const delay = deliveryRetryDelaysMs[attempts - 1];
            if (delay === undefined) {
              // Permanent failure: skip instead of holding the room forever.
              deliveryFailures.delete(key);
              error(
                `[receive] room ${token}: skipped message ${message.id} after ${attempts} failed attempts: ${reason}`,
              );
            } else {
              // The cursor stays; later messages of the room wait (order is preserved).
              deliveryFailures.set(key, { attempts, nextAt: Date.now() + delay });
              error(
                `[receive] room ${token}: handoff of message ${message.id} failed ` +
                  `(attempt ${attempts}/${deliveryRetryDelaysMs.length + 1}), retrying in ` +
                  `${Math.round(delay / 1000)} s: ${reason}`,
              );
              const timer = setTimeout(() => {
                retryTimers.delete(timer);
                // Timers can fire slightly before Date.now() reaches nextAt; release the gate
                // explicitly so the retry is not skipped.
                const pending = deliveryFailures.get(key);
                if (pending) {
                  pending.nextAt = 0;
                }
                if (active()) {
                  void schedule([token]);
                }
              }, delay);
              timer.unref?.();
              retryTimers.add(timer);
              break;
            }
          }
          if (dispatched) {
            lastDispatched = message.id;
          }
        }
        remember(key);
      }
      entry.cursor = Math.max(entry.cursor, message.id);
      await store.save(state);
    }
    if (markRead && lastDispatched !== undefined) {
      await client
        .request({
          method: "POST",
          path: `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(token)}/read`,
          form: { lastReadMessage: String(lastDispatched) },
          signal,
        })
        .catch((err) => handleError(`read marker ${token}`, err));
    }
  }

  /** Rooms run in parallel, messages within a room strictly in order. */
  const running = new Map<string, Promise<void>>();
  function schedule(tokens: Iterable<string>): Promise<void> {
    for (const token of tokens) {
      if (!disabledRooms.has(token)) {
        pendingRooms.add(token);
      }
    }
    for (const token of [...pendingRooms]) {
      if (running.has(token) || !active()) {
        continue;
      }
      pendingRooms.delete(token);
      const job = (async () => {
        try {
          await processRoom(token);
        } catch (err) {
          handleError(`room ${token}`, err);
        } finally {
          running.delete(token);
          // Pick up messages reported while the room was being processed.
          if (pendingRooms.has(token) && active()) {
            void schedule([]);
          }
        }
      })();
      running.set(token, job);
    }
    return Promise.allSettled([...running.values()]).then(() => undefined);
  }

  // ---------------------------------------------------------------- Notifications
  async function checkNotifications() {
    const response = await client.request({
      method: "GET",
      path: "/ocs/v2.php/apps/notifications/api/v2/notifications",
      headers: notificationsEtag ? { "If-None-Match": notificationsEtag } : {},
      signal,
    });
    if (response.status === 304) {
      return;
    }
    if (response.status !== 200) {
      throw new Error(`Notifications: HTTP ${response.status}`);
    }
    notificationsEtag = response.headers.get("etag") ?? undefined;
    const list = Array.isArray(readNextcloudTalkOcsData(response)) ? (readNextcloudTalkOcsData(response) as Record<string, unknown>[]) : [];
    const tokens = new Set<string>();
    let invitation = false;
    for (const notification of list) {
      if (notification.app !== "spreed") {
        continue;
      }
      const objectId = typeof notification.object_id === "string" ? notification.object_id : "";
      if (notification.object_type === "chat") {
        const token = objectId.split("/")[0];
        if (token) {
          tokens.add(token);
        }
      } else if (notification.object_type === "room") {
        invitation = true;
      }
    }
    if (invitation) {
      await syncRooms(true);
    }
    // Rooms we do not know yet are picked up through the room list first.
    if ([...tokens].some((token) => !state.rooms[token])) {
      await syncRooms(false);
    }
    await schedule([...tokens].filter((token) => state.rooms[token]));
  }

  // ---------------------------------------------------------------- Push
  async function resolvePushUrl(caps: Capabilities): Promise<string | undefined> {
    if (options.pushUrl) {
      return options.pushUrl;
    }
    if (!caps.pushWebsocket) {
      return undefined;
    }
    const resolved = resolveNextcloudTalkPushUrl(client.baseUrl, caps.pushWebsocket);
    if (resolved.ignoredAdvertised) {
      log(`[receive] notify_push: advertised endpoint ignored (${resolved.ignoredAdvertised}); using ${resolved.url}`);
    }
    return resolved.url;
  }

  async function runPush(caps: Capabilities) {
    const createWebSocket = options.createWebSocket;
    const url = await resolvePushUrl(caps);
    if (!createWebSocket || !url || !caps.pushPreAuth) {
      log("[receive] notify_push not available; polling only");
      return;
    }
    let backoff = 1_000;
    while (active()) {
      const preAuth = await client.request({
        method: "POST",
        path: new URL(caps.pushPreAuth).pathname,
        signal,
      });
      if (preAuth.status !== 200 || !preAuth.text.trim()) {
        throw new Error(`notify_push pre_auth: HTTP ${preAuth.status}`);
      }
      const closed = await new Promise<"closed" | "rejected">((resolve) => {
        const ws = createWebSocket(url);
        let debounce: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => ws.close();
        signal.addEventListener("abort", onAbort, { once: true });
        ws.onopen = () => {
          ws.send("");
          ws.send(preAuth.text.trim());
        };
        ws.onmessage = (event) => {
          const data = String(event.data);
          if (data === "authenticated") {
            pushConnected = true;
            backoff = 1_000;
            log("[receive] notify_push connected");
            // Signals during the outage are lost: catch up once.
            void checkNotifications().catch((err) => handleError("notifications", err));
            void syncRooms(false)
              .then(() => schedule([]))
              .catch((err) => handleError("room list", err));
          } else if (data.startsWith("err:")) {
            log(`[receive] notify_push lehnt ab: ${data}`);
            ws.close();
            resolve("rejected");
          } else if (data === "notify_notification") {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
              void checkNotifications().catch((err) => handleError("notifications", err));
            }, 300);
          }
        };
        ws.onerror = () => {};
        ws.onclose = () => {
          clearTimeout(debounce);
          signal.removeEventListener("abort", onAbort);
          pushConnected = false;
          resolve("closed");
        };
      });
      if (!active()) {
        return;
      }
      if (closed === "rejected") {
        // Do not keep re-authenticating; polling stays active.
        log("[receive] notify_push rejected; continuing with polling only");
        return;
      }
      log(`[receive] notify_push disconnected; retrying in ${Math.round(backoff / 1000)} s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 5 * 60_000);
    }
  }

  // ---------------------------------------------------------------- Presence
  async function runHeartbeat(caps: Capabilities) {
    if (presence !== "online" || !caps.userStatus) {
      return;
    }
    while (active()) {
      try {
        await client.request({
          method: "PUT",
          path: "/ocs/v2.php/apps/user_status/api/v1/heartbeat",
          form: { status: "online" },
          signal,
        });
      } catch (err) {
        handleError("Heartbeat", err);
      }
      await sleep(heartbeatIntervalMs);
    }
  }

  // ---------------------------------------------------------------- Start
  async function loadCapabilities(): Promise<Capabilities> {
    const response = await client.request({ method: "GET", path: "/ocs/v2.php/cloud/capabilities", signal });
    const caps = (readNextcloudTalkOcsData(response) as { capabilities?: Record<string, any> } | undefined)?.capabilities ?? {};
    return {
      pushWebsocket: caps.notify_push?.endpoints?.websocket,
      pushPreAuth: caps.notify_push?.endpoints?.pre_auth,
      userStatus: Boolean(caps.user_status?.enabled),
    };
  }

  /** Auto-join; newly joined rooms are picked up by a full sync (without old history). */
  async function autoJoinAndResync() {
    try {
      if (await runAutoJoin()) {
        await syncRooms(true);
      }
    } catch (err) {
      if (err instanceof NextcloudTalkAuthStoppedError) {
        throw err;
      }
      handleError("autoJoin", err);
    }
  }

  async function run() {
    state = await store.load();
    const caps = await loadCapabilities();
    await syncRooms(true);
    await autoJoinAndResync();
    log(`[receive] ready: ${rooms.size} rooms, push ${caps.pushWebsocket ? "available" : "unavailable"}, presence ${caps.userStatus ? presence : "without user_status"}`);
    options.onReady?.();
    await schedule([]);

    const push = runPush(caps).catch((err) => handleError("notify_push", err));
    const heartbeat = runHeartbeat(caps);
    let lastFull = Date.now();
    let lastSyncFailed = false;
    while (active()) {
      // Poll at the short interval after a failure: the WebSocket often notices a network
      // outage only after minutes and still counts as connected until then.
      await sleep(pushConnected && !lastSyncFailed ? pollIntervalMs : pollIntervalWithoutPushMs);
      if (!active()) {
        break;
      }
      try {
        const full = Date.now() - lastFull >= fullSyncIntervalMs;
        await syncRooms(full);
        if (full) {
          lastFull = Date.now();
          await autoJoinAndResync();
          await checkNotifications();
        }
        lastSyncFailed = false;
        await schedule([]);
      } catch (err) {
        lastSyncFailed = true;
        handleError("sync", err);
      }
    }
    await Promise.allSettled([push, heartbeat, ...running.values()]);
  }

  return {
    run: () =>
      run().catch((err) => {
        handleError("Start", err);
      }),
    /** For tests and diagnostics. */
    snapshot: () => ({ state: structuredClone(state), disabledRooms: [...disabledRooms], pushConnected }),
    triggerNotifications: () =>
      checkNotifications().catch((err) => handleError("notifications", err)),
    autoJoin: () => autoJoinAndResync().catch((err) => handleError("autoJoin", err)),
    syncRooms: (full: boolean) =>
      syncRooms(full)
        .then(() => schedule([]))
        .catch((err) => handleError("sync", err)),
  };
}
