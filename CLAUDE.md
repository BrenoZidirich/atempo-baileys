# ATEMPO Baileys (gateway WhatsApp)

> Sub-contexto: ver `../CLAUDE.md` para visão global.

## O que é

Servidor Node.js que faz a ponte WhatsApp ↔ `atempo-server`:
- Mantém uma sessão Baileys por negócio (`salon_id`)
- Recebe mensagens novas, faz POST para `atempo-server` `/v1/messages/incoming`
- Recebe respostas via API REST e envia pelo WA do cliente
- Serve QR code via HTTP para a dona escanear no iPhone

## Stack

- Node.js 20
- `@whiskeysockets/baileys`
- Express (API REST interna)
- Auth files em `auth/{salon_id}/` (não versionados)

## Repo

`BrenoZidirich/atempo-baileys` — independente do ATEMPO. Sem auto-deploy.

**Atenção:** o `/opt/atempo-baileys` no servidor **NÃO é um checkout git** — é uma pasta sincronizada por **rsync** (a doc antiga dizia `git pull`, mas falha com "not a git repository"). Para deployar:

```bash
# 1. commit local (controlo de versão)
cd ~/Documents/ATEMPO/baileys && git add server.js && git commit -m "..." && git push
# 2. sincronizar para o servidor + reiniciar
rsync -az server.js root@46.225.184.142:/opt/atempo-baileys/server.js
ssh root@46.225.184.142 "systemctl restart atempo-baileys"
```

## Onde corre

Servidor Hetzner em `/opt/atempo-baileys/`. Escuta em `http://localhost:3001/` (systemd: `ExecStart=/usr/bin/node server.js`, `WorkingDirectory=/opt/atempo-baileys`). Liga ao servidor Python em `http://localhost:8000` (`ATEMPO_URL`).

## Atenção

- A pasta `auth/` no servidor tem credenciais de WhatsApp dos clientes. **Backup é crítico** (cada salon que reconecta = onboarding novo, dor).
- Sessões podem cair se o WhatsApp do telefone do cliente for desinstalado / mudado.
