import type { ResolvedNextcloudTalkAccount } from "./accounts.js";

/**
 * Overlap with the bot plugin `nextcloud-talk`.
 * Pure function over the config, without network access.
 */

type BotSection = {
  enabled?: boolean;
  baseUrl?: string;
  dmPolicy?: string;
  allowFrom?: string[];
  groupPolicy?: string;
  groupAllowFrom?: string[];
  rooms?: Record<string, { enabled?: boolean } | undefined>;
  accounts?: Record<string, BotSection | undefined>;
};

/** Makes an allowlist entry comparable (prefixes of both plugins, letter case). */
export function normalizeNextcloudTalkOverlapEntry(raw: string): string {
  const value = raw
    .trim()
    .replace(/^(nextcloud-talk(-user)?|nc-talk(-user)?|nc):/iu, "")
    .trim()
    .toLowerCase();
  if (value === "*") {
    return "*";
  }
  return value.includes("/") ? value : `users/${value}`;
}

function origin(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).origin.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function botScopes(section: BotSection): BotSection[] {
  const accounts = Object.values(section.accounts ?? {}).filter(
    (entry): entry is BotSection => Boolean(entry),
  );
  // Accounts inherit the root values; the union is enough for the overlap check.
  return [section, ...accounts.map((entry) => ({ ...section, ...entry, accounts: undefined }))].filter(
    (scope) => scope.enabled !== false,
  );
}

function intersect(a: string[], b: string[]): string[] {
  const left = new Set(a.map(normalizeNextcloudTalkOverlapEntry));
  const right = new Set(b.map(normalizeNextcloudTalkOverlapEntry));
  if (left.has("*")) {
    return right.has("*") ? ["*"] : [...right];
  }
  if (right.has("*")) {
    return [...left];
  }
  return [...left].filter((entry) => right.has(entry));
}

export function collectNextcloudTalkBotPluginOverlap(params: {
  account: ResolvedNextcloudTalkAccount;
  botSection: unknown;
}): { warnings: string[]; infos: string[] } {
  const warnings: string[] = [];
  const infos: string[] = [];
  const section = params.botSection as BotSection | undefined;
  const { account } = params;
  if (!section || section.enabled === false) {
    return { warnings, infos };
  }
  const scopes = botScopes(section).filter(
    (scope) => !scope.baseUrl || !account.baseUrl || origin(scope.baseUrl) === origin(account.baseUrl),
  );
  if (scopes.length === 0) {
    return { warnings, infos };
  }

  // Rooms: which rooms of the bot plugin does this plugin serve as well?
  const userPolicy = account.config.groupPolicy ?? "allowlist";
  const userRooms = account.config.rooms ?? {};
  const userServes = (token: string) => {
    if (userPolicy === "disabled") {
      return false;
    }
    const entry = userRooms[token] ?? userRooms["*"];
    if (entry?.enabled === false) {
      return false;
    }
    const hasRoomList = Object.keys(userRooms).length > 0;
    return userPolicy === "open" ? !hasRoomList || Boolean(entry) : Boolean(entry);
  };
  const sharedRooms = new Set<string>();
  let botReactsToUser = false;
  for (const scope of scopes) {
    if (scope.groupPolicy === "disabled") {
      continue;
    }
    for (const [token, entry] of Object.entries(scope.rooms ?? {})) {
      if (token === "*" || entry?.enabled === false || !userServes(token)) {
        continue;
      }
      sharedRooms.add(token);
      const botSenders = (scope.groupAllowFrom ?? []).map(normalizeNextcloudTalkOverlapEntry);
      if (botSenders.includes("*") || botSenders.includes(normalizeNextcloudTalkOverlapEntry(account.apiUser))) {
        botReactsToUser = true;
      }
    }
  }
  if (sharedRooms.size > 0) {
    warnings.push(
      `Rooms ${[...sharedRooms].join(", ")} are also served by the bot plugin (channels.nextcloud-talk); ` +
        "both plugins may reply. Disable the room in one of the plugins or set the bot plugin to require a mention.",
    );
  }
  if (botReactsToUser) {
    warnings.push(
      `In shared rooms the bot plugin also reacts to messages from "${account.apiUser}" ` +
        "(groupAllowFrom); exclude that user there.",
    );
  }

  // Direct messages: senders allowed to send direct messages in both plugins.
  if ((account.config.dmPolicy ?? "pairing") !== "disabled") {
    const userDm = account.config.allowFrom ?? [];
    const shared = new Set<string>();
    for (const scope of scopes) {
      if ((scope.dmPolicy ?? "pairing") === "disabled") {
        continue;
      }
      for (const sender of intersect(userDm, scope.allowFrom ?? [])) {
        shared.add(sender);
      }
    }
    if (shared.size > 0) {
      warnings.push(
        `Direct messages from ${[...shared].join(", ")} are allowed in both plugins; ` +
          "both may reply. Adjust dmPolicy/allowFrom in one of the plugins.",
      );
    }
  }

  return { warnings, infos };
}
