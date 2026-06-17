---
summary: "OpenClaw WhatsApp channel plugin for WhatsApp Web chats."
read_when:
  - You are installing, configuring, or auditing the whatsapp plugin
title: "WhatsApp plugin"
---

# WhatsApp plugin

OpenClaw WhatsApp channel plugin for WhatsApp Web chats.

## Distribution

- Package: `@openclaw/whatsapp`
- Install route: ClawHub: `clawhub:@openclaw/whatsapp`; npm

## Surface

channels: whatsapp

## Windows install note

On Windows, the WhatsApp plugin needs Git on `PATH` during npm install because one of its Baileys/libsignal dependencies is fetched from a git URL. Install Git for Windows, then restart the shell and rerun the install:

```powershell
winget install --id Git.Git -e
```

Portable Git also works if its `bin` directory is on `PATH`.

## Related docs

- [whatsapp](/channels/whatsapp)
