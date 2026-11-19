import { writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import type { ChannelMessageSendMediaContext } from "openclaw/plugin-sdk/channel-outbound";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nextcloudTalkPlugin } from "../channel-plugin-api.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import {
  chatFile,
  fileMessage,
  respondOcs,
  type NextcloudTalkOutboundFixture,
  withNextcloudTalkOutboundFixture as withTalk,
} from "./outbound-media.test-harness.js";
import { sendMessageNextcloudTalk, sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

const transport = vi.hoisted(() => ({
  beforeLookup: undefined as ((url: string) => Promise<void> | void) | undefined,
}));
vi.mock("../runtime-api.js", async (original) => {
  const actual = await original<typeof import("../runtime-api.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...params,
        lookupFn: async () => {
          await transport.beforeLookup?.(params.url);
          return [{ address: "127.0.0.1", family: 4 }];
        },
      }),
  };
});

let clock = 1_800_000_000_000;
beforeEach(() => {
  clock += 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => {
  transport.beforeLookup = undefined;
  vi.restoreAllMocks();
});

const send = (ctx: ChannelMessageSendMediaContext) =>
  nextcloudTalkPlugin.message!.send!.media!(ctx);

function noUserCredentialsConfig(ctx: ChannelMessageSendMediaContext) {
  const cfg = structuredClone(ctx.cfg) as CoreConfig;
  const account = cfg.channels?.["nextcloud-talk-user"]?.accounts?.work;
  if (!account) {
    throw new Error("expected work fixture account");
  }
  delete account.apiUser;
  delete account.apiPassword;
  delete account.apiPasswordFile;
  return cfg;
}

function expectUserRequest(
  fixture: NextcloudTalkOutboundFixture,
  path: string,
  form: Record<string, string>,
) {
  expect(fixture.requests).toHaveLength(1);
  const request = fixture.requests[0]!;
  expect(request).toMatchObject({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "ocs-apirequest": "true" },
  });
  expect(request.url.pathname).toBe(`/cloud/ocs/v2.php/apps/spreed/api/${path}`);
  expect(Object.fromEntries(new URLSearchParams(request.body.toString()))).toMatchObject(form);
  // Signs in as the configured user with the app password (Basic auth).
  expect(request.authorization).toBe(
    `Basic ${Buffer.from("login-alias:synthetic-app-password").toString("base64")}`,
  );
}

it.each([
  ["configured_unavailable", /app password is configured but unavailable.*"work"/i],
  ["missing", /user credentials missing.*"work"/i],
] as const)("distinguishes %s credentials before sending", async (status, error) => {
  await withTalk(async (fixture) => {
    const cfg = structuredClone(fixture.ctx.cfg) as typeof fixture.ctx.cfg;
    const account = cfg.channels!["nextcloud-talk-user"]!.accounts!.work!;
    delete account.apiPassword;
    if (status === "configured_unavailable") {
      account.apiPasswordFile = path.join(fixture.directory, "missing-app-password");
    }
    await expect(
      sendMessageNextcloudTalk("room:abc123", "hello", { cfg, accountId: "work" }),
    ).rejects.toThrow(error);
    expect(fixture.requests).toEqual([]);
  });
});

it("sends unchanged authored text as the configured user", async () => {
  await withTalk(async (fixture) => {
    const text = "Example:\n⚠️ 🛠️ `search repos (agent)` failed";
    fixture.respond = (_, response) => {
      respondOcs(response, { id: 456, timestamp: 1_706_000_000 });
      return true;
    };
    await expect(
      sendMessageNextcloudTalk("room:abc123", text, { cfg: fixture.ctx.cfg, accountId: "work" }),
    ).resolves.toMatchObject({ messageId: "456", timestamp: 1_706_000_000 });
    expectUserRequest(fixture, "v1/chat/abc123", { message: text });
    expect(new URLSearchParams(fixture.requests[0]!.body.toString()).get("referenceId")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

it("explains that a 401 means the app password was rejected and does not retry", async () => {
  await withTalk(async (fixture) => {
    fixture.respond = (_, response) => {
      response.writeHead(401);
      response.end("{}");
      return true;
    };
    await expect(
      sendMessageNextcloudTalk("room:abc123", "hello", { cfg: fixture.ctx.cfg, accountId: "work" }),
    ).rejects.toThrow(/app password may be revoked/);
    expect(fixture.requests).toHaveLength(1);
  });
});

it("uses provided cfg and posts the reaction as the configured user", async () => {
  await withTalk(async (fixture) => {
    await sendReactionNextcloudTalk("room:ops", "m-1", "👍", {
      cfg: fixture.ctx.cfg,
      accountId: "work",
    });
    expectUserRequest(fixture, "v1/reaction/ops/m-1", { reaction: "👍" });
  });
});

it.each(["The report", ""])("delivers a real file share with caption %j", async (text) => {
  await withTalk(async ({ ctx, requests, bytes }) => {
    const result = await send({ ...ctx, text });
    const upload = requests.find(({ method }) => method === "PUT");
    expect(upload?.body).toEqual(bytes);
    expect(upload?.url.pathname).toMatch(/^\/cloud\/remote.php\/dav\/files\/canonical-user\//);
    expect(
      requests.every(
        ({ authorization }) =>
          authorization ===
          `Basic ${Buffer.from("login-alias:synthetic-app-password").toString("base64")}`,
      ),
    ).toBe(true);
    const shareRequest = requests.find(({ url }) => url.pathname.endsWith("/shares"));
    const share = new URLSearchParams(shareRequest?.body.toString());
    expect(share.get("shareType")).toBe("10");
    expect(share.get("shareWith")).toBe("allowed");
    expect(JSON.parse(share.get("talkMetaData") ?? "{}")).toEqual({ caption: text, replyTo: 41 });
    expect(share.get("permissions")).toBe("1");
    expect(requests.some(({ url }) => url.pathname.includes("/bot/"))).toBe(false);
    expect(result).toMatchObject({
      messageId: "42",
      receipt: { platformMessageIds: ["42"], replyToId: "41" },
    });
    const history = requests.find(({ url }) => url.pathname.includes("/chat/"))!.url;
    expect(history.searchParams.get("setReadMarker")).toBe("0");
    expect(history.searchParams.get("noStatusUpdate")).toBe("1");
    expect(history.searchParams.get("markNotificationsAsRead")).toBe("0");
  });
});

it.each([
  { filename: "reply.mp3", audioAsVoice: true, voice: true },
  { filename: "reply.wav", audioAsVoice: true, voice: true },
  { filename: "reply.mp3", audioAsVoice: undefined, voice: false },
  { filename: "reply.ogg", audioAsVoice: true, voice: false },
  { filename: "report.pdf", audioAsVoice: true, voice: false },
])("delivers $filename with audioAsVoice=$audioAsVoice as voice=$voice", async (row) => {
  await withTalk(async ({ ctx, directory, requests, bytes: pdf }) => {
    const bytes = row.filename.endsWith(".wav")
      ? Buffer.concat([
          Buffer.from("RIFF"),
          Buffer.alloc(4),
          Buffer.from("WAVEfmt "),
          Buffer.alloc(48),
        ])
      : row.filename.endsWith(".ogg")
        ? Buffer.concat([
            Buffer.from("OggS"),
            Buffer.alloc(24),
            Buffer.from("OpusHead"),
            Buffer.alloc(32),
          ])
        : row.filename.endsWith(".mp3")
          ? Buffer.concat([Buffer.from("ID3"), Buffer.alloc(61)])
          : pdf;
    const mediaUrl = path.join(directory, row.filename);
    await writeFile(mediaUrl, bytes);
    const result = await send({ ...ctx, mediaUrl, audioAsVoice: row.audioAsVoice });
    const shareRequest = requests.find(({ url }) => url.pathname.endsWith("/shares"));
    const share = new URLSearchParams(shareRequest?.body.toString());
    expect(JSON.parse(share.get("talkMetaData") ?? "{}")).toEqual({
      caption: "The report",
      replyTo: 41,
      ...(row.voice ? { messageType: "voice-message" } : {}),
    });
    expect(requests.find(({ method }) => method === "PUT")?.body).toEqual(bytes);
    expect(result.receipt.parts).toMatchObject([
      { platformMessageId: "42", kind: row.voice ? "voice" : "media" },
    ]);
    expect(result.receipt.replyToId).toBe("41");
  });
});

it("requires user credentials for a voice request instead of sending a link", async () => {
  await withTalk(async ({ ctx, requests }) => {
    await expect(
      send({
        ...ctx,
        cfg: noUserCredentialsConfig(ctx),
        mediaUrl: "https://example.com/reply.mp3",
        audioAsVoice: true,
      }),
    ).rejects.toThrow(/apiUser.*apiPassword/u);
    expect(requests).toEqual([]);
  });
});

it("requires API credentials before reading or uploading the attachment", async () => {
  await withTalk(async ({ ctx, requests }) => {
    const cfg = {
      channels: {
        "nextcloud-talk-user": { baseUrl: "https://cloud.invalid", botSecret: "synthetic-bot-secret" },
      },
    };
    const mediaReadFile = vi.fn(async () => Buffer.from("not read"));
    await expect(send({ ...ctx, cfg, accountId: undefined, mediaReadFile })).rejects.toThrow(
      /apiUser.*apiPassword/,
    );
    expect(mediaReadFile).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});

it.each([
  "/private/report.pdf",
  "file:///private/report.pdf",
  "report.pdf",
  "data:text/plain,private",
  "https://user:password@example.com/report.pdf",
])("does not send any attachment %s without user credentials", async (mediaUrl) => {
  await withTalk(async ({ ctx, requests }) => {
    await expect(send({ ...ctx, cfg: noUserCredentialsConfig(ctx), mediaUrl })).rejects.toThrow(
      /apiUser.*apiPassword/u,
    );
    expect(requests).toEqual([]);
  });
});

it.each([
  { apiUser: "configured-user" },
  { apiPassword: "configured-password" },
  { apiUser: "configured-user", apiPasswordFile: "/missing/synthetic-app-password" },
])(
  "does not silently fall back for incomplete or unavailable API configuration %j",
  async (apiConfig) => {
    await withTalk(async ({ ctx, requests }) => {
      const cfg = noUserCredentialsConfig(ctx);
      Object.assign(cfg.channels!["nextcloud-talk-user"]!.accounts!.work!, apiConfig);
      await expect(
        send({ ...ctx, cfg, mediaUrl: "https://example.com/report.pdf" }),
      ).rejects.toThrow(/apiUser.*apiPassword/u);
      expect(requests).toEqual([]);
    });
  },
);

it("does not upload files outside the approved media roots", async () => {
  await withTalk(async ({ ctx, requests }) => {
    await expect(send({ ...ctx, mediaLocalRoots: [] })).rejects.toThrow();
    expect(requests.some(({ method }) => method === "PUT" || method === "MKCOL")).toBe(false);
  });
});

it("cleans an unshared upload when custody is revoked before publication", async () => {
  await withTalk(async ({ ctx, requests }) => {
    let current = true;
    transport.beforeLookup = (url) => {
      if (url.includes("/files_sharing/")) {
        current = false;
      }
    };
    await expect(
      send({
        ...ctx,
        onPlatformSendDispatch: async () => {},
        assertDirectAdapterHandoff: () => {
          if (!current) {
            throw new Error("custody revoked");
          }
        },
      }),
    ).rejects.toThrow("custody revoked");
    expect(requests.some(({ method }) => method === "PUT")).toBe(true);
    expect(requests.some(({ method }) => method === "DELETE")).toBe(true);
    expect(requests.some(({ url }) => url.pathname.endsWith("/shares"))).toBe(false);
  });
});

it("never follows an authenticated redirect", async () => {
  await withTalk(async (fixture) => {
    fixture.respond = (_, response) => {
      response.writeHead(302, { location: "/credential-leak" });
      response.end();
      return true;
    };
    await expect(send(fixture.ctx)).rejects.toThrow();
    expect(fixture.requests).toHaveLength(1);
  });
});

it.each([
  { status: 401, recovery: /apiUser.*app password.*before retrying/u },
  { status: 507, recovery: /Files storage.*quota.*before retrying/u },
  { status: 403, recovery: /Nextcloud server logs.*write access/u },
  { status: 500, recovery: /Nextcloud server logs.*write access/u },
])(
  "explains recovery without sharing after a rejected upload ($status)",
  async ({ status, recovery }) => {
    await withTalk(async (fixture) => {
      fixture.respond = (request, response) => {
        if (request.method !== "PUT") {
          return false;
        }
        response.writeHead(status);
        response.end("private server diagnostics must not reach the error message");
        return true;
      };
      const error = await send(fixture.ctx).then(
        () => {
          throw new Error("rejected upload unexpectedly succeeded");
        },
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`upload failed (${status})`);
      expect((error as Error).message).toMatch(recovery);
      expect((error as Error).message).not.toContain("private server diagnostics");
      expect(fixture.requests.some(({ url }) => url.pathname.endsWith("/shares"))).toBe(false);
      expect(fixture.requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
    });
  },
);

it("preserves the upload and reports uncertainty when no chat receipt is available", async () => {
  await withTalk(async (fixture) => {
    fixture.respond = (request, response) => {
      if (!request.url.pathname.includes("/chat/")) {
        return false;
      }
      respondOcs(response, []);
      return true;
    };
    await expect(send(fixture.ctx)).rejects.toThrow(/not confirmed|unknown/i);
    expect(fixture.requests.filter(({ url }) => url.pathname.endsWith("/shares"))).toHaveLength(1);
    expect(fixture.requests.some(({ method }) => method === "DELETE")).toBe(false);
  });
});

it.each([403, 500, "lost-ack"] as const)(
  "reconciles a published share despite %s without retrying",
  async (status) => {
    await withTalk(async (fixture) => {
      let referenceId = "";
      fixture.respond = (request, response) => {
        if (request.url.pathname.endsWith("/shares")) {
          referenceId = new URLSearchParams(request.body.toString()).get("referenceId") ?? "";
          if (status === "lost-ack") {
            response.destroy();
          } else {
            response.writeHead(status);
            response.end();
          }
          return true;
        }
        if (request.url.pathname.includes("/chat/")) {
          respondOcs(response, [chatFile(referenceId)]);
          return true;
        }
        return false;
      };
      await expect(send(fixture.ctx)).resolves.toMatchObject({ messageId: "42" });
      expect(fixture.requests.filter(({ url }) => url.pathname.endsWith("/shares"))).toHaveLength(
        1,
      );
      expect(fixture.requests.some(({ method }) => method === "DELETE")).toBe(false);
    });
  },
);

it("rejects oversize attachments before writing Nextcloud storage", async () => {
  await withTalk(async ({ ctx, requests }) => {
    const cfg = structuredClone(ctx.cfg) as CoreConfig;
    cfg.channels!["nextcloud-talk-user"]!.accounts!.work!.mediaMaxMb = 0.000001;
    await expect(send({ ...ctx, cfg })).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});

it("recognizes exact own echoes before acknowledgment and after the cache expires", async () => {
  await withTalk(async (fixture) => {
    const { isNextcloudTalkOutboundFileEcho } = await import("./outbound-media.js");
    const account = resolveNextcloudTalkAccount({
      cfg: fixture.ctx.cfg as CoreConfig,
      accountId: "work",
    });
    let echo: NextcloudTalkInboundMessage;
    let earlyEcho: Promise<boolean> | undefined;
    fixture.respond = (request) => {
      if (!request.url.pathname.endsWith("/shares")) {
        return false;
      }
      const filePath = new URLSearchParams(request.body.toString()).get("path")!;
      echo = fileMessage(fixture);
      echo.attachment!.name = filePath.split("/").at(-1)!;
      earlyEcho = isNextcloudTalkOutboundFileEcho({ account, message: echo });
      return false;
    };
    await send(fixture.ctx);
    expect(await earlyEcho).toBe(true);
    const controller = new AbortController();
    controller.abort(new Error("echo lookup cancelled"));
    await expect(
      isNextcloudTalkOutboundFileEcho({ account, message: echo!, signal: controller.signal }),
    ).rejects.toThrow("echo lookup cancelled");
    const before = fixture.requests.length;
    clock += 31_000;
    await expect(isNextcloudTalkOutboundFileEcho({ account, message: echo! })).resolves.toBe(true);
    expect(fixture.requests.slice(before).map(({ url }) => url.pathname)).toEqual([
      "/cloud/ocs/v1.php/cloud/user",
      "/cloud/ocs/v2.php/apps/spreed/api/v1/chat/allowed",
    ]);
    await expect(
      isNextcloudTalkOutboundFileEcho({
        account,
        message: { ...echo!, senderId: "users/another-user" },
      }),
    ).resolves.toBe(false);
    await expect(
      isNextcloudTalkOutboundFileEcho({ account, message: { ...echo!, roomToken: "other-room" } }),
    ).resolves.toBe(false);
    await expect(
      isNextcloudTalkOutboundFileEcho({
        account,
        message: { ...echo!, attachment: { ...echo!.attachment!, fileId: "82" } },
      }),
    ).resolves.toBe(false);
    fixture.respond = (request, response) => {
      if (!request.url.pathname.includes("/chat/")) {
        return false;
      }
      respondOcs(response, [chatFile("unrelated-user-post")]);
      return true;
    };
    await expect(isNextcloudTalkOutboundFileEcho({ account, message: echo! })).resolves.toBe(false);
  });
});

it.each([
  { failure: "lost-ack", preexisting: false },
  { failure: "cancelled", preexisting: false },
  { failure: "identity-failure", preexisting: false },
  { failure: "412", preexisting: true },
])(
  "settles create-only upload after $failure (preexisting=$preexisting)",
  async ({ failure, preexisting }) => {
    await withTalk(async (fixture) => {
      const controller = new AbortController();
      const existing = Buffer.from("pre-existing unrelated file");
      const files = new Map<string, Buffer>();
      fixture.respond = (request, response) => {
        const pathname = request.url.pathname;
        if (request.method === "PUT") {
          expect(request.ifNoneMatch).toBe("*");
          files.set(pathname, preexisting ? existing : request.body);
          if (failure === "cancelled") {
            controller.abort(new Error("upload cancelled after commit"));
          }
          if (failure !== "identity-failure" && failure !== "412") {
            response.destroy();
            return true;
          }
          response.writeHead(failure === "412" ? 412 : 201);
        } else if (request.method === "PROPFIND" && !preexisting) {
          response.writeHead(500);
        } else if (request.method === "DELETE") {
          for (const key of files.keys()) {
            if (key === pathname || key.startsWith(pathname + "/")) {
              files.delete(key);
            }
          }
          response.writeHead(204);
        } else {
          return false;
        }
        response.end();
        return true;
      };
      const pending = expect(send({ ...fixture.ctx, signal: controller.signal })).rejects;
      if (failure === "412") {
        await pending.toThrow(/upload failed \(412\)/u);
      } else {
        await pending.toThrow();
      }
      expect([...files.values()]).toEqual(preexisting ? [existing] : []);
      expect(fixture.requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
      expect(fixture.requests.filter(({ method }) => method === "DELETE")).toHaveLength(
        preexisting ? 0 : 1,
      );
      expect(fixture.requests.some(({ url }) => url.pathname.endsWith("/shares"))).toBe(false);
    });
  },
);

it.each([
  { name: "界".repeat(70) + ".pdf", suffix: ".pdf", stem: "界".repeat(66) },
  { name: "😀".repeat(55) + ".png", suffix: ".png", stem: "😀".repeat(50) },
  { name: "a".repeat(190) + ".pdf", suffix: ".pdf", stem: "a".repeat(190) },
  { name: "界." + "語".repeat(70), suffix: "." + "語".repeat(66), stem: "界" },
])(
  "fits the complete UTF-8 upload component while preserving the extension: $name",
  async ({ name, suffix, stem }) => {
    await withTalk(async (fixture) => {
      const mediaUrl = path.join(fixture.directory, name);
      await writeFile(mediaUrl, fixture.bytes);
      fixture.respond = (request, response) => {
        if (request.method !== "PUT") {
          return false;
        }
        const component = decodeURIComponent(request.url.pathname.split("/").at(-1)!);
        // Model the server's complete-component byte limit, not JS string length.
        if (Buffer.byteLength(component) > 250) {
          response.writeHead(400);
          response.end();
          return true;
        }
        return false;
      };
      await expect(send({ ...fixture.ctx, mediaUrl })).resolves.toMatchObject({ messageId: "42" });
      const upload = fixture.requests.find(({ method }) => method === "PUT")!;
      const component = decodeURIComponent(upload.url.pathname.split("/").at(-1)!);
      expect(Buffer.byteLength(component)).toBeLessThanOrEqual(250);
      expect(component).toMatch(/^openclaw-[0-9a-f-]{36}-/u);
      expect(component.slice(46)).toBe(stem + suffix);
    });
  },
);

it.each(["user", "history"] as const)(
  "does not suppress a human file when %s lookup fails",
  async (failure) => {
    await withTalk(async (fixture) => {
      const { isNextcloudTalkOutboundFileEcho } = await import("./outbound-media.js");
      const account = resolveNextcloudTalkAccount({
        cfg: fixture.ctx.cfg as CoreConfig,
        accountId: "work",
      });
      fixture.respond = (request, response) => {
        if (
          (failure === "user" && request.url.pathname.endsWith("/cloud/user")) ||
          (failure === "history" && request.url.pathname.includes("/chat/"))
        ) {
          response.writeHead(503);
          response.end();
          return true;
        }
        return false;
      };
      const message = fileMessage(fixture, {
        messageId: "43",
        senderName: "Human",
        text: "Shared report",
      });
      message.attachment!.fileId = "83";
      message.attachment!.shareUrl = "";
      await expect(isNextcloudTalkOutboundFileEcho({ account, message })).resolves.toBe(false);
    });
  },
);

it("preserves pre-existing data when the create-only rejection response is lost", async () => {
  await withTalk(async (fixture) => {
    const existing = Buffer.from("pre-existing unrelated file");
    const files = new Map<string, Buffer>();
    fixture.respond = (request, response) => {
      if (request.method === "MKCOL" && !request.url.pathname.endsWith("/OpenClaw")) {
        // A pre-existing child implies its parent collection already exists.
        files.set(request.url.pathname + "/existing.pdf", existing);
        response.writeHead(405);
        response.end();
        return true;
      }
      if (request.method === "PUT") {
        files.set(request.url.pathname, existing);
        // The server rejected this create-only PUT with 412, but no ack arrives.
        response.destroy();
        return true;
      }
      if (request.method === "DELETE") {
        for (const key of files.keys()) {
          if (key === request.url.pathname || key.startsWith(request.url.pathname + "/")) {
            files.delete(key);
          }
        }
        response.writeHead(204);
        response.end();
        return true;
      }
      return false;
    };
    await expect(send(fixture.ctx)).rejects.toThrow();
    expect([...files.values()]).toEqual([existing]);
    expect(fixture.requests.some(({ method }) => method === "DELETE")).toBe(false);
  });
});

const sendText = expectDefined(nextcloudTalkPlugin.message?.send?.text, "text sender");
const MESSAGE_PATH = "/cloud/ocs/v2.php/apps/spreed/api/v1/chat/allowed";
const sentForm = (request: RecordedRequest) => {
  const form = Object.fromEntries(new URLSearchParams(request.body));
  delete form.referenceId;
  return form;
};

type RecordedRequest = { method?: string; url?: string; body: string };
async function withTalkServer(
  run: (ctx: NextcloudTalkOutboundFixture["ctx"], requests: RecordedRequest[]) => Promise<void>,
  respond: (response: ServerResponse, requests: RecordedRequest[]) => void = (response) =>
    acceptMessage(response),
) {
  const requests: RecordedRequest[] = [];
  await withTalk(async (fixture) => {
    fixture.respond = (request, response) => {
      requests.push({
        method: request.method,
        url: request.url.pathname,
        body: request.body.toString(),
      });
      respond(response, requests);
      return true;
    };
    await run(
      {
        ...fixture.ctx,
        text: "hello",
        replyToId: "41",
      },
      requests,
    );
  });
  return requests;
}

function createGate() {
  const started = createDeferred<void>();
  const resume = createDeferred<void>();
  return {
    async block() {
      started.resolve();
      await resume.promise;
    },
    async during(pending: Promise<unknown>, check: () => void | Promise<void>) {
      const result = pending.catch((error: unknown) => error);
      try {
        expect(
          await Promise.race([started.promise.then(() => true), result.then(() => false)]),
        ).toBe(true);
        await check();
      } finally {
        resume.resolve();
        await result;
      }
      return result;
    },
  };
}

function createHandoff() {
  const controller = new AbortController();
  const error = new Error("Nextcloud delivery cancelled");
  return {
    error,
    cancel: () => controller.abort(error),
    callbacks: {
      onPlatformSendDispatch: vi.fn(async () => {}),
      assertDirectAdapterHandoff: () => controller.signal.throwIfAborted(),
    },
  };
}
function acceptMessage(response: ServerResponse, validBody = true) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(validBody ? JSON.stringify({ ocs: { data: { id: 42 } } }) : "invalid-json");
}

it.each([{ name: "message text", send: sendText }])(
  "blocks $name cancelled during DNS without cancelling a concurrent delivery",
  async ({ send: deliver }) => {
    const cancelled = createHandoff();
    const current = createHandoff();
    const gate = createGate();
    transport.beforeLookup = async (url) => {
      if (url.includes("/chat/held")) {
        await gate.block();
      }
    };
    const requests = await withTalkServer(async (ctx) => {
      const result = await gate.during(
        deliver({ ...ctx, ...cancelled.callbacks, to: "room:held" }),
        async () => {
          cancelled.cancel();
          await expect(deliver({ ...ctx, ...current.callbacks })).resolves.toMatchObject({
            messageId: "42",
            receipt: { platformMessageIds: ["42"], replyToId: "41" },
          });
        },
      );
      expect(result).toBe(cancelled.error);
    });
    expect(requests.map((request) => [request.method, request.url, sentForm(request)])).toEqual([
      ["POST", MESSAGE_PATH, { message: "hello", replyTo: "41" }],
    ]);
    expect(current.callbacks.onPlatformSendDispatch).toHaveBeenCalledOnce();
  },
);

it("rejects a redirect after delivery cancellation", async () => {
  const handoff = createHandoff();
  const requests = await withTalkServer(
    (ctx) => expect(sendText({ ...ctx, ...handoff.callbacks })).rejects.toBe(handoff.error),
    (response, received) => {
      if (received.length === 1) {
        handoff.cancel();
        response.writeHead(307, { location: "/redirected-message" });
        response.end();
      } else {
        acceptMessage(response);
      }
    },
  );
  expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
    `POST ${MESSAGE_PATH}`,
  ]);
});

it.each([false, true])(
  "preserves an accepted send after cancellation with valid body=%s",
  async (validBody) => {
    const handoff = createHandoff();
    await withTalkServer(
      (ctx) =>
        expect(sendText({ ...ctx, ...handoff.callbacks })).resolves.toMatchObject({
          messageId: validBody ? "42" : "unknown",
          receipt: { platformMessageIds: validBody ? ["42"] : [] },
        }),
      (response) => {
        handoff.cancel();
        acceptMessage(response, validBody);
      },
    );
  },
);

it.each(["reject", "cancel"])(
  "settles an asynchronous dispatch hook before HTTP (%s)",
  async (mode) => {
    const handoff = createHandoff();
    const gate = createGate();
    handoff.callbacks.onPlatformSendDispatch.mockImplementation(async () => {
      await gate.block();
      if (mode === "reject") {
        throw handoff.error;
      }
    });
    const requests = await withTalkServer(async (ctx, received) => {
      const result = await gate.during(sendText({ ...ctx, ...handoff.callbacks }), () => {
        expect(handoff.callbacks.onPlatformSendDispatch).toHaveBeenCalledOnce();
        expect(received).toEqual([]);
        if (mode === "cancel") {
          handoff.cancel();
        }
      });
      expect(result).toBe(handoff.error);
    });
    expect(requests).toEqual([]);
  },
);
