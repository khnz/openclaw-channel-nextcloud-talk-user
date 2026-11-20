import {
  fetchWithSsrFGuard,
  ssrfPolicyFromPrivateNetworkOptIn,
} from "openclaw/plugin-sdk/ssrf-runtime";

/**
 * Nextcloud device login (Login Flow v2) and credential checks.
 * A human grants access in the browser as the configured user; the plugin polls for the
 * app password, verifies the identity and revokes a device signed in as the wrong user.
 *
 * Important: never retry with invalid credentials; Nextcloud counts failed sign-ins
 * per IP (brute-force protection).
 */

export const NEXTCLOUD_TALK_LOGIN_FLOW_TIMEOUT_MS = 20 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Default device name in Nextcloud; can be overridden with the `deviceName` config. */
export const DEFAULT_NEXTCLOUD_TALK_DEVICE_NAME = "openclaw nextcloud-talk-plugin";

/** Device name in Nextcloud (User-Agent of the device login). */
export function resolveNextcloudTalkDeviceName(configured?: string): string {
  const name = configured?.trim();
  return name ? name : DEFAULT_NEXTCLOUD_TALK_DEVICE_NAME;
}

export type NextcloudTalkHttpRequest = (params: {
  url: string;
  method: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  form?: Record<string, string>;
  signal?: AbortSignal;
}) => Promise<{ status: number; text: string }>;

/** Default HTTP through the OpenClaw SSRF guard. */
export function createNextcloudTalkGuardedRequest(params: {
  allowPrivateNetwork?: boolean;
  deviceName?: string;
}): NextcloudTalkHttpRequest {
  const userAgent = resolveNextcloudTalkDeviceName(params.deviceName);
  return async ({ url, method, headers, form, signal }) => {
    const body = form ? new URLSearchParams(form).toString() : undefined;
    const { response, release } = await fetchWithSsrFGuard({
      url,
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      // An HTTPS server URL stays HTTPS, also across redirects.
      requireHttps: new URL(url).protocol === "https:",
      init: {
        method,
        headers: {
          "User-Agent": userAgent,
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...headers,
        },
        ...(body ? { body } : {}),
      },
      policy: ssrfPolicyFromPrivateNetworkOptIn(params.allowPrivateNetwork),
      auditContext: "nextcloud-talk-user-device-login",
    });
    try {
      return { status: response.status, text: await response.text() };
    } finally {
      await release();
    }
  };
}

const ocsHeaders = (user: string, password: string): Record<string, string> => ({
  Accept: "application/json",
  "OCS-APIRequest": "true",
  Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export type NextcloudTalkLoginFlow = {
  loginUrl: string;
  /** Polls until access is granted, the flow times out or `signal` aborts. */
  waitForAppPassword: (params?: {
    signal?: AbortSignal;
    intervalMs?: number;
    timeoutMs?: number;
  }) => Promise<NextcloudTalkLoginFlowResult>;
};

export type NextcloudTalkLoginFlowResult =
  | { status: "granted"; loginName: string; appPassword: string; server: string }
  | { status: "timeout" }
  | { status: "aborted" };

export async function startNextcloudTalkLoginFlow(params: {
  baseUrl: string;
  request: NextcloudTalkHttpRequest;
}): Promise<NextcloudTalkLoginFlow> {
  const init = await params.request({ url: `${params.baseUrl}/index.php/login/v2`, method: "POST" });
  const data = parseJson(init.text) as
    | { login?: unknown; poll?: { token?: unknown; endpoint?: unknown } }
    | undefined;
  const loginUrl = typeof data?.login === "string" ? data.login : "";
  const token = typeof data?.poll?.token === "string" ? data.poll.token : "";
  const endpoint = typeof data?.poll?.endpoint === "string" ? data.poll.endpoint : "";
  if (init.status !== 200 || !loginUrl || !token || !endpoint) {
    throw new Error(`Could not start Nextcloud Login Flow v2 (HTTP ${init.status}).`);
  }
  // The poll endpoint must be on the same server.
  if (new URL(endpoint).origin !== new URL(params.baseUrl).origin) {
    throw new Error("Nextcloud returned a poll endpoint on a different server; aborting.");
  }
  // The password is typed on the login page: with an HTTPS server URL it must be HTTPS too.
  if (new URL(params.baseUrl).protocol === "https:" && new URL(loginUrl).protocol !== "https:") {
    throw new Error("Nextcloud returned a login link without HTTPS for an HTTPS server; aborting.");
  }

  return {
    loginUrl,
    waitForAppPassword: async ({ signal, intervalMs = 2_000, timeoutMs } = {}) => {
      const deadline = Date.now() + (timeoutMs ?? NEXTCLOUD_TALK_LOGIN_FLOW_TIMEOUT_MS);
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          return { status: "aborted" };
        }
        let poll: { status: number; text: string } | undefined;
        try {
          poll = await params.request({ url: endpoint, method: "POST", form: { token }, signal });
        } catch (error) {
          if (signal?.aborted) {
            return { status: "aborted" };
          }
          throw error;
        }
        if (poll.status === 200) {
          const result = parseJson(poll.text) as
            | { loginName?: unknown; appPassword?: unknown; server?: unknown }
            | undefined;
          if (typeof result?.loginName === "string" && typeof result.appPassword === "string") {
            return {
              status: "granted",
              loginName: result.loginName,
              appPassword: result.appPassword,
              server: typeof result.server === "string" ? result.server : params.baseUrl,
            };
          }
          throw new Error("Nextcloud returned an incomplete device login response.");
        }
        if (poll.status !== 404) {
          throw new Error(`Device login: unexpected response (HTTP ${poll.status}).`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, intervalMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return { status: "timeout" };
    },
  };
}

export type NextcloudTalkCredentialCheck =
  | { status: "ok"; uid: string; appPassword: string; converted: boolean }
  | { status: "rejected" }
  | { status: "throttled" }
  | { status: "error"; message: string };

/**
 * Checks credentials with exactly one sign-in and resolves the UID.
 * A regular account password is converted into an app password via `getapppassword`
 * (this creates a dedicated device); an app password is kept as is.
 */
export async function checkNextcloudTalkCredentials(params: {
  baseUrl: string;
  loginName: string;
  password: string;
  request: NextcloudTalkHttpRequest;
}): Promise<NextcloudTalkCredentialCheck> {
  const me = await params.request({
    url: `${params.baseUrl}/ocs/v1.php/cloud/user?format=json`,
    method: "GET",
    headers: ocsHeaders(params.loginName, params.password),
  });
  if (me.status === 401) {
    return { status: "rejected" };
  }
  if (me.status === 429) {
    return { status: "throttled" };
  }
  const uid = (parseJson(me.text) as { ocs?: { data?: { id?: unknown } } } | undefined)?.ocs?.data
    ?.id;
  if (me.status !== 200 || typeof uid !== "string" || !uid) {
    return { status: "error", message: `Benutzerabfrage fehlgeschlagen (HTTP ${me.status}).` };
  }

  const convert = await params.request({
    url: `${params.baseUrl}/ocs/v2.php/core/getapppassword?format=json`,
    method: "GET",
    headers: ocsHeaders(params.loginName, params.password),
  });
  if (convert.status === 403) {
    // 403 means the sign-in already used an app password.
    return { status: "ok", uid, appPassword: params.password, converted: false };
  }
  const converted = (
    parseJson(convert.text) as { ocs?: { data?: { apppassword?: unknown } } } | undefined
  )?.ocs?.data?.apppassword;
  if (convert.status === 200 && typeof converted === "string" && converted) {
    return { status: "ok", uid, appPassword: converted, converted: true };
  }
  return {
    status: "error",
    message: `App password check failed (HTTP ${convert.status}).`,
  };
}

/** Revokes the app password (device), e.g. after a wrong identity. */
export async function revokeNextcloudTalkAppPassword(params: {
  baseUrl: string;
  loginName: string;
  appPassword: string;
  request: NextcloudTalkHttpRequest;
}): Promise<boolean> {
  const result = await params.request({
    url: `${params.baseUrl}/ocs/v2.php/core/apppassword?format=json`,
    method: "DELETE",
    headers: ocsHeaders(params.loginName, params.appPassword),
  });
  return result.status === 200;
}
