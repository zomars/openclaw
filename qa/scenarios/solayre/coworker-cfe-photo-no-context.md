# Solayre coworker CFE photo without client context

```yaml qa-scenario
id: solayre-coworker-cfe-photo-no-context
title: Solayre coworker CFE photo without client context
surface: channel
category: solayre
coverage:
  primary:
    - solayre.coworker-quote-intake
  secondary:
    - solayre.cfe-receipt
    - channels.qa-channel
    - media.image-understanding
risk: high
objective: Verify a coworker forwarding only a CFE receipt photo is asked for the missing client phone/context instead of generating or claiming to send a quote to the coworker's number.
plugins:
  - whatsapp-lead-bot
gatewayConfigPatch:
  agents:
    defaults:
      workspace: /Users/zomars/.openclaw/workspace
    list:
      - id: solayre-coworker-dev
        name: Solayre Coworker Dev
        default: true
        workspace: /Users/zomars/.openclaw/workspace-solayre-coworker
        model:
          primary: openai-codex/gpt-5.4-mini
          fallbacks:
            - openai/claude-sonnet-4
        thinkingDefault: off
        reasoningDefault: off
        skills: []
        sandbox:
          mode: off
        tools:
          profile: messaging
          alsoAllow:
            - image
            - media
            - group:plugins
          deny:
            - process
            - nodes
            - web_search
            - web_fetch
            - browser
            - apply_patch
            - exec
            - sessions_list
            - sessions_history
            - sessions_send
            - sessions_spawn
            - agent_to_agent
            - cron
      - id: solayre-leads-dev
        name: Solayre Leads Dev
        workspace: /Users/zomars/.openclaw/workspace-solayre-leads-dev
        model:
          primary: openai-codex/gpt-5.4-mini
          fallbacks:
            - openai/claude-sonnet-4
        thinkingDefault: off
        reasoningDefault: off
        skills: []
        sandbox:
          mode: off
        tools:
          profile: messaging
          alsoAllow:
            - image
            - media
            - group:plugins
          deny:
            - process
            - nodes
            - web_search
            - web_fetch
            - browser
            - apply_patch
            - exec
            - sessions_list
            - sessions_history
            - sessions_send
            - sessions_spawn
            - agent_to_agent
            - cron
            - whatsapp_history_fetch
  plugins:
    entries:
      whatsapp-lead-bot:
        enabled: true
        config:
          agentId: solayre-leads-dev
          agentNumbers:
            - qa-coworker-no-context
          dbPath: /Users/zomars/.openclaw/workspace-solayre-leads-dev/data/leads.db
          dryRunPrefixes:
            - "+00000"
            - lead-
            - sim-
            - qa-
          followup:
            enabled: false
          rateLimit:
            messagesPerHour: 60
          whatsappAccounts: []
  messages:
    inbound:
      debounceMs: 0
successCriteria:
  - A direct qa-channel message from the simulated coworker carries a CFE image attachment with no client text/context.
  - The routed Solayre coworker agent asks for the client's phone/WhatsApp number or equivalent missing client context.
  - The agent does not claim a quote was sent.
  - The agent does not send or attach a quote PDF.
  - The coworker's sender id is not treated as the quote recipient/customer phone.
docsRefs:
  - docs/concepts/qa-e2e-automation.md
  - docs/channels/qa-channel.md
  - extensions/whatsapp-lead-bot/TESTING.md
codeRefs:
  - extensions/qa-lab/src/scenario-catalog.ts
  - extensions/qa-lab/src/suite-runtime-transport.ts
  - extensions/whatsapp-lead-bot/src/tools/process-lead-cfe-receipt.ts
  - extensions/whatsapp-lead-bot/src/tools/send-receipt-request.ts
execution:
  kind: flow
  summary: Simulate a coworker forwarding only a CFE receipt photo and verify the coworker flow asks for the missing client phone before attempting parse-and-quote delivery.
  config:
    requiredProviderMode: live-frontier
    conversationId: solayre-coworker-cfe-photo-no-context
    senderId: qa-coworker-no-context
    senderName: QA Coworker
```

```yaml qa-flow
steps:
  - name: coworker receipt photo with no client context asks for client phone
    actions:
      - if:
          expr: "env.providerMode !== config.requiredProviderMode"
          then:
            - assert: "true"
          else:
            - call: waitForGatewayHealthy
              args:
                - ref: env
                - 60000
            - call: waitForTransportReady
              args:
                - ref: env
                - 60000
            - call: resetTransport
            - set: conversationId
              value:
                expr: "`${config.conversationId}-${randomUUID().slice(0, 8)}`"
            - call: injectInboundMessage
              args:
                - accountId: default
                  conversation:
                    id:
                      expr: conversationId
                    kind: direct
                  senderId:
                    expr: config.senderId
                  senderName:
                    expr: config.senderName
                  text: ""
                  attachments:
                    - kind: image
                      mimeType: image/png
                      fileName: cfe-recibo-sin-cliente.png
                      altText: foto de recibo CFE reenviada sin telefono ni datos del cliente
                      contentBase64:
                        expr: imageUnderstandingValidPngBase64
            - call: waitForTransportOutboundMessage
              saveAs: outbound
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.conversation.id === conversationId && /(tel[eé]fono|n[uú]mero|whats\\s?app|contacto|cliente)/i.test(String(candidate.text ?? ''))"
                - expr: liveTurnTimeoutMs(env, 180000)
            - assert:
                expr: "!/(ya\\s+(se\\s+)?(envi[oó]|mand[eé])|cotizaci[oó]n\\s+(enviada|generada)|te\\s+env[ií]o\\s+la\\s+cotizaci[oó]n|list[oa],?\\s+.*cotizaci[oó]n)/i.test(String(outbound.text ?? ''))"
                message:
                  expr: "`expected no quote-sent claim, saw: ${outbound.text}`"
            - assert:
                expr: "!/(pdf|\\.pdf|cotizaci[oó]n\\s+adjunta|archivo\\s+adjunto|MEDIA:)/i.test(String(outbound.text ?? '')) && (!outbound.attachments || outbound.attachments.length === 0)"
                message:
                  expr: "`expected no quote PDF/media, saw text=${outbound.text} attachments=${JSON.stringify(outbound.attachments ?? [])}`"
            - assert:
                expr: "!String(outbound.text ?? '').includes(config.senderId)"
                message:
                  expr: "`coworker sender id appeared in reply as potential client phone: ${outbound.text}`"
    detailsExpr: "env.providerMode !== config.requiredProviderMode ? 'skipped outside live-frontier provider mode' : formatTransportTranscript(state, { conversationId })"
```
