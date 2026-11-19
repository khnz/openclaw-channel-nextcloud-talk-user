import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

/**
 * Receive state per account: cursor (last processed message id) per room. Stored
 * separately from the bot plugin under
 * <stateDir>/nextcloud-talk-user/<accountId>/receive-state.json.
 */
export type NextcloudTalkReceiveState = {
  version: 1;
  rooms: Record<string, { cursor: number }>;
  /**
   * Rooms joined via autoJoin and, if any, when the account was removed again
   * (then no rejoin until autoJoin is switched off and on).
   */
  autoJoin?: Record<string, { joinedAt: number; removedAt?: number }>;
  /** Last seen value of autoJoin, to detect switching it off and on. */
  autoJoinEnabled?: boolean;
};

export type NextcloudTalkReceiveStateStore = {
  load(): Promise<NextcloudTalkReceiveState>;
  save(state: NextcloudTalkReceiveState): Promise<void>;
  readonly filePath: string;
};

function sanitizeSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/gu, "_") || "default";
}

export function resolveNextcloudTalkReceiveStatePath(accountId: string, env = process.env): string {
  return path.join(
    resolveStateDir(env, os.homedir),
    "nextcloud-talk-user",
    sanitizeSegment(accountId),
    "receive-state.json",
  );
}

export function createNextcloudTalkFileReceiveStateStore(filePath: string): NextcloudTalkReceiveStateStore {
  return {
    filePath,
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<NextcloudTalkReceiveState>;
        const rooms: NextcloudTalkReceiveState["rooms"] = {};
        for (const [token, entry] of Object.entries(parsed.rooms ?? {})) {
          const cursor = Number(entry?.cursor);
          if (Number.isSafeInteger(cursor) && cursor >= 0) {
            rooms[token] = { cursor };
          }
        }
        const autoJoin: NonNullable<NextcloudTalkReceiveState["autoJoin"]> = {};
        for (const [token, entry] of Object.entries(parsed.autoJoin ?? {})) {
          if (entry && Number.isFinite(entry.joinedAt)) {
            autoJoin[token] = {
              joinedAt: entry.joinedAt,
              ...(Number.isFinite(entry.removedAt) ? { removedAt: entry.removedAt } : {}),
            };
          }
        }
        return {
          version: 1,
          rooms,
          ...(Object.keys(autoJoin).length ? { autoJoin } : {}),
          ...(typeof parsed.autoJoinEnabled === "boolean" ? { autoJoinEnabled: parsed.autoJoinEnabled } : {}),
        };
      } catch {
        return { version: 1, rooms: {} };
      }
    },
    async save(state) {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, filePath);
    },
  };
}

export function createNextcloudTalkMemoryReceiveStateStore(initial?: NextcloudTalkReceiveState): NextcloudTalkReceiveStateStore & {
  current: NextcloudTalkReceiveState;
} {
  const store = {
    filePath: ":memory:",
    current: structuredClone(initial ?? { version: 1 as const, rooms: {} }),
    async load() {
      return structuredClone(store.current);
    },
    async save(state: NextcloudTalkReceiveState) {
      store.current = structuredClone(state);
    },
  };
  return store;
}
