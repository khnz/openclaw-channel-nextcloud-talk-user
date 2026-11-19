import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../runtime-api.js";
import { sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

vi.mock("../runtime-api.js", () => ({ fetchWithSsrFGuard: vi.fn() }));
vi.useFakeTimers({ toFake: ["setTimeout"] });

afterEach(() => {
  vi.mocked(fetchWithSsrFGuard).mockReset();
});

const cfg: CoreConfig = {
  channels: {
    "nextcloud-talk-user": {
      baseUrl: "https://cloud.example.test",
      apiUser: "agent",
      apiPassword: "app-password",
    },
  },
};

type Call = { method: string; url: string; body?: string };

/** Responses in order; beforeRequest is called like with the real guard. */
function scripted(steps: (Response | Error | ((call: Call) => Response))[]) {
  const calls: Call[] = [];
  vi.mocked(fetchWithSsrFGuard).mockImplementation(async (params) => {
    params.beforeRequest?.();
    const call = {
      method: String(params.init?.method),
      url: params.url,
      body: typeof params.init?.body === "string" ? params.init.body : undefined,
    };
    calls.push(call);
    const step = steps.shift();
    if (!step) {
      throw new Error("unexpected request");
    }
    if (step instanceof Error) {
      throw step;
    }
    const response = typeof step === "function" ? step(call) : step;
    return { response, release: async () => {}, finalUrl: params.url };
  });
  return calls;
}

const created = (id: number) =>
  new Response(JSON.stringify({ ocs: { data: { id, timestamp: 1_700_000_000 } } }), { status: 201 });
const history = (entries: Record<string, unknown>[]) =>
  new Response(JSON.stringify({ ocs: { data: entries } }), { status: 200 });

async function send(opts: Partial<Parameters<typeof sendMessageNextcloudTalk>[2]> = {}) {
  const promise = sendMessageNextcloudTalk("room:abc", "Hello", { cfg, referenceId: "ref-1", ...opts });
  // Mark the rejection as handled right away; the returned promise is what gets checked.
  promise.catch(() => undefined);
  await vi.runAllTimersAsync();
  return promise;
}

describe("sending with retry and referenceId check", () => {
  it("sends exactly once on success", async () => {
    const calls = scripted([created(10)]);
    await expect(send()).resolves.toMatchObject({ messageId: "10", referenceId: "ref-1" });
    expect(calls).toHaveLength(1);
  });

  it("detects the already delivered message after a timeout and does not send again", async () => {
    const calls = scripted([
      new Error("timeout"),
      history([{ id: 11, referenceId: "ref-1", actorType: "users", actorId: "agent" }]),
    ]);
    await expect(send()).resolves.toMatchObject({ messageId: "11" });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(calls[1]?.url).toContain("setReadMarker=0");
  });

  it("retries exactly once with the same referenceId when the message is missing", async () => {
    const calls = scripted([new Error("timeout"), history([]), created(12)]);
    await expect(send()).resolves.toMatchObject({ messageId: "12" });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "POST"]);
    expect(new URLSearchParams(calls[2]?.body).get("referenceId")).toBe("ref-1");
  });

  it("treats 5xx like a timeout", async () => {
    const calls = scripted([new Response("", { status: 502 }), history([]), created(13)]);
    await expect(send()).resolves.toMatchObject({ messageId: "13" });
    expect(calls).toHaveLength(3);
  });

  it("ignores foreign messages with the same referenceId", async () => {
    scripted([
      new Error("timeout"),
      history([{ id: 14, referenceId: "ref-1", actorType: "users", actorId: "someone-else" }]),
      created(15),
    ]);
    await expect(send()).resolves.toMatchObject({ messageId: "15" });
  });

  it("gives up after two unclear attempts", async () => {
    const calls = scripted([new Error("timeout"), history([]), new Error("timeout"), history([])]);
    await expect(send()).rejects.toThrow("timeout");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("does not retry when the check itself fails", async () => {
    const calls = scripted([new Error("timeout"), new Response("", { status: 500 })]);
    await expect(send()).rejects.toThrow("timeout");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it.each([400, 401, 403, 404, 413, 429])("never retries %i", async (status) => {
    const calls = scripted([new Response("", { status })]);
    await expect(send()).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("does not retry when the handoff is rejected before the request", async () => {
    const calls = scripted([created(16)]);
    await expect(
      send({
        assertDirectAdapterHandoff: () => {
          throw new Error("handoff not authorized");
        },
      }),
    ).rejects.toThrow("handoff not authorized");
    expect(calls).toHaveLength(0);
  });

  it("sends threadId when given", async () => {
    const calls = scripted([created(17)]);
    await send({ threadId: "1541" });
    expect(new URLSearchParams(calls[0]?.body).get("threadId")).toBe("1541");
  });
});
