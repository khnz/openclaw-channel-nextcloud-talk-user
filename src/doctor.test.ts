import { describe, expect, it } from "vitest";
import { collectNextcloudTalkBotPluginOverlap, normalizeNextcloudTalkOverlapEntry } from "./doctor-overlap.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { runNextcloudTalkDoctorSequence } from "./doctor.js";
import type { NextcloudTalkRawHttp } from "./receive/talk-client.js";
import type { CoreConfig } from "./types.js";

const BASE = "https://cloud.example.test";
const userSection = (extra: Record<string, unknown> = {}) => ({
  baseUrl: BASE,
  apiUser: "agent",
  apiPassword: "app-pw",
  dmPolicy: "allowlist",
  allowFrom: ["users/owner"],
  groupPolicy: "open",
  ...extra,
});
const botSection = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  baseUrl: BASE,
  dmPolicy: "allowlist",
  allowFrom: ["users/owner"],
  groupAllowFrom: ["*"],
  rooms: { room1abc: {}, room2xyz: {} },
  ...extra,
});
const cfgWith = (user: Record<string, unknown>, bot?: Record<string, unknown>): CoreConfig =>
  ({
    channels: {
      "nextcloud-talk-user": user,
      ...(bot ? { "nextcloud-talk": bot } : {}),
    },
  }) as CoreConfig;

/** Fake server for the network checks. */
function server(options: {
  uid?: string;
  status?: number;
  body?: string;
  capabilities?: Record<string, unknown>;
  throws?: boolean;
}) {
  const calls: string[] = [];
  const http: NextcloudTalkRawHttp = async ({ url }) => {
    calls.push(new URL(url).pathname);
    if (options.throws) {
      throw new Error("ECONNREFUSED");
    }
    if (options.status) {
      return { status: options.status, headers: new Headers(), text: options.body ?? "" };
    }
    const path = new URL(url).pathname;
    const data =
      path === "/ocs/v1.php/cloud/user"
        ? { id: options.uid ?? "agent" }
        : {
            capabilities: options.capabilities ?? {
              spreed: {},
              notify_push: { endpoints: { websocket: "wss://cloud.example.test/push/ws" } },
              user_status: { enabled: true },
            },
          };
    return { status: 200, headers: new Headers(), text: JSON.stringify({ ocs: { data } }) };
  };
  return { http, calls };
}

const run = (cfg: CoreConfig, http?: NextcloudTalkRawHttp) =>
  runNextcloudTalkDoctorSequence({ cfg }, http ? { http: () => http } : {});

describe("Doctor: config", () => {
  it("reports missing required settings without network access", async () => {
    const result = await run(cfgWith({ apiUser: "", apiPassword: undefined, baseUrl: "" }), server({}).http);
    expect(result.warningNotes.join("\n")).toMatch(/baseUrl is missing/);
    expect(result.warningNotes.join("\n")).toMatch(/apiUser .* is missing/);
    expect(result.warningNotes.join("\n")).toMatch(/App password is missing/);
  });

  it("has no blocklist for accounts", async () => {
    const result = await run(cfgWith(userSection({ apiUser: "owner" })), server({ uid: "owner" }).http);
    expect(result.warningNotes).toEqual([]);
  });
});

describe("Doctor: overlap with the bot plugin", () => {
  const overlap = (user: Record<string, unknown>, bot?: Record<string, unknown>) =>
    collectNextcloudTalkBotPluginOverlap({
      account: resolveNextcloudTalkAccount({ cfg: cfgWith(user) }),
      botSection: bot,
    }).warnings;

  it("reports shared rooms, reactions to the account and duplicate direct messages", () => {
    const warnings = overlap(userSection(), botSection());
    expect(warnings[0]).toMatch(/Rooms room1abc, room2xyz are also served by the bot plugin/);
    expect(warnings[1]).toMatch(/also reacts to messages from "agent"/);
    expect(warnings[2]).toMatch(/Direct messages from users\/owner/);
  });

  it("reports nothing when the bot plugin is missing, disabled or uses another server", () => {
    expect(overlap(userSection())).toEqual([]);
    expect(overlap(userSection(), botSection({ enabled: false }))).toEqual([]);
    expect(overlap(userSection(), botSection({ baseUrl: "https://other.example.test" }))).toEqual([]);
  });

  it("respects room lists, disabled rooms and dmPolicy", () => {
    expect(
      overlap(
        userSection({ groupPolicy: "allowlist", rooms: { other: {} }, dmPolicy: "disabled" }),
        botSection(),
      ),
    ).toEqual([]);
    expect(
      overlap(userSection({ rooms: { "*": {}, room1abc: { enabled: false } }, allowFrom: ["users/tester"] }), botSection({ groupAllowFrom: ["users/owner"] })),
    ).toEqual([expect.stringMatching(/Rooms room2xyz /)]);
  });

  it("compares senders regardless of prefix and letter case", () => {
    expect(normalizeNextcloudTalkOverlapEntry("nextcloud-talk:Users/OWNER")).toBe("users/owner");
    expect(normalizeNextcloudTalkOverlapEntry("nc-talk-user:owner")).toBe("users/owner");
    expect(
      overlap(userSection({ allowFrom: ["*"] }), botSection({ rooms: {}, allowFrom: ["nextcloud-talk:owner"] })),
    ).toEqual([expect.stringMatching(/Direct messages from users\/owner/)]);
  });

  it("warns when ignoreBots is off, even without the bot plugin", async () => {
    const result = await run(cfgWith(userSection({ ignoreBots: false })), server({}).http);
    expect(result.warningNotes).toEqual([expect.stringMatching(/loop/)]);
  });
});

describe("Doctor: server", () => {
  it("reports nothing for a complete setup", async () => {
    const result = await run(cfgWith(userSection()), server({}).http);
    expect(result.warningNotes).toEqual([]);
    expect(result.infoNotes).toEqual([]);
  });

  it("only shows an info when user_status is missing", async () => {
    const result = await run(
      cfgWith(userSection()),
      server({
        capabilities: { spreed: {}, notify_push: { endpoints: { websocket: "wss://cloud.example.test/push/ws" } } },
      }).http,
    );
    expect(result.warningNotes).toEqual([]);
    expect(result.infoNotes).toEqual([expect.stringMatching(/user_status app is not enabled/)]);
  });

  it("shows infos about missing notify_push and a foreign push host", async () => {
    const missing = await run(cfgWith(userSection()), server({ capabilities: { spreed: {}, user_status: { enabled: true } } }).http);
    expect(missing.infoNotes).toEqual([expect.stringMatching(/notify_push is not available/)]);
    const foreign = await run(
      cfgWith(userSection()),
      server({
        capabilities: {
          spreed: {},
          user_status: { enabled: true },
          notify_push: { endpoints: { websocket: "wss://nextcloud.internal/push/ws" } },
        },
      }).http,
    );
    expect(foreign.infoNotes).toEqual([expect.stringMatching(/baseUrl host/)]);
  });

  it("warns about a rejected sign-in and sends no further request", async () => {
    const fake = server({ status: 401 });
    const result = await run(cfgWith(userSection()), fake.http);
    expect(result.warningNotes).toEqual([expect.stringMatching(/rejects the sign-in/)]);
    expect(fake.calls).toEqual(["/ocs/v1.php/cloud/user"]);
  });

  it("warns about brute-force throttling with an occ hint", async () => {
    const result = await run(
      cfgWith(userSection()),
      server({ status: 429, body: '{"ocs":{"meta":{"message":"Reached maximum delay"}}}' }).http,
    );
    expect(result.warningNotes).toEqual([expect.stringMatching(/occ security:bruteforce:reset/)]);
  });

  it("warns when the app password belongs to another account", async () => {
    const result = await run(cfgWith(userSection()), server({ uid: "someone" }).http);
    expect(result.warningNotes).toEqual([expect.stringMatching(/belongs to "someone"/)]);
  });

  it("warns when Talk is not available for the account", async () => {
    const result = await run(cfgWith(userSection()), server({ capabilities: { user_status: { enabled: true } } }).http);
    expect(result.warningNotes).toEqual([expect.stringMatching(/Talk is not available for "agent"/)]);
  });

  it("warns when the server is unreachable", async () => {
    const result = await run(cfgWith(userSection()), server({ throws: true }).http);
    expect(result.warningNotes).toEqual([expect.stringMatching(/not reachable: ECONNREFUSED/)]);
  });
});
