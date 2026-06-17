# 2026.6.8 Merge — Deferred Fork-Patch Re-Application

Files where upstream's changes were so substantial that we took
`--theirs` wholesale in the merge. The fork patches listed below
must be re-applied as a follow-up commit before testing the merged
build, otherwise dependent plugins will silently break.

## Cron cluster sanity checks

Cron sub-agent kept both fork's `kind: "script"` payload AND upstream's
`kind: "command"` payload across types/CLI/UI. Flagged for verification:

- `src/cli/cron-cli/register.cron-add.ts`: script's `timeoutSeconds` uses
  upstream's stricter `parseStrictPositiveIntOrUndefined`. Confirm OK.
- `src/cli/cron-cli/register.cron-add.ts`: validation copy expanded with
  `--script` option; script does NOT warn about missing `--agent` (unlike
  agentTurn/command). Confirm intentional.
- `ui/src/ui/views/cron.ts`: dropped HEAD's `<details class="cron-advanced">`
  block; upstream's continuation re-renders the advanced fields.
  Visually smoke-test the cron edit form.
- `ui/src/ui/views/cron.ts`: `isScript` now also gates on `!payloadLocked`.
  If script payloads should always be editable, sanity-check.

## src/infra/outbound/deliver.test.ts

Took upstream (we had 73KB, upstream is 131KB with massive new coverage).
Lost: our WIP test `"stages local outbound media into OpenClaw artifacts
before channel delivery"` from commit `36e3fffe3a`. Re-add the test
post-merge if the staging behavior in `deliver.ts` lives on (it does —
`stageLocalOutboundMediaSource` is preserved in the merged file).

## extensions/browser/src/browser/routes/agent.snapshot.ts

Took upstream. Removed fork's `saveBrowserScreenshotArtifact` path that
relied on `extensions/browser/src/browser/artifacts.ts` (still committed
as WIP). The screenshot path now uses upstream's `saveBrowserMediaResponse`
with normalization + annotation rescaling. The `artifacts.ts` file in
`extensions/browser/src/browser/` is now orphaned; decide whether to
delete it or re-wire the snapshot route. Note: `src/media/artifacts.ts`
(the core helper) is a separate concern and likely still needed.

## extensions/telegram/src/bot-message-dispatch.test.ts

Took upstream wholesale, dropping ~99 HEAD-only test cases (preview
rotation, reasoning compaction, etc.). If our fork-specific telegram
dispatch behavior diverged from upstream, those tests document and
protect it. Retrievable via `git show HEAD:extensions/telegram/src/bot-message-dispatch.test.ts`.
Decide post-merge whether to re-introduce dropped tests.

## extensions/telegram/src/session-route.test.ts

Kept HEAD's canonicalization tests (string-form `threadId="12345:99"`)
AND upstream's number-form tests (`threadId.toBe(99)`). The fork's
`channel.ts` canonicalization fix (346a8ad895) means the upstream
number-form tests will fail. Pick a side post-merge or update one
group of tests.

## docs/channels/telegram.md

Took upstream. Our HEAD's prose described nuanced preview-message
behavior (visible non-preview output detection, stale-preview cleanup)
that came from `346a8ad895 fix(channels): canonicalize Telegram DM
topic session routes`. If our Telegram code patches survived the
merge intact, the docs may need updating to reflect actual behavior.
Verify after merge.

## extensions/whatsapp/src/inbound/monitor.ts

Took upstream's ~48KB version (we had 25.8KB v2026.4.x baseline).
Re-apply three surgical patches:

### 1. `isAccountOwnerMessage` wire-through

From commit `42b9081195 fix(whatsapp): wire isAccountOwnerMessage to inbound message for handoff detection`.

In the `onMessage(...)` payload construction (look for `selfLid`, `selfE164`, `fromMe` siblings), add:

```ts
isAccountOwnerMessage: inbound.access.isAccountOwnerMessage,
```

Reason: lead-bot's `filterWhatsAppWebHandoff` reads `sentByAccountOwner` from this metadata. Without it, coworker replies via WhatsApp Web are treated as lead messages and the bot auto-responds.

### 2. `emitEnrichedWhatsAppMessage(...)` after enrichment

From commits `cd8c812fe1 feat(whatsapp): persist local media_path via enriched post-download event` and `fcb34d5942 feat(whatsapp): peer_e164 column bridges LID conversations to phone-keyed lookups`.

After `enrichInboundMessage` succeeds (look for the block that produces `enriched.mediaPath` / `enriched.mediaType` / `enriched.mediaFileName`), emit:

```ts
if (inbound.id) {
  emitEnrichedWhatsAppMessage({
    id: inbound.id,
    accountId: options.accountId,
    remoteJid: inbound.remoteJid,
    peerE164: !inbound.group && inbound.from ? inbound.from : undefined,
    fromMe: Boolean(msg.key?.fromMe),
    mediaPath: enriched.mediaPath,
    mediaType: enriched.mediaType,
    mediaFileName: enriched.mediaFileName,
  });
}
```

Required import at top:

```ts
import { emitEnrichedWhatsAppMessage, emitRawWhatsAppMessage } from "../active-listener.js";
```

Reason: lead-bot's schema v9 `media_path` column and v11 `peer_e164` column are populated by subscribers to this event. Without it, media attachments never get their local path stored and LID conversations cannot be looked up by E.164 (Marino-style bugs).

### 3. `emitRawWhatsAppMessage(...)` on raw inbound

Same commits as above. Look for where the raw inbound message is first processed (before enrichment). Emit:

```ts
emitRawWhatsAppMessage({
  id: msg.key?.id,
  accountId: options.accountId,
  remoteJid: msg.key?.remoteJid ?? "",
  fromMe: Boolean(msg.key?.fromMe),
  // ... whatever shape upstream now uses; check active-listener.ts for the canonical type
});
```

Reason: lead-bot's eager subscriber records the raw insert with E.164 derived from `@s.whatsapp.net` JIDs.

## Verification after re-applying

1. `pnpm build` succeeds
2. `pnpm test extensions/whatsapp` — at least monitor.ts's tests pass
3. With gateway restarted, a WhatsApp DM with media downloads and persists `media_path`
4. An LID-JID conversation is now retrievable by `whatsapp_history_fetch(peer="+<e164>")`
5. A coworker reply via WhatsApp Web does NOT trigger lead-bot auto-response (filterWhatsAppWebHandoff still fires)
