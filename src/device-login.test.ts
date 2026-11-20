import { describe, expect, it, vi } from "vitest";
import { resolveNextcloudTalkDeviceName, type NextcloudTalkHttpRequest } from "./device-login.js";
import { setNextcloudTalkAccountConfig } from "./setup-core.js";
import { runNextcloudTalkDeviceLoginStep, type NextcloudTalkDeviceLoginPrompter } from "./setup-device-login.js";
import type { CoreConfig } from "./types.js";

const BASE = "https://cloud.example.test";
const APP_PW = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";

type Call = Parameters<NextcloudTalkHttpRequest>[0];

/** Fake Nextcloud server for Login Flow v2 and credential checks. */
function fakeNextcloud(options: {
  pollPendingRounds?: number;
  grantedLoginName?: string;
  uidFor?: (auth: string) => string | undefined;
  appPasswords?: Set<string>;
  pollEndpoint?: string;
  loginUrl?: string;
}) {
  const calls: Call[] = [];
  let polls = 0;
  const appPasswords = options.appPasswords ?? new Set([APP_PW]);
  const decode = (headers?: Record<string, string>) => {
    const raw = headers?.Authorization?.replace(/^Basic /, "") ?? "";
    const [user, ...rest] = Buffer.from(raw, "base64").toString().split(":");
    return { user: user ?? "", password: rest.join(":") };
  };
  const request: NextcloudTalkHttpRequest = async (call) => {
    calls.push(call);
    const path = new URL(call.url).pathname;
    if (path === "/index.php/login/v2") {
      return {
        status: 200,
        text: JSON.stringify({
          poll: { token: "poll-token", endpoint: options.pollEndpoint ?? `${BASE}/login/v2/poll` },
          login: options.loginUrl ?? `${BASE}/login/v2/flow/flow-token`,
        }),
      };
    }
    if (path === "/login/v2/poll") {
      polls += 1;
      if (polls <= (options.pollPendingRounds ?? 1)) {
        return { status: 404, text: "[]" };
      }
      return {
        status: 200,
        text: JSON.stringify({
          server: BASE,
          loginName: options.grantedLoginName ?? "agent",
          appPassword: APP_PW,
        }),
      };
    }
    const { user, password } = decode(call.headers);
    if (path === "/ocs/v1.php/cloud/user") {
      const uid = options.uidFor?.(`${user}:${password}`) ?? (password ? user : undefined);
      if (!uid || password === "wrong") {
        return { status: 401, text: "" };
      }
      return { status: 200, text: JSON.stringify({ ocs: { data: { id: uid } } }) };
    }
    if (path === "/ocs/v2.php/core/getapppassword") {
      return appPasswords.has(password)
        ? { status: 403, text: "" }
        : {
            status: 200,
            text: JSON.stringify({ ocs: { data: { apppassword: "CONVERTED-APP-PASSWORD" } } }),
          };
    }
    if (path === "/ocs/v2.php/core/apppassword" && call.method === "DELETE") {
      return { status: 200, text: "{}" };
    }
    return { status: 500, text: "" };
  };
  return { request, calls };
}

function prompter(typed: string, confirms: boolean[] = []): NextcloudTalkDeviceLoginPrompter & {
  notes: string[];
} {
  const notes: string[] = [];
  return {
    notes,
    note: async (message) => {
      notes.push(message);
    },
    text: async () => typed,
    confirm: async () => confirms.shift() ?? false,
    progress: () => ({ stop: () => {} }),
  };
}

const cfg = (account: Record<string, unknown> = {}): CoreConfig => ({
  channels: { "nextcloud-talk-user": { baseUrl: BASE, apiUser: "agent", ...account } },
});

const run = (
  config: CoreConfig,
  p: NextcloudTalkDeviceLoginPrompter,
  request: NextcloudTalkHttpRequest,
) =>
  runNextcloudTalkDeviceLoginStep({
    cfg: config,
    accountId: "default",
    prompter: p,
    applyPatch: setNextcloudTalkAccountConfig,
    request,
    pollIntervalMs: 1,
  });

const talk = (config: CoreConfig) => config.channels?.["nextcloud-talk-user"];

describe("device login in the setup wizard", () => {
  it("fetches the app password after access is granted via the link and stores it", async () => {
    const server = fakeNextcloud({ pollPendingRounds: 2 });
    const p = prompter("");
    const next = await run(cfg(), p, server.request);

    expect(talk(next)?.apiPassword).toBe(APP_PW);
    expect(p.notes.join("\n")).toContain(`${BASE}/login/v2/flow/flow-token`);
    expect(p.notes.join("\n")).toContain("User:   agent");
    expect(p.notes.join("\n")).not.toContain(APP_PW);
  });

  it("accepts an entered app password without waiting for the grant", async () => {
    const server = fakeNextcloud({ pollPendingRounds: 1_000_000 });
    const next = await run(cfg(), prompter(APP_PW), server.request);

    expect(talk(next)?.apiPassword).toBe(APP_PW);
  });

  it("converts an entered account password into a dedicated app password", async () => {
    const server = fakeNextcloud({ pollPendingRounds: 1_000_000 });
    const next = await run(cfg(), prompter("account-password"), server.request);

    expect(talk(next)?.apiPassword).toBe("CONVERTED-APP-PASSWORD");
  });

  it("discards and revokes the device on a wrong identity", async () => {
    const server = fakeNextcloud({ grantedLoginName: "someone-else" });
    const config = cfg();

    await expect(run(config, prompter(""), server.request)).rejects.toThrow(/"agent" was expected/);
    expect(talk(config)?.apiPassword).toBeUndefined();
    expect(
      server.calls.some(
        (call) => call.method === "DELETE" && call.url.includes("/ocs/v2.php/core/apppassword"),
      ),
    ).toBe(true);
  });

  it("checks rejected credentials exactly once and does not retry", async () => {
    const server = fakeNextcloud({ pollPendingRounds: 1_000_000 });

    await expect(run(cfg(), prompter("wrong"), server.request)).rejects.toThrow(/rejected the sign-in/);
    expect(server.calls.filter((call) => call.url.includes("/cloud/user"))).toHaveLength(1);
  });

  it("uses a configured device name instead of the default", async () => {
    const server = fakeNextcloud({ pollPendingRounds: 0 });
    const p = prompter("");
    await run(cfg({ apiUser: "agent", deviceName: "  openclaw test device " }), p, server.request);

    expect(p.notes.join("\n")).toContain("Device: openclaw test device");
    expect(resolveNextcloudTalkDeviceName("   ")).toBe("openclaw nextcloud-talk-plugin");
  });

  it("signs in with the configured account and names the device after the plugin", async () => {
    const server = fakeNextcloud({ pollPendingRounds: 0 });
    const p = prompter("");
    await run(cfg({ apiUser: "agent" }), p, server.request);

    expect(p.notes.join("\n")).toContain("Device: openclaw nextcloud-talk-plugin");
  });

  it("aborts when the poll endpoint is on another server", async () => {
    const server = fakeNextcloud({ pollEndpoint: "https://evil.example.test/login/v2/poll" });

    await expect(run(cfg(), prompter(""), server.request)).rejects.toThrow(/different server/);
  });

  it("rejects a login link without HTTPS for an HTTPS server", async () => {
    const server = fakeNextcloud({ loginUrl: "http://cloud.example.test/login/v2/flow/flow-token" });
    await expect(run(cfg(), prompter(""), server.request)).rejects.toThrow(/without HTTPS/);
    // Nothing beyond starting the flow: no poll, no credentials sent.
    expect(server.calls).toHaveLength(1);
  });

  it("warns about an HTTP server URL and still signs in", async () => {
    const http = "http://cloud.example.test";
    const server = fakeNextcloud({
      pollEndpoint: `${http}/login/v2/poll`,
      loginUrl: `${http}/login/v2/flow/flow-token`,
    });
    const p = prompter(APP_PW);
    const next = await run(cfg({ baseUrl: http }), p, server.request);
    expect(talk(next)?.apiPassword).toBe(APP_PW);
    expect(p.notes.join("\n")).toContain("HTTP without encryption");
  });

  it("does not warn about an HTTPS server URL", async () => {
    const p = prompter(APP_PW);
    await run(cfg(), p, fakeNextcloud({}).request);
    expect(p.notes.join("\n")).not.toContain("without encryption");
  });

  it("asks when a password exists and leaves it unchanged without confirmation", async () => {
    const request = vi.fn<NextcloudTalkHttpRequest>();
    const config = cfg({ apiPassword: "existing" });

    const next = await run(config, prompter("", [false]), request);

    expect(talk(next)?.apiPassword).toBe("existing");
    expect(request).not.toHaveBeenCalled();
  });
});
