# Solayre hot lead CFE request

```yaml qa-scenario
id: solayre-hot-lead-cfe-request
title: Solayre hot lead receives CFE request
surface: channel
category: solayre
coverage:
  primary:
    - solayre.lead-qualification
  secondary:
    - solayre.receipt-request
    - channels.qa-channel
risk: medium
objective: Verify Solayre qualifies a high-consumption Sinaloa homeowner and asks for a CFE receipt before quoting.
plugins:
  - whatsapp-lead-bot
gatewayConfigPatch:
  agents:
    defaults:
      workspace: /Users/zomars/.openclaw/workspace
    list:
      - id: solayre-leads-dev
        name: Solayre Leads Dev
        default: true
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
            - "5216672350818"
            - "5216672178748"
          dbPath: /Users/zomars/.openclaw/workspace-solayre-leads-dev/data/leads.db
          dryRunPrefixes:
            - "+00000"
            - lead-
            - sim-
          followup:
            enabled: false
          rateLimit:
            messagesPerHour: 60
          whatsappAccounts: []
          coworkerAgentId: solayre-leads-dev
  messages:
    inbound:
      debounceMs: 0
successCriteria:
  - Lead message is delivered through qa-channel as a direct conversation.
  - Solayre agent replies in the same direct transcript.
  - Reply requests a CFE receipt and does not quote from the declared bill amount alone.
docsRefs:
  - docs/concepts/qa-e2e-automation.md
  - docs/channels/qa-channel.md
  - extensions/whatsapp-lead-bot/TESTING.md
codeRefs:
  - extensions/qa-lab/src/scenario-catalog.ts
  - extensions/qa-lab/src/suite-runtime-transport.ts
  - extensions/whatsapp-lead-bot/src/messages/receipt-request-template.ts
execution:
  kind: flow
  summary: Simulate a qualified Culiacán homeowner and verify the canonical CFE receipt request.
  config:
    requiredProviderMode: live-frontier
    conversationId: solayre-hot-lead-cfe-request
    senderId: lead-hot-cfe-request
    leadMessage: "Hola, vivo en Culiacán, la casa es mía y pago como 2800 de luz bimestral"
    expectedAny:
      - "recibo de CFE"
      - "recibo"
      - "CFE"
```

```yaml qa-flow
steps:
  - name: qualified lead gets CFE request
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
            - set: leadId
              value:
                expr: "`${config.senderId}-${randomUUID().slice(0, 8)}`"
            - call: injectInboundMessage
              args:
                - conversation:
                    id:
                      expr: leadId
                    kind: direct
                  senderId:
                    expr: leadId
                  senderName: Lead Hot
                  text:
                    expr: config.leadMessage
            - call: waitForTransportOutboundMessage
              saveAs: outbound
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.conversation.id === leadId && config.expectedAny.some((text) => String(candidate.text ?? '').toLowerCase().includes(text.toLowerCase()))"
                - expr: liveTurnTimeoutMs(env, 180000)
            - assert:
                expr: '!/\$\s?\d{2,}|\bpanel(?:es)?\b.*\$|cotizaci[oó]n.*\$/i.test(String(outbound.text ?? ""))'
                message:
                  expr: "`expected receipt request without quoting prices, saw: ${outbound.text}`"
    detailsExpr: "env.providerMode !== config.requiredProviderMode ? 'skipped outside live-frontier provider mode' : outbound.text"
```
