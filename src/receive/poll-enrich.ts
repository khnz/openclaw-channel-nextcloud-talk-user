import { NextcloudTalkAuthStoppedError } from "./talk-client.js";
import type { NextcloudTalkChatMessage } from "./normalize-message.js";
import { renderNextcloudTalkRichObject } from "./rich-object.js";
import { isNextcloudTalkPollId, renderNextcloudTalkPollText, type NextcloudTalkPoll } from "../poll.js";
import type { NextcloudTalkInboundMessage } from "../types.js";

/**
 * Polls arrive as a rich object with only id and question. Before handing a message over,
 * the receive layer loads the poll (options, status, visible votes) and replaces the
 * placeholder text, for the message itself and for a quoted poll.
 */

type PollObject = { id: string; fallback: string };

function pollObjectOf(message: Pick<NextcloudTalkChatMessage, "messageParameters"> | undefined): PollObject | undefined {
  const parameters = message?.messageParameters;
  if (!parameters || Array.isArray(parameters) || typeof parameters !== "object") {
    return undefined;
  }
  const object = (parameters as Record<string, Record<string, unknown> | undefined>).object;
  if (!object || object.type !== "talk-poll") {
    return undefined;
  }
  const id = typeof object.id === "string" || typeof object.id === "number" ? String(object.id) : "";
  return isNextcloudTalkPollId(id) ? { id, fallback: renderNextcloudTalkRichObject(object) } : undefined;
}

function replaceFallback(text: string, poll: PollObject, replacement: string): string {
  return text.includes(poll.fallback) ? text.replace(poll.fallback, () => replacement) : text;
}

export async function enrichNextcloudTalkPolls(params: {
  inbound: NextcloudTalkInboundMessage;
  raw: NextcloudTalkChatMessage;
  fetchPoll: (pollId: string) => Promise<NextcloudTalkPoll>;
  log?: (message: string) => void;
}): Promise<NextcloudTalkInboundMessage> {
  const { inbound, raw, fetchPoll } = params;
  const own = pollObjectOf(raw);
  const parent = raw.parent && !("deleted" in raw.parent) ? raw.parent : undefined;
  const quoted = pollObjectOf(parent);
  if (!own && !(quoted && inbound.quote)) {
    return inbound;
  }
  const load = async (poll: PollObject): Promise<string> => {
    try {
      return renderNextcloudTalkPollText(await fetchPoll(poll.id));
    } catch (error) {
      if (error instanceof NextcloudTalkAuthStoppedError) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      params.log?.(`[receive] poll ${poll.id} in room ${inbound.roomToken}: details unavailable: ${reason}`);
      return `${poll.fallback} (poll details unavailable)`;
    }
  };
  const result: NextcloudTalkInboundMessage = { ...inbound };
  if (own) {
    // mentionText stays as is: poll content must not trigger text-based mention patterns.
    result.text = replaceFallback(inbound.text, own, await load(own));
  }
  if (quoted && inbound.quote) {
    result.quote = { ...inbound.quote, body: replaceFallback(inbound.quote.body, quoted, await load(quoted)) };
  }
  return result;
}
