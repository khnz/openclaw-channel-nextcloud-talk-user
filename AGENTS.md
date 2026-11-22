# AGENTS.md

Guidance for coding agents working on this repository.

## Project

`nextcloud-talk-user` is an OpenClaw channel plugin that signs in to Nextcloud Talk as a regular
Nextcloud user instead of a Talk bot. It is based on the OpenClaw `nextcloud-talk` plugin
(upstream commit in `.upstream-revision`) but developed independently; do not assume upstream
changes apply here.

It must keep working side by side with the official `nextcloud-talk` plugin. Keep the plugin id,
state directory and log prefixes on `nextcloud-talk-user`. Never write the bot plugin's config or
state; only the doctor reads its config to warn about rooms and senders that both plugins would
answer.

There are two package variants. The default package uses the channel `nextcloud-talk-user`; the
drop-in replacement (`npm run pack:dropInReplacement`) uses the channel `nextcloud-talk` of the
official plugin. The channel identity lives only in `src/channel-id.ts`: never hard-code a channel
id, use `NEXTCLOUD_TALK_CHANNEL_ID` and `NEXTCLOUD_TALK_CHANNEL_IDENTITY`. In the drop-in package,
`openclaw doctor --fix` may disable the official plugin (`plugins.entries.nextcloud-talk.enabled`);
nothing else of its config is changed.

## Commands

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run build   # clears dist/, compiles and regenerates channelConfigs in openclaw.plugin.json
npm run pack:dropInReplacement   # drop-in package in build/, the repo stays unchanged
```

Run all three before finishing a change. If you change `src/config-schema.ts`, run the build and
commit the updated `openclaw.plugin.json`; `node scripts/generate-manifest.mjs --check` verifies it.

## Layout

- `index.ts`, `setup-entry.ts`, `*-api.ts`: plugin entry points referenced by `package.json`
- `src/channel-id.ts`: channel identity of both package variants
- `src/channel.ts`: channel plugin definition (wires everything together)
- `src/receive/`: receive layer
  - `talk-client.ts`: HTTP client with a shared sign-in state
  - `monitor.ts`: notify_push, notifications, room sync, per-room cursor, retries
  - `normalize-message.ts`: Talk chat message -> inbound message
  - `rich-object.ts`: shared rich objects (locations, other types) -> readable text
  - `poll-enrich.ts`: loads full poll details before a message is handed over
  - `state.ts`, `auto-join.ts`, `notification-level.ts`, `start-account.ts`
- `src/inbound.ts`, `src/inbound-media.ts`: access checks and handoff to the agent
- `src/send.ts`, `src/outbound-media.ts`: sending text, reactions and files as the user
- `src/room-access.ts`, `src/room-info.ts`: room release check for agent actions, room type and
  one-to-one participant lookup
- `src/device-login.ts`, `src/setup-*.ts`: setup wizard and Login Flow v2
- `src/history.ts`, `src/message-actions.ts`: message actions `read` (history, polls) and
  `poll-vote`
- `src/poll.ts`: Talk poll API (load, render, vote)
- `src/doctor*.ts`: `openclaw doctor` checks; `doctor-contract-api.ts` and `src/doctor-contract.ts`
  are the plugin doctor contract of the drop-in package
- `scripts/`: manifest generation and the drop-in package build
- `types/openclaw-untyped.d.ts`: minimal types for SDK modules the published package ships
  without types
- `test-support/`: rebuilt test helpers that the published `openclaw` package does not include

## Rules that protect users

- **Never retry a rejected sign-in.** A `401` or brute-force throttling (`429`, "Reached maximum
  delay") must stop all requests of the account (`NextcloudTalkAuthStoppedError`). Nextcloud counts
  failed sign-ins per IP and blocks the whole host.
- **Do not repeat `404` on a room.** Talk counts them for brute-force protection too; pause the
  room until the next full sync.
- **Credentials:** app passwords only (device login or user-created), never logged, never in code,
  tests or error messages. Prefer SecretRefs and `apiPasswordFile`.
- **Respect Nextcloud permissions.** Never bypass room membership, lobbies or passwords. `autoJoin`
  only joins open rooms and never rejoins after the user was removed.
- **No lost or duplicated messages.** The per-room cursor only advances after a successful handoff;
  do not replay old history when a room is seen for the first time.
- **Sending:** keep the `referenceId` check before any retry so messages are never sent twice.
- **HTTPS stays HTTPS.** With an `https://` server URL every connection must use HTTPS: pass
  `requireHttps` to `fetchWithSsrFGuard` (checked on every redirect), and use `notify_push` only
  as `wss://` on the server's host and port. An `http://` server URL is allowed (private
  networks); the setup wizard only warns.
- **Agent actions only in released rooms.** Reading history or polls, sending text or files,
  reacting and voting must pass `assertNextcloudTalkRoomAccess` (same rules as incoming
  messages: `groupPolicy`, `rooms`, `dmPolicy`, `allowFrom`, approved pairings). Membership alone
  is not enough; unknown rooms are refused. Only the pairing challenge to a sender who is not
  released yet may bypass it.
- **Polls follow participant rules.** Pass on votes exactly as Talk reveals them to the account;
  never vote just to see results. Check status, option range and `maxVotes` before voting.

## Tests

- Unit tests run against fake servers in the test files. They must never contact a real Nextcloud
  or send real messages.
- Use neutral example values (`cloud.example.com`, `agent`, `alice`, made-up room tokens), never
  real hosts, accounts or tokens.
- Seven tests in `src/inbound.behavior.test.ts` are skipped on purpose: they need host test helpers
  (plugin registry, state database) that only exist in the OpenClaw monorepo.
- `src/sdk-compat.test.ts` fails if code imports plugin SDK paths that OpenClaw retires.
- `src/drop-in-replacement.test.ts` covers the drop-in variant (identity, schema, doctor).

## Conventions

- Everything in English: identifiers, comments, log and error messages, test names.
- Follow the upstream naming scheme: `NextcloudTalk` in function and type names
  (`createNextcloudTalkClient`, `NextcloudTalkChatMessage`), `NEXTCLOUD_TALK_*` for constants,
  `DEFAULT_NEXTCLOUD_TALK_*` for defaults.
- Files in kebab-case; tests next to the module as `<module>.test.ts` or `<module>.<aspect>.test.ts`.
- Import OpenClaw only through `openclaw/plugin-sdk/*`.
- Check the Talk API of the targeted Nextcloud version before relying on new fields or endpoints.
