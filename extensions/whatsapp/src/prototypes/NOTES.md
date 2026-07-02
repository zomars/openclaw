# WhatsApp History Capture Prototype

PROTOTYPE - wipe me.

Question: can the base WhatsApp channel own a complete-enough history stream by combining Baileys upserts with deterministic outbound writes, so business plugins such as `whatsapp-lead-bot` only query history instead of capturing it?

Run:

```bash
pnpm prototype:whatsapp-history
```

What to watch:

- `o` simulates an OpenClaw outbound send that never echoes back through Baileys. The deterministic outbound write keeps it in history.
- `e` simulates an outbound send that later does echo back. The store merges sources instead of duplicating.
- `w` simulates human handoff from WhatsApp Web as a `fromMe` upsert.
- `l` simulates a LID chat where enriched metadata backfills `peerE164` and media.

Draft decision: move WhatsApp history ownership into `extensions/whatsapp`; leave Solayre/lead plugins as consumers of channel history.

Native extraction runner:

```bash
pnpm prototype:whatsapp-native-history -- --account solayre --full-sync --list-ids
pnpm prototype:whatsapp-native-history -- --peer +526671234567 --account solayre --full-sync
```

`--list-ids` writes a grouped `*.ids.json` with observed `remoteJid` values, message counts, timestamps, newest message id, and sample text. Use that to pick a peer or an anchor.

For paged on-demand history, provide an anchor message from that chat:

```bash
pnpm prototype:whatsapp-native-history -- --peer +526671234567 --account solayre --oldest-id MESSAGE_ID --oldest-ts 1782230000 --request-count 50
```

This uses Baileys `messaging-history.set` and `fetchMessageHistory(...)`. It does not send chat messages. It clones the auth directory before connecting.
