import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { NEXTCLOUD_TALK_CHANNEL_ID } from "./channel-id.js";
import {
  createNextcloudTalkClient,
  createNextcloudTalkGuardedRawHttp,
  NextcloudTalkAuthStoppedError,
  readNextcloudTalkOcsData,
  type NextcloudTalkRawHttp,
  type NextcloudTalkRequest,
} from "./receive/talk-client.js";
import { assertNextcloudTalkRoomAccess } from "./room-access.js";
import type { CoreConfig } from "./types.js";

/**
 * Talk polls (Poll API, Talk 25): read the state of a poll and vote as the configured user.
 *
 * Talk only reveals votes when the user may see them: for public polls after the user has
 * voted, otherwise once the poll is closed (creator and moderators see more). The plugin
 * passes on exactly what Talk returns and never votes just to reveal results.
 */

export type NextcloudTalkPollOption = {
  /** 1-based number, as used by poll-vote (pollOptionIndex). */
  index: number;
  /** Talk option id (0-based), as used by poll-vote (pollOptionId). */
  optionId: string;
  text: string;
  /** Only when Talk reveals the result. */
  votes?: number;
  /** Who voted for this option, only for closed public polls. */
  voters?: { id: string; name: string }[];
  /** The configured user voted for this option. */
  votedBySelf?: true;
};

export type NextcloudTalkPoll = {
  pollId: string;
  roomToken: string;
  question: string;
  status: "open" | "closed" | "draft" | "unknown";
  resultMode: "public" | "hidden";
  /** Maximum number of options per participant; 0 = unlimited. */
  maxVotes: number;
  author: { id: string; name: string };
  options: NextcloudTalkPollOption[];
  /** The configured user has voted. */
  votedSelf: boolean;
  numVoters?: number;
  resultsVisible: boolean;
  /** Why results are missing, or how to act on the poll. */
  notes: string[];
};

const ID_PATTERN = /^[1-9]\d{0,18}$/u;
const ROOM_TOKEN_PATTERN = /^[a-z0-9]{4,64}$/iu;
const MAX_TEXT_LENGTH = 1000;

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function int(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function cleanText(value: unknown): string {
  const text = str(value).replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").trim();
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
}

export function isNextcloudTalkPollId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** Turns Talk poll data into the object handed to the agent. */
export function toNextcloudTalkPoll(raw: unknown, roomToken: string): NextcloudTalkPoll {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const status = int(data.status);
  const resultMode = int(data.resultMode) === 1 ? "hidden" : "public";
  const options = Array.isArray(data.options) ? data.options : [];
  // `votes` is an object {"option-<id>": n}; Talk sends [] when it is empty or hidden.
  const votesRaw =
    data.votes && typeof data.votes === "object" && !Array.isArray(data.votes)
      ? (data.votes as Record<string, unknown>)
      : undefined;
  const votedSelfIds = new Set(
    (Array.isArray(data.votedSelf) ? data.votedSelf : []).map(int).filter((id) => id !== undefined),
  );
  const details = Array.isArray(data.details) ? data.details : [];
  const numVoters = int(data.numVoters);
  const resultsVisible = votesRaw !== undefined || (numVoters !== undefined && numVoters > 0) || status === 1;

  const poll: NextcloudTalkPoll = {
    pollId: str(data.id),
    roomToken,
    question: cleanText(data.question),
    status: status === 0 ? "open" : status === 1 ? "closed" : status === 2 ? "draft" : "unknown",
    resultMode,
    maxVotes: int(data.maxVotes) ?? 0,
    author: {
      id: `${str(data.actorType)}/${str(data.actorId)}`,
      name: cleanText(data.actorDisplayName),
    },
    options: options.map((text, optionId) => {
      const option: NextcloudTalkPollOption = { index: optionId + 1, optionId: String(optionId), text: cleanText(text) };
      if (resultsVisible) {
        option.votes = int(votesRaw?.[`option-${optionId}`]) ?? 0;
      }
      const voters = details
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        .filter((entry) => int(entry.optionId) === optionId)
        .map((entry) => ({
          id: `${str(entry.actorType)}/${str(entry.actorId)}`,
          name: cleanText(entry.actorDisplayName),
        }));
      if (voters.length > 0) {
        option.voters = voters;
      }
      if (votedSelfIds.has(optionId)) {
        option.votedBySelf = true;
      }
      return option;
    }),
    votedSelf: votedSelfIds.size > 0,
    ...(numVoters !== undefined && resultsVisible ? { numVoters } : {}),
    resultsVisible,
    notes: [],
  };

  if (!resultsVisible) {
    poll.notes.push(
      resultMode === "hidden"
        ? "Results are hidden until the poll is closed."
        : "Talk shows the results only after you have voted or once the poll is closed.",
    );
  }
  if (poll.status === "open") {
    poll.notes.push(
      `To vote: message action poll-vote with pollId ${poll.pollId} and pollOptionIndex (1-based)` +
        `${poll.maxVotes === 1 ? "" : " or pollOptionIndexes"}. For the current state: action read with pollId.`,
    );
  }
  return poll;
}

/** Text that replaces the poll placeholder in a delivered message. */
export function renderNextcloudTalkPollText(poll: NextcloudTalkPoll): string {
  return `[Poll: ${poll.question}]\n${JSON.stringify(poll)}`;
}

type PollRequestParams = {
  request: NextcloudTalkRequest;
  roomToken: string;
  pollId: string;
  signal?: AbortSignal;
};

function pollPath(roomToken: string, pollId: string): string {
  return `/ocs/v2.php/apps/spreed/api/v1/poll/${encodeURIComponent(roomToken)}/${encodeURIComponent(pollId)}`;
}

function errorOf(json: unknown): string {
  const error = (json as { ocs?: { data?: { error?: unknown } } } | undefined)?.ocs?.data?.error;
  return typeof error === "string" && /^[a-z_-]{1,40}$/u.test(error) ? ` (${error})` : "";
}

function describeFailure(status: number, json: unknown, roomToken: string, verb: string): Error {
  if (status === 404) {
    return new Error(`Nextcloud Talk: poll not found in room ${roomToken} for the configured user.`);
  }
  if (status === 412) {
    return new Error(`Nextcloud Talk: room ${roomToken} has an active lobby.`);
  }
  return new Error(`Nextcloud Talk: ${verb} failed (HTTP ${status})${errorOf(json)}.`);
}

/** GET /poll/{token}/{pollId}; Talk answers 200 (docs say 201). */
export async function fetchNextcloudTalkPoll(params: PollRequestParams): Promise<NextcloudTalkPoll> {
  const response = await params.request({
    method: "GET",
    path: pollPath(params.roomToken, params.pollId),
    signal: params.signal,
    timeoutMs: 10_000,
  });
  if (response.status !== 200 && response.status !== 201) {
    throw describeFailure(response.status, response.json, params.roomToken, "reading the poll");
  }
  return toNextcloudTalkPoll(readNextcloudTalkOcsData(response), params.roomToken);
}

/** POST /poll/{token}/{pollId} with optionIds[]. */
export async function voteNextcloudTalkPollRequest(
  params: PollRequestParams & { optionIds: number[] },
): Promise<NextcloudTalkPoll> {
  const form: Record<string, string> = {};
  params.optionIds.forEach((id, position) => {
    form[`optionIds[${position}]`] = String(id);
  });
  const response = await params.request({
    method: "POST",
    path: pollPath(params.roomToken, params.pollId),
    form,
    signal: params.signal,
  });
  if (response.status !== 200 && response.status !== 201) {
    throw describeFailure(response.status, response.json, params.roomToken, "voting");
  }
  return toNextcloudTalkPoll(readNextcloudTalkOcsData(response), params.roomToken);
}

// ------------------------------------------------------------------ Message actions

type AccountPollParams = {
  cfg: CoreConfig;
  account: ResolvedNextcloudTalkAccount;
  roomToken: string;
  pollId: string;
  http?: NextcloudTalkRawHttp;
  signal?: AbortSignal;
};

async function prepare(params: AccountPollParams): Promise<NextcloudTalkRequest> {
  const { account } = params;
  if (!account.baseUrl || !account.apiUser || !account.apiPassword) {
    throw new Error(`Nextcloud Talk account "${account.accountId}" is not configured.`);
  }
  if (!ROOM_TOKEN_PATTERN.test(params.roomToken)) {
    throw new Error("A Nextcloud Talk room token is required (letters and digits).");
  }
  if (!isNextcloudTalkPollId(params.pollId)) {
    throw new Error("pollId must be a Nextcloud Talk poll id (a positive number).");
  }
  // Membership alone does not release a room: the config decides (see room-access.ts).
  await assertNextcloudTalkRoomAccess({ cfg: params.cfg, account, roomToken: params.roomToken });
  const client = createNextcloudTalkClient({
    baseUrl: account.baseUrl,
    user: account.apiUser,
    appPassword: account.apiPassword,
    http: params.http ?? createNextcloudTalkGuardedRawHttp(account.config.network?.dangerouslyAllowPrivateNetwork),
  });
  return async (request) => {
    try {
      return await client.request(request);
    } catch (error) {
      if (error instanceof NextcloudTalkAuthStoppedError) {
        throw new Error(error.message);
      }
      throw error;
    }
  };
}

export async function readNextcloudTalkPoll(params: AccountPollParams) {
  const request = await prepare(params);
  const poll = await fetchNextcloudTalkPoll({ ...params, request });
  return { channel: NEXTCLOUD_TALK_CHANNEL_ID, poll };
}

/**
 * Votes as the configured user. `optionIds` are Talk option ids (0-based); they are checked
 * against the current poll first so the agent gets a clear error instead of a bare 400.
 */
export async function voteNextcloudTalkPoll(params: AccountPollParams & { optionIds: number[] }) {
  const request = await prepare(params);
  const optionIds = [...new Set(params.optionIds)];
  if (optionIds.length === 0) {
    throw new Error("poll-vote needs pollOptionIndex, pollOptionIndexes, pollOptionId or pollOptionIds.");
  }
  const current = await fetchNextcloudTalkPoll({ ...params, request });
  if (current.status !== "open") {
    throw new Error(`Nextcloud Talk: poll ${params.pollId} is ${current.status}; voting is not possible.`);
  }
  const invalid = optionIds.filter((id) => !Number.isSafeInteger(id) || id < 0 || id >= current.options.length);
  if (invalid.length > 0) {
    throw new Error(
      `Nextcloud Talk: poll ${params.pollId} has options 1-${current.options.length}; ` +
        `invalid option ids: ${invalid.join(", ")}.`,
    );
  }
  if (current.maxVotes > 0 && optionIds.length > current.maxVotes) {
    throw new Error(`Nextcloud Talk: poll ${params.pollId} allows at most ${current.maxVotes} option(s).`);
  }
  const poll = await voteNextcloudTalkPollRequest({ ...params, request, optionIds });
  return {
    channel: NEXTCLOUD_TALK_CHANNEL_ID,
    ok: true,
    voted: optionIds.map((id) => current.options[id]!.text),
    poll,
  };
}
