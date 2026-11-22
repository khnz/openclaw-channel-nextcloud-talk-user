import { describe, expect, it, vi } from "vitest";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { readNextcloudTalkPoll, renderNextcloudTalkPollText, toNextcloudTalkPoll, voteNextcloudTalkPoll } from "./poll.js";
import type { NextcloudTalkRawHttp } from "./receive/talk-client.js";

// Room release is covered in room-access.test.ts; this file exercises the transport only.
vi.mock("./room-access.js", () => ({ assertNextcloudTalkRoomAccess: vi.fn(async () => {}) }));

const BASE = "https://cloud.example.test";
const cfg = { channels: { "nextcloud-talk-user": { baseUrl: BASE, apiUser: "agent", apiPassword: "pw" } } };
const account = resolveNextcloudTalkAccount({ cfg });

// Shape as documented in Talk's docs/poll.md (Poll data).
const openPoll = {
  id: 2,
  question: "Pizza oder Pasta?",
  options: ["Pizza", "Pasta", "Salat"],
  votes: [],
  actorType: "users",
  actorId: "alice",
  actorDisplayName: "Alice",
  status: 0,
  resultMode: 0,
  maxVotes: 1,
  votedSelf: [],
};

function fakeServer(poll: Record<string, unknown>, voteResult?: Record<string, unknown>, status = 200) {
  const calls: { method: string; url: URL; body: string }[] = [];
  const http: NextcloudTalkRawHttp = async ({ url, init }) => {
    const method = init.method ?? "GET";
    calls.push({ method, url: new URL(url), body: typeof init.body === "string" ? init.body : "" });
    if (status !== 200) {
      return { status, headers: new Headers(), text: JSON.stringify({ ocs: { data: { error: "poll" } } }) };
    }
    const data = method === "POST" ? (voteResult ?? poll) : poll;
    return { status: method === "POST" ? 201 : 200, headers: new Headers(), text: JSON.stringify({ ocs: { data } }) };
  };
  return { http, calls };
}

describe("poll data", () => {
  it("lists options with index and option id, hides missing results and explains how to vote", () => {
    const poll = toNextcloudTalkPoll(openPoll, "room1234");
    expect(poll).toMatchObject({
      pollId: "2",
      roomToken: "room1234",
      question: "Pizza oder Pasta?",
      status: "open",
      resultMode: "public",
      maxVotes: 1,
      author: { id: "users/alice", name: "Alice" },
      votedSelf: false,
      resultsVisible: false,
      options: [
        { index: 1, optionId: "0", text: "Pizza" },
        { index: 2, optionId: "1", text: "Pasta" },
        { index: 3, optionId: "2", text: "Salat" },
      ],
    });
    expect(poll.options[0]).not.toHaveProperty("votes");
    expect(poll.notes.join(" ")).toContain("only after you have voted");
    expect(poll.notes.join(" ")).toContain("poll-vote with pollId 2 and pollOptionIndex");
  });

  it("reports votes and own choice once Talk reveals them", () => {
    const poll = toNextcloudTalkPoll(
      { ...openPoll, votes: { "option-0": 2, "option-2": 1 }, votedSelf: [0], numVoters: 3, maxVotes: 0 },
      "room1234",
    );
    expect(poll).toMatchObject({ votedSelf: true, resultsVisible: true, numVoters: 3, maxVotes: 0 });
    expect(poll.options.map((option) => option.votes)).toEqual([2, 0, 1]);
    expect(poll.options[0]?.votedBySelf).toBe(true);
    expect(poll.notes.join(" ")).toContain("pollOptionIndexes");
  });

  it("explains hidden results and lists voters of closed public polls", () => {
    expect(toNextcloudTalkPoll({ ...openPoll, resultMode: 1, votedSelf: [1] }, "r").notes[0]).toBe(
      "Results are hidden until the poll is closed.",
    );
    const closed = toNextcloudTalkPoll(
      {
        ...openPoll,
        status: 1,
        votes: { "option-1": 1 },
        numVoters: 1,
        details: [{ actorType: "users", actorId: "bob", actorDisplayName: "Bob", optionId: 1 }],
      },
      "r",
    );
    expect(closed.status).toBe("closed");
    expect(closed.options[1]).toMatchObject({ votes: 1, voters: [{ id: "users/bob", name: "Bob" }] });
    expect(closed.notes).toEqual([]);
  });

  it("renders a label line plus the full object", () => {
    const poll = toNextcloudTalkPoll(openPoll, "room1234");
    const text = renderNextcloudTalkPollText(poll);
    expect(text.split("\n")[0]).toBe("[Poll: Pizza oder Pasta?]");
    expect(JSON.parse(text.split("\n").slice(1).join("\n"))).toEqual(poll);
  });

  it("cleans control characters from untrusted texts", () => {
    const poll = toNextcloudTalkPoll({ ...openPoll, question: "Frage\n\u202e?", options: ["A\u0000"] }, "r");
    expect(poll.question).toBe("Frage ?");
    expect(poll.options[0]?.text).toBe("A");
  });
});

describe("poll actions", () => {
  it("reads a poll without side effects", async () => {
    const server = fakeServer(openPoll);
    const result = await readNextcloudTalkPoll({ cfg, account, roomToken: "room1234", pollId: "2", http: server.http });
    expect(result.poll.question).toBe("Pizza oder Pasta?");
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.method).toBe("GET");
    expect(server.calls[0]?.url.pathname).toBe("/ocs/v2.php/apps/spreed/api/v1/poll/room1234/2");
  });

  it("votes with optionIds[] and returns the updated poll", async () => {
    const server = fakeServer(openPoll, { ...openPoll, votes: { "option-1": 1 }, votedSelf: [1], numVoters: 1 });
    const result = await voteNextcloudTalkPoll({
      cfg,
      account,
      roomToken: "room1234",
      pollId: "2",
      optionIds: [1],
      http: server.http,
    });
    expect(result).toMatchObject({ ok: true, voted: ["Pasta"], poll: { votedSelf: true, resultsVisible: true } });
    const vote = server.calls.find((call) => call.method === "POST");
    expect(new URLSearchParams(vote?.body).getAll("optionIds[0]")).toEqual(["1"]);
  });

  it.each([
    [{ optionIds: [] }, "needs pollOptionIndex"],
    [{ optionIds: [3] }, "has options 1-3"],
    [{ optionIds: [0, 1] }, "at most 1 option"],
  ])("rejects invalid votes before sending %j", async (extra, message) => {
    const server = fakeServer(openPoll);
    await expect(
      voteNextcloudTalkPoll({ cfg, account, roomToken: "room1234", pollId: "2", http: server.http, ...extra }),
    ).rejects.toThrow(message);
    expect(server.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("does not vote on closed polls", async () => {
    const server = fakeServer({ ...openPoll, status: 1 });
    await expect(
      voteNextcloudTalkPoll({ cfg, account, roomToken: "room1234", pollId: "2", optionIds: [0], http: server.http }),
    ).rejects.toThrow("is closed");
  });

  it("validates ids and reports missing polls", async () => {
    const server = fakeServer(openPoll, undefined, 404);
    await expect(
      readNextcloudTalkPoll({ cfg, account, roomToken: "room1234", pollId: "abc", http: server.http }),
    ).rejects.toThrow("pollId must be");
    await expect(
      readNextcloudTalkPoll({ cfg, account, roomToken: "room1234", pollId: "9", http: server.http }),
    ).rejects.toThrow("poll not found");
  });
});
