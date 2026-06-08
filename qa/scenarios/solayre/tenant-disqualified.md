# Solayre tenant disqualification

```yaml qa-scenario
id: solayre-tenant-disqualified
title: Solayre tenant is disqualified
surface: channel
category: solayre
coverage:
  primary:
    - solayre.disqualification
  secondary:
    - solayre.lead-qualification
    - channels.qa-channel
risk: medium
objective: Verify Solayre disqualifies a renter because installation requires the property owner.
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
  - Tenant is not advanced to receipt collection.
  - Tenant receives the canonical property-owner disqualification message.
docsRefs:
  - docs/concepts/qa-e2e-automation.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/whatsapp-lead-bot/src/messages/disqualification-template.ts
execution:
  kind: flow
  summary: Simulate a renter with high bill and verify canonical tenant disqualification.
  config:
    requiredProviderMode: live-frontier
    conversationId: solayre-tenant-disqualified
    senderId: lead-tenant
    leadMessage: "Estoy en Mazatlán, pago 3000 bimestral pero la casa es rentada"
    expectedText: "La instalación requiere ser propietario del inmueble. Le sugiero comentarlo con el dueño."
```

```yaml qa-flow
steps:
  - name: tenant gets canonical disqualification
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
                  senderName: Lead Tenant
                  text: { expr: config.leadMessage }
            - call: waitForTransportOutboundMessage
              saveAs: outbound
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.conversation.id === leadId && String(candidate.text ?? '').includes(config.expectedText)"
                - expr: liveTurnTimeoutMs(env, 180000)
    detailsExpr: "env.providerMode !== config.requiredProviderMode ? 'skipped outside live-frontier provider mode' : outbound.text"
```
