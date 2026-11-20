# Nextcloud Talk (User) for OpenClaw

OpenClaw channel plugin that signs in to Nextcloud Talk as a **regular Nextcloud user** instead
of a Talk bot. The agent shows up in Talk like a person: it gets invited to rooms, receives
direct messages, replies, reads attachments and can message people on its own.

The plugin can be installed alongside the official `nextcloud-talk` plugin (bot/webhook); ids,
config and state are separate. It is based on `extensions/nextcloud-talk` from OpenClaw (commit in
`.upstream-revision`).

Tested with Nextcloud 35.0.2 and Talk 25.0.7. Built against `openclaw@2026.11.5`; the plugin
requires `pluginApi >=2026.11.5`.

## Features

**Receiving**
- Real time via `notify_push` (WebSocket) and the notifications API; messages are fetched through
  the Talk chat API (full text, reply context, attachments, threads).
- Safety net: room list sync every 60 s (every 5 s without `notify_push`), full sync every 5 min.
  This also picks up messages without a notification (e.g. silent messages).
- No replay of old messages on first contact with a room; resumes after a restart without loss
  and without duplicates; catching up is limited to 50 messages per room.
- If handing a message to the agent fails, it is retried after 5 s, 30 s, 2 min, 5 min and
  10 min, then skipped with an error, so a permanent failure cannot block a room.
- Mentions of the account are detected from structured data; a reply to one of its messages
  counts as a mention; `@all` optionally (`mentionAll`).
- Attachments and voice messages are downloaded via WebDAV as the account (sender allowlist
  `mediaAllowFrom`, size limit `mediaMaxMb`).
- Own messages and, by default, messages from Talk bots are ignored.
- Read marker after dispatching to the agent; online status via `user_status` (when available).
- Notification level per group room is managed automatically: "always" when the agent reacts to
  all messages there, otherwise "on mention".

**Sending**
- Text, replies, threads, silent messages, reactions and files as the account.
- Long texts are split into chunks of at most 4000 characters; every message carries a
  `referenceId`. After a timeout the plugin checks via `referenceId` whether the message arrived
  before retrying exactly once.
- Proactive direct messages: target `user:<uid>`; the 1:1 room is created on demand (only for
  people in `allowFrom`, can be disabled with `proactiveDm: "off"`).

**Agent tools**
- Message actions `send`, `react` and `read` (history and context around a message, can be
  disabled with `actions.messages: false`).
- All agent actions (sending text and files, reacting, reading history) only work in rooms
  the configuration releases, by the same rules as incoming messages: group rooms per
  `groupPolicy` and `rooms` (never with `enabled: false`), one-to-one rooms only with a
  participant from `allowFrom` or an approved pairing (`dmPolicy`). Membership alone is not
  enough; note-to-self rooms and rooms whose type cannot be determined are refused. See
  [Releasing rooms](#releasing-rooms).

**Rooms and access**
- Nextcloud controls rooms: once the account is invited, the room is there; additionally
  filtered by `groupPolicy`, `groupAllowFrom` and `rooms`.
- Optional `autoJoin`: the account joins open rooms on its own (never with a lobby or password,
  no rejoin after removal).

**Security**
- Signs in only with an app password from the device login (Login Flow v2); the signed-in
  identity is checked against the configured user, a device signed in as the wrong user is
  revoked.
- Shared sign-in state: a rejected password (`401`) or brute-force throttling (`429`) stops all
  parts immediately, without retries.
- With an `https://` server URL every connection uses HTTPS, also across redirects; `notify_push`
  only uses `wss://` on the server's host and port. An `http://` server URL keeps working over HTTP
  (for example in a private network); the setup wizard shows a warning.
- The app password is redacted in error texts; the plugin itself does not log message content.
- `openclaw doctor` checks required settings, sign-in, Talk access, `notify_push`, `user_status`
  and overlap with the bot plugin.

## Setup

```bash
openclaw configure --section channels
```

The wizard asks for the server URL and user, then shows the device login link and an input field
for the device password. Open the link, ideally in a private browser window, sign in as the
desired user and click "Grant access"; then leave the field empty. Alternatively, create an app
password manually and paste it. The device is called `openclaw nextcloud-talk-plugin` in
Nextcloud (configurable via `deviceName`) and can be revoked there at any time.

Use a dedicated Nextcloud account for the agent, never a personal one.

## Configuration

Example (`channels.nextcloud-talk-user`):

```json5
{
  enabled: true,
  baseUrl: "https://cloud.example.com",
  apiUser: "agent",                  // Nextcloud user the plugin acts as
  apiPassword: "…",                  // app password (set by the wizard; SecretRef recommended)
  dmPolicy: "allowlist",
  allowFrom: ["users/alice"],        // who may send direct messages (and whom the agent may message)
  mediaAllowFrom: ["users/alice"],   // whose attachments are processed
  groupPolicy: "open",               // control rooms through Nextcloud membership
  groupAllowFrom: ["*"],
}
```

More settings:

| Setting | Default | Meaning |
|---|---|---|
| `apiPasswordFile` | – | Read the app password from a file instead of `apiPassword` |
| `network.dangerouslyAllowPrivateNetwork` | `false` | Allow a server on a private network |
| `rooms.<token>.requireMention` | `true` | `false`: the agent reacts to all messages in the room |
| `rooms.<token>.allowFrom` / `.enabled` | – | Restrict senders per room / disable a room |
| `ignoreBots` | `true` | Ignore messages from Talk bots |
| `markRead` | `true` | Mark as read after dispatching to the agent |
| `presence` | `"online"` | `"silent"`: no online status |
| `mentionAll` | `false` | Treat `@all` as a mention |
| `proactiveDm` | `"allowFrom"` | `"off"`: no proactive direct messages |
| `autoJoin` | `false` | Join open rooms on its own |
| `deviceName` | `"openclaw nextcloud-talk-plugin"` | Device name in Nextcloud for the device login (new sign-ins only) |
| `mediaMaxMb` | 20 | Attachment size limit in MB (unless OpenClaw sets another limit) |
| `actions.messages` | `true` | Offer the history tool `read` |

### Releasing rooms

Which rooms are released decides two things at once:

- whose incoming messages reach the agent, and
- where the agent may act on its own: send text and files, react, read history.

Membership in Nextcloud alone is not enough for the second part. This applies to agent
actions only in this plugin: other OpenClaw channels use these settings for incoming messages
only. Note-to-self rooms and rooms whose type cannot be determined (for example because the
account is not a member) are always refused.

**Single group rooms.** List them under `rooms`; the key is the room token, the last part of
the room URL (`https://cloud.example.com/call/<token>`). As soon as `rooms` has an entry, only
listed rooms are released:

```json5
{
  groupPolicy: "open",
  rooms: {
    "abc123xy": {},                          // released
    "q7w8e9r0": { requireMention: false },   // released, reacts to every message
    "zz11yy22": { enabled: false },          // listed but disabled
  },
}
```

**All group rooms.** Leave `rooms` out, or add the wildcard `"*": {}` if you still want to set
options for single rooms. `groupPolicy` must not be `"disabled"`; set it to `"open"` explicitly,
otherwise the OpenClaw default applies. A room with `enabled: false` stays blocked.

```json5
{
  groupPolicy: "open",
  rooms: {
    "*": {},                                 // every room the account is a member of
    "zz11yy22": { enabled: false },          // except this one
  },
}
```

**One-to-one rooms.** A one-to-one room is released when the other participant matches
`allowFrom` or, with `dmPolicy: "pairing"`, has an approved pairing. `dmPolicy: "disabled"`
blocks all of them. To release all one-to-one rooms, use `allowFrom: ["*"]` (or
`dmPolicy: "open"`):

```json5
{
  dmPolicy: "allowlist",
  allowFrom: ["users/alice", "users/bob"],   // only these two
  // allowFrom: ["*"],                       // everyone
}
```

`allowFrom: ["*"]` also means that every Nextcloud user may message the agent directly, and that
the agent may message everyone on its own (unless `proactiveDm: "off"`).

Who may write in group rooms is set separately by `groupAllowFrom` and `rooms.<token>.allowFrom`;
these do not affect where the agent may act.

**Security.** Releasing all rooms removes the boundary between them: a prompt injection in any
released room can make the agent read another released room and post its content elsewhere.
Release only the rooms the agent needs, and use a dedicated Nextcloud account for it.

## Drop-in replacement for nextcloud-talk

A second package variant registers the channel under the name of the official plugin,
`nextcloud-talk`, instead of `nextcloud-talk-user`. Existing configuration, sessions, cron jobs and
bindings that refer to the channel `nextcloud-talk` keep working. The plugin id stays
`nextcloud-talk-user`.

The config is read from `channels.nextcloud-talk`. Settings of the official plugin (`botSecret`,
`botSecretFile`, `webhookPath`, `webhookPublicUrl`, `legacyWebhook`) are accepted and ignored, so an
existing config keeps validating. OpenClaw accepts only one plugin per channel, so the official
plugin must be disabled.

Steps:

1. Build the package:
   ```bash
   npm install --ignore-scripts
   npm run pack:dropInReplacement
   ```
2. Disable the official plugin before installing, otherwise it may keep the channel when the
   gateway restarts:
   ```bash
   openclaw config set plugins.entries.nextcloud-talk.enabled false
   ```
3. Only when switching from the default package of this plugin: move the settings from
   `channels.nextcloud-talk-user` to `channels.nextcloud-talk` and remove the old section;
   OpenClaw refuses the install while `channels.nextcloud-talk-user` is still configured.
4. Install (switching between the variants requires `--accept-capabilities`, because the channel
   changes):
   ```bash
   openclaw plugins install npm-pack:./build/nextcloud-talk-user-<version>-drop-in-replacement.tgz --force --accept-capabilities
   ```
5. When coming from the official plugin, add `apiUser` and the app password
   (`openclaw configure`) to sign in as a regular user.
6. Check: `openclaw doctor` warns while the official plugin is still enabled;
   `openclaw doctor --fix` disables it.

Back to the default package: move the settings back to `channels.nextcloud-talk-user`, remove
`channels.nextcloud-talk` (or re-enable the official plugin with its own settings), then install
the default package with `--force --accept-capabilities`.

## Install from source

```bash
npm install --ignore-scripts
npm run build
npm pack
openclaw plugins install npm-pack:./nextcloud-talk-user-<version>.tgz --force
```

## Development

```bash
npm run typecheck
npm test
npm run build        # builds dist/ and the manifest (channelConfigs)
```

The unit tests use fake servers only; they never contact a real Nextcloud.

## Known limitations

- The setup wizard stores the app password as plain `apiPassword` in the config. For production,
  use a SecretRef or `apiPasswordFile`.
- Edits and deletions of messages are not reported to the agent. A message edited shortly after
  sending is processed in its edited state.
- Messages without a notification (e.g. silent messages) arrive with up to 60 s delay.
- The published `openclaw` package does not ship types for all SDK modules; replacement
  signatures live in `types/openclaw-untyped.d.ts`. Missing test helpers are rebuilt in
  `test-support/`; seven tests of the automatic reply delivery need host internals and are
  skipped with a reason (`src/inbound.behavior.test.ts`).

## License

MIT, see `LICENSE`. Based on the OpenClaw `nextcloud-talk` plugin, © OpenClaw Foundation.
