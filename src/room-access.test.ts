import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../runtime-api.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { readNextcloudTalkHistory } from "./history.js";
import { decideNextcloudTalkRoomAccess, NextcloudTalkRoomAccessError } from "./room-access.js";
import { resolveNextcloudTalkRoomInfo, type NextcloudTalkRoomInfo } from "./room-info.js";
import { sendMessageNextcloudTalk, sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

vi.mock("../runtime-api.js", async (original) => ({
  ...(await original<typeof import("../runtime-api.js")>()),
  fetchWithSsrFGuard: vi.fn(),
}));

const pairedStore = vi.hoisted(() => ({ entries: [] as string[] }));
vi.mock("./runtime.js", async (original) => ({
  ...(await original<typeof import("./runtime.js")>()),
  getOptionalNextcloudTalkRuntime: () => ({
    channel: {
      pairing: { readAllowFromStore: async () => pairedStore.entries },
      activity: { record: () => {} },
    },
  }),
}));

afterEach(() => {
  vi.mocked(fetchWithSsrFGuard).mockReset();
  pairedStore.entries = [];
});

const BASE = "https://cloud.example.test";

function config(overrides: Record<string, unknown> = {}): CoreConfig {
  return {
    channels: {
      "nextcloud-talk-user": { baseUrl: BASE, apiUser: "agent", apiPassword: "pw", ...overrides },
    },
  } as CoreConfig;
}

async function decide(info: NextcloudTalkRoomInfo | undefined, overrides: Record<string, unknown> = {}) {
  const cfg = config(overrides);
  return await decideNextcloudTalkRoomAccess({
    cfg,
    account: resolveNextcloudTalkAccount({ cfg }),
    roomToken: "room1234",
    info,
  });
}

const group: NextcloudTalkRoomInfo = { kind: "group", type: 2 };
const direct = (peerUserId?: string): NextcloudTalkRoomInfo => ({
  kind: "direct",
  type: 1,
  ...(peerUserId ? { peerUserId } : {}),
});

describe("room access decision", () => {
  it("denies rooms whose type is unknown (fail closed)", async () => {
    await expect(decide(undefined)).resolves.toMatchObject({ allowed: false });
  });

  it("allows group rooms without a room list and denies them with groupPolicy disabled", async () => {
    await expect(decide(group, { groupPolicy: "open" })).resolves.toEqual({ allowed: true, kind: "group" });
    await expect(decide(group, { groupPolicy: "disabled" })).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("groupPolicy"),
    });
  });

  it("allows only listed group rooms and never a disabled one", async () => {
    await expect(decide(group, { rooms: { other123: {} } })).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("rooms list"),
    });
    await expect(decide(group, { rooms: { room1234: {} } })).resolves.toEqual({ allowed: true, kind: "group" });
    await expect(decide(group, { rooms: { room1234: { enabled: false } } })).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("enabled: false"),
    });
  });

  it("allows one-to-one rooms only with a participant from allowFrom", async () => {
    await expect(decide(direct("alice"), { dmPolicy: "allowlist", allowFrom: ["alice"] })).resolves.toEqual({
      allowed: true,
      kind: "direct",
    });
    await expect(decide(direct("Mallory"), { dmPolicy: "allowlist", allowFrom: ["alice"] })).resolves.toMatchObject({
      allowed: false,
    });
    await expect(decide(direct("alice"), { dmPolicy: "disabled", allowFrom: ["alice"] })).resolves.toMatchObject({
      allowed: false,
    });
    await expect(decide(direct("anyone"), { dmPolicy: "open", allowFrom: ["*"] })).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("counts approved pairings only with dmPolicy pairing", async () => {
    pairedStore.entries = ["users/bob"];
    await expect(decide(direct("bob"), { dmPolicy: "pairing" })).resolves.toMatchObject({ allowed: true });
    await expect(decide(direct("bob"), { dmPolicy: "allowlist" })).resolves.toMatchObject({ allowed: false });
  });

  it("denies note-to-self and one-to-one rooms without a known participant", async () => {
    await expect(decide({ kind: "direct", type: 6 }, { allowFrom: ["*"] })).resolves.toMatchObject({
      allowed: false,
    });
    await expect(decide(direct(), { allowFrom: ["*"] })).resolves.toMatchObject({ allowed: false });
    await expect(decide(direct("agent"), { allowFrom: ["*"] })).resolves.toMatchObject({ allowed: false });
  });
});

function mockRoom(data: Record<string, unknown>) {
  const release = vi.fn(async () => {});
  vi.mocked(fetchWithSsrFGuard).mockResolvedValueOnce({
    response: Response.json({ ocs: { data } }),
    release,
  } as never);
}

describe("room info", () => {
  it("reports the other participant of a one-to-one room", async () => {
    mockRoom({ type: 1, name: "alice" });
    const cfg = config();
    await expect(
      resolveNextcloudTalkRoomInfo({ account: resolveNextcloudTalkAccount({ cfg }), roomToken: "info0001" }),
    ).resolves.toEqual({ kind: "direct", type: 1, peerUserId: "alice" });
  });

  it("reports no participant for group rooms and note to self", async () => {
    const cfg = config();
    const account = resolveNextcloudTalkAccount({ cfg });
    mockRoom({ type: 2, name: "Team" });
    await expect(resolveNextcloudTalkRoomInfo({ account, roomToken: "info0002" })).resolves.toEqual({
      kind: "group",
      type: 2,
    });
    mockRoom({ type: 6, name: "Note to self" });
    await expect(resolveNextcloudTalkRoomInfo({ account, roomToken: "info0003" })).resolves.toEqual({
      kind: "direct",
      type: 6,
    });
  });
});

describe("agent actions in rooms that are not released", () => {
  // Each test uses its own room token: room info is cached per account and token.
  const cfg = config({ groupPolicy: "open", rooms: { released1: {} } });

  it("does not send text into an unlisted group room", async () => {
    mockRoom({ type: 2 });
    await expect(sendMessageNextcloudTalk("room:secret01", "leak", { cfg })).rejects.toBeInstanceOf(
      NextcloudTalkRoomAccessError,
    );
    // Only the room lookup went out, no chat POST.
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchWithSsrFGuard).mock.calls[0]?.[0].url).toContain("/v4/room/secret01");
  });

  it("does not react in an unlisted group room", async () => {
    mockRoom({ type: 2 });
    await expect(sendReactionNextcloudTalk("room:secret02", "42", "👍", { cfg })).rejects.toBeInstanceOf(
      NextcloudTalkRoomAccessError,
    );
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
  });

  it("does not read history of a one-to-one room with someone outside allowFrom", async () => {
    const dmCfg = config({ dmPolicy: "allowlist", allowFrom: ["alice"] });
    mockRoom({ type: 1, name: "mallory" });
    const http = vi.fn();
    await expect(
      readNextcloudTalkHistory({
        cfg: dmCfg,
        account: resolveNextcloudTalkAccount({ cfg: dmCfg }),
        http,
        query: { roomToken: "secret03" },
      }),
    ).rejects.toBeInstanceOf(NextcloudTalkRoomAccessError);
    expect(http).not.toHaveBeenCalled();
  });

  it("does not send into a room whose lookup is rejected", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValueOnce({
      response: new Response("", { status: 404 }),
      release: vi.fn(async () => {}),
    } as never);
    await expect(sendMessageNextcloudTalk("room:secret04", "leak", { cfg })).rejects.toBeInstanceOf(
      NextcloudTalkRoomAccessError,
    );
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
  });

  it("sends the pairing challenge without the room check", async () => {
    vi.mocked(fetchWithSsrFGuard).mockResolvedValueOnce({
      response: Response.json({ ocs: { data: { id: 7, timestamp: 1 } } }),
      release: vi.fn(async () => {}),
    } as never);
    await expect(
      sendMessageNextcloudTalk("room:pairing1", "code", { cfg, bypassRoomAccessForPairingChallenge: true }),
    ).resolves.toMatchObject({ messageId: "7" });
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchWithSsrFGuard).mock.calls[0]?.[0].url).toContain("/v1/chat/pairing1");
  });

  it("still sends into a released room", async () => {
    mockRoom({ type: 2 });
    vi.mocked(fetchWithSsrFGuard).mockResolvedValueOnce({
      response: Response.json({ ocs: { data: { id: 8, timestamp: 1 } } }),
      release: vi.fn(async () => {}),
    } as never);
    await expect(sendMessageNextcloudTalk("room:released1", "hi", { cfg })).resolves.toMatchObject({
      messageId: "8",
    });
    expect(vi.mocked(fetchWithSsrFGuard).mock.calls[1]?.[0].url).toContain("/v1/chat/released1");
  });
});
