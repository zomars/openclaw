# Solayre no receipt follow-up

```yaml qa-scenario
id: solayre-no-receipt-followup
title: Solayre handles lead without receipt softly
surface: channel
category: solayre
coverage:
  primary:
    - solayre.receipt-request
  secondary:
    - solayre.lead-qualification
    - channels.qa-channel
risk: medium
objective: Verify Solayre asks for a CFE receipt once and responds softly when the qualified lead does not have it available yet.
plugins:
  - whatsapp-lead-bot
gatewayConfigPatch:
  agents:
    list:
      - id: solayre-leads-dev
        name: Solayre Leads Dev
        default: true
        workspace: /Users/zomars/.openclaw/workspace-solayre-leads-dev
        model:
          primary: openai-codex/gpt-5.4-mini
        thinkingDefault: off
        reasoningDefault: off
        skills: []
        sandbox: { mode: off }
        tools:
          profile: messaging
          alsoAllow: [image, media, group:plugins]
          deny:
            [
              process,
              nodes,
              web_search,
              web_fetch,
              browser,
              apply_patch,
              exec,
              sessions_list,
              sessions_history,
              sessions_send,
              sessions_spawn,
              agent_to_agent,
              cron,
              whatsapp_history_fetch,
            ]
  plugins:
    entries:
      whatsapp-lead-bot:
        enabled: true
        config:
          agentId: solayre-leads-dev
          agentNumbers: ["5216672350818", "5216672178748"]
          dbPath: /Users/zomars/.openclaw/workspace-solayre-leads-dev/data/leads.db
          dryRunPrefixes: ["+00000", lead-, sim-]
          followup: { enabled: false }
successCriteria:
  - First qualified message triggers a CFE receipt request.
  - Follow-up message saying the receipt is not available does not trigger a quote.
  - Agent keeps the conversation open without pressuring the lead.
docsRefs:
  - docs/concepts/qa-e2e-automation.md
  - docs/channels/qa-channel.md
  - extensions/whatsapp-lead-bot/TESTING.md
codeRefs:
  - extensions/whatsapp-lead-bot/src/messages/receipt-request-template.ts
execution:
  kind: flow
  summary: Simulate qualified lead who cannot provide the receipt immediately.
  config:
    requiredProviderMode: live-frontier
    conversationId: solayre-no-receipt-followup
    senderId: lead-no-receipt
    firstMessage: "Hola, soy dueño de casa en Los Mochis y pago 3200 pesos bimestrales de luz"
    secondMessage: "No tengo el recibo a la mano ahorita"
```

```yaml qa-flow
steps:
  - name: asks once then keeps soft follow-up
    actions:
      - if:
          expr: "env.providerMode !== config.requiredProviderMode"
          then:
            - assert: "true"
          else:
            - call: waitForGatewayHealthy
              args: [{ ref: env }, 60000]
            - call: waitForTransportReady
              args: [{ ref: env }, 60000]
            - call: resetTransport
            - set: leadId
              value:
                expr: "`${config.senderId}-${randomUUID().slice(0, 8)}`"
            - call: injectInboundMessage
              args:
                - conversation:
                    id: { expr: leadId }
                    kind: direct
                  senderId: { expr: leadId }
                  senderName: Lead No Receipt
                  text: { expr: config.firstMessage }
            - call: waitForTransportOutboundMessage
              saveAs: receiptRequest
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.conversation.id === leadId && /recibo|CFE/i.test(String(candidate.text ?? ''))"
                - expr: liveTurnTimeoutMs(env, 180000)
            - set: beforeSecondCount
              value:
                expr: "state.getSnapshot().messages.length"
            - call: injectInboundMessage
              args:
                - conversation:
                    id: { expr: leadId }
                    kind: direct
                  senderId: { expr: leadId }
                  senderName: Lead No Receipt
                  text: { expr: config.secondMessage }
            - call: waitForTransportOutboundMessage
              saveAs: softReply
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: 'candidate.conversation.id === leadId && state.getSnapshot().messages.indexOf(candidate) >= beforeSecondCount && !/\$\s?\d{2,}|\bpanel(?:es)?\b.*\$|cotizaci[oó]n.*\$/i.test(String(candidate.text ?? ""))'
                - expr: liveTurnTimeoutMs(env, 180000)
    detailsExpr: "env.providerMode !== config.requiredProviderMode ? 'skipped outside live-frontier provider mode' : formatTransportTranscript(state, { conversationId: leadId })"
```
