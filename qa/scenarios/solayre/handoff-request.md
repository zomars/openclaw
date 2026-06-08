# Solayre handoff request

```yaml qa-scenario
id: solayre-handoff-request
title: Solayre hands off visit request
surface: channel
category: solayre
coverage:
  primary:
    - solayre.handoff
  secondary:
    - solayre.lead-qualification
    - channels.qa-channel
risk: medium
objective: Verify Solayre hands qualified visit requests to a human instead of trying to schedule manually.
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
  - Lead asks for a visit or human contact.
  - Customer receives the canonical handoff acknowledgement.
  - Agent does not expose internal coworker routing details to the customer.
docsRefs:
  - docs/concepts/qa-e2e-automation.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/whatsapp-lead-bot/src/messages/handoff-template.ts
execution:
  kind: flow
  summary: Simulate a qualified homeowner requesting a visit and verify handoff acknowledgement.
  config:
    requiredProviderMode: live-frontier
    conversationId: solayre-handoff-request
    senderId: lead-handoff
    leadMessage: "Tengo casa propia en Culiacán, pago 3500 bimestral y quiero que venga un asesor a revisar mi casa"
    expectedText: "Con gusto, en breve le comunicaremos con un asesor para coordinar los detalles."
```

```yaml qa-flow
steps:
  - name: visit request gets canonical handoff acknowledgement
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
                  senderName: Lead Handoff
                  text: { expr: config.leadMessage }
            - call: waitForTransportOutboundMessage
              saveAs: outbound
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.conversation.id === leadId && String(candidate.text ?? '').includes(config.expectedText)"
                - expr: liveTurnTimeoutMs(env, 180000)
            - assert:
                expr: "!/Ale|Aleyda|coworker|interno/i.test(String(outbound.text ?? ''))"
                message:
                  expr: "`customer-facing handoff leaked internal routing details: ${outbound.text}`"
    detailsExpr: "env.providerMode !== config.requiredProviderMode ? 'skipped outside live-frontier provider mode' : outbound.text"
```
