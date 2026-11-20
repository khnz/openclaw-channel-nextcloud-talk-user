import type {
  ChannelDoctorAdapter,
  ChannelDoctorSequenceResult,
} from "openclaw/plugin-sdk/channel-contract";
import {
  listNextcloudTalkAccountIds,
  resolveNextcloudTalkAccount,
  type ResolvedNextcloudTalkAccount,
} from "./accounts.js";
import { collectNextcloudTalkBotPluginOverlap } from "./doctor-overlap.js";
import {
  createNextcloudTalkGuardedRawHttp,
  createNextcloudTalkClient,
  NextcloudTalkAuthStoppedError,
  readNextcloudTalkOcsData,
  type NextcloudTalkRawHttp,
} from "./receive/talk-client.js";
import type { CoreConfig } from "./types.js";
import { NEXTCLOUD_TALK_CHANNEL_ID, NEXTCLOUD_TALK_DROP_IN_REPLACEMENT } from "./channel-id.js";

/**
 * Doctor checks of the plugin.
 *
 * Offline: required settings, ignoreBots, overlap with the bot plugin.
 * Online (at most two requests per account, no retry after 401): sign-in, identity,
 * notify_push and user_status. user_status is optional; without the app the plugin sets
 * no online status (info only).
 */

const DOCTOR_TIMEOUT_MS = 10_000;

export type NextcloudTalkDoctorDeps = {
  http?: (account: ResolvedNextcloudTalkAccount) => NextcloudTalkRawHttp;
};

async function checkServer(
  account: ResolvedNextcloudTalkAccount,
  http: NextcloudTalkRawHttp,
): Promise<{ warnings: string[]; infos: string[] }> {
  const warnings: string[] = [];
  const infos: string[] = [];
  const client = createNextcloudTalkClient({
    baseUrl: account.baseUrl,
    user: account.apiUser,
    appPassword: account.apiPassword,
    http,
  });
  try {
    const me = await client.request({
      method: "GET",
      path: "/ocs/v1.php/cloud/user",
      query: { format: "json" },
      timeoutMs: DOCTOR_TIMEOUT_MS,
    });
    const uid = (readNextcloudTalkOcsData(me) as { id?: unknown } | undefined)?.id;
    if (me.status !== 200 || typeof uid !== "string") {
      warnings.push(`Benutzerabfrage fehlgeschlagen (HTTP ${me.status}).`);
      return { warnings, infos };
    }
    if (uid.toLowerCase() !== account.apiUser.toLowerCase()) {
      warnings.push(
        `The app password belongs to "${uid}", but apiUser is "${account.apiUser}". Run the device login again via openclaw configure.`,
      );
    }

    const caps = await client.request({
      method: "GET",
      path: "/ocs/v2.php/cloud/capabilities",
      timeoutMs: DOCTOR_TIMEOUT_MS,
    });
    const capabilities =
      (readNextcloudTalkOcsData(caps) as { capabilities?: Record<string, any> } | undefined)?.capabilities ?? {};
    if (!capabilities.spreed) {
      warnings.push(`Talk is not available for "${uid}" (spreed capability missing; check group membership).`);
    }
    const push = capabilities.notify_push?.endpoints?.websocket;
    if (typeof push !== "string" || !push) {
      infos.push(
        "notify_push is not available: new messages are detected by polling every 5 s instead of by push.",
      );
    } else {
      const pushHost = URL.parse(push)?.hostname;
      const baseHost = URL.parse(account.baseUrl)?.hostname;
      if (pushHost && baseHost && pushHost !== baseHost) {
        infos.push(
          `notify_push advertises ${push}; the plugin connects to the baseUrl host (${baseHost}) instead.`,
        );
      }
    }
    if (!capabilities.user_status?.enabled) {
      infos.push(
        "The user_status app is not enabled: the plugin sets no online status (presence is ignored).",
      );
    } else if (account.config.presence === "silent") {
      infos.push('presence is "silent": the plugin sets no online status.');
    }
  } catch (error) {
    if (error instanceof NextcloudTalkAuthStoppedError) {
      warnings.push(
        error.reason === "unauthorized"
          ? "Nextcloud rejects the sign-in (app password revoked or wrong). Run the device login again via openclaw configure."
          : "Nextcloud is throttling sign-ins from this host (brute-force protection). Admin on the Nextcloud server: occ security:bruteforce:reset <IP of this host>.",
      );
    } else {
      warnings.push(
        `Server not reachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { warnings, infos };
}

export async function runNextcloudTalkDoctorSequence(
  params: { cfg: CoreConfig; dropInReplacement?: boolean },
  deps: NextcloudTalkDoctorDeps = {},
): Promise<ChannelDoctorSequenceResult> {
  const dropInReplacement = params.dropInReplacement ?? NEXTCLOUD_TALK_DROP_IN_REPLACEMENT;
  const infoNotes: string[] = [];
  const warningNotes: string[] = [];
  // As a drop-in replacement there is no separate bot plugin: channels.nextcloud-talk is ours.
  const botSection = dropInReplacement
    ? undefined
    : (params.cfg.channels as Record<string, unknown> | undefined)?.["nextcloud-talk"];
  for (const accountId of listNextcloudTalkAccountIds(params.cfg)) {
    const account = resolveNextcloudTalkAccount({ cfg: params.cfg, accountId });
    if (!account.enabled) {
      continue;
    }
    const prefix = `- channels.${NEXTCLOUD_TALK_CHANNEL_ID}.${account.accountId}`;
    const warn = (text: string) => warningNotes.push(`${prefix}: ${text}`);
    const info = (text: string) => infoNotes.push(`${prefix}: ${text}`);

    if (!account.baseUrl) {
      warn("baseUrl is missing.");
    }
    if (!account.apiUser) {
      warn("apiUser (the Nextcloud user the plugin signs in as) is missing.");
    }
    if (account.credentialStatus === "missing") {
      warn("App password is missing. Run the device login via openclaw configure.");
    } else if (account.credentialStatus === "configured_unavailable") {
      warn("App password is configured but not readable.");
    }

    if (account.config.ignoreBots === false) {
      warn(
        "ignoreBots is off: the plugin hands messages from Talk bots (including the bot plugin) to the agent; bots may answer each other (loop).",
      );
    }
    const overlap = collectNextcloudTalkBotPluginOverlap({ account, botSection });
    overlap.warnings.forEach(warn);
    overlap.infos.forEach(info);

    if (account.baseUrl && account.apiUser && account.apiPassword) {
      const http =
        deps.http?.(account) ??
        createNextcloudTalkGuardedRawHttp(account.config.network?.dangerouslyAllowPrivateNetwork);
      const server = await checkServer(account, http);
      server.warnings.forEach(warn);
      server.infos.forEach(info);
    }
  }
  return { changeNotes: [], warningNotes, infoNotes };
}

export const nextcloudTalkDoctor: ChannelDoctorAdapter = {
  runConfigSequence: ({ cfg }) => runNextcloudTalkDoctorSequence({ cfg: cfg as CoreConfig }),
};
