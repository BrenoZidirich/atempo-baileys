# ATEMPO Baileys Gateway

Microserviço Node.js que faz a ponte entre **WhatsApp Web** e o servidor Python do ATEMPO.

Funciona como uma "extensão WhatsApp Web" — sem necessidade de Android, sem Meta Business API,
sem mudar o número da dona do salão.

## Fluxo

1. Dona abre o dashboard no iPhone → mostra um QR code
2. Escaneia o QR pelo WhatsApp do iPhone (Definições → Dispositivos ligados)
3. Servidor Baileys autentica-se como dispositivo ligado
4. Cada mensagem nova → enviada para o servidor Python → IA Groq → resposta volta pelo Baileys

## Deploy no Render

### 1. Criar repositório no GitHub

```bash
cd /Users/brenozidirich/Documents/atempo-baileys
git add -A
git commit -m "ATEMPO Baileys gateway — initial commit"
gh repo create atempo-baileys --public --source=. --push
```

### 2. Criar serviço no Render

- Dashboard Render → **New +** → **Web Service**
- Connect repo: `BrenoZidirich/atempo-baileys`
- Render lê o `render.yaml` automaticamente:
  - Runtime: Node
  - Build: `npm install`
  - Start: `npm start`
  - Health check: `/health`

### 3. Variáveis de ambiente

| Chave | Valor |
|-------|-------|
| `ATEMPO_URL` | `https://atempo-pc0w.onrender.com` |
| `NODE_VERSION` | `20` |

### 4. Disco persistente

Para as sessões WhatsApp não se perderem em cada deploy, adicionar disco:
- Path: `/opt/render/project/src/auth`
- Tamanho: 1 GB (~€1/mês)

**Sem disco** o serviço funciona, mas a dona terá de re-escanear o QR sempre que houver deploy.

### 5. Apontar o servidor Python ao Baileys

No serviço Python (`ATEMPO`), adicionar env var:

```
BAILEYS_URL=https://atempo-baileys.onrender.com
```

## Endpoints

- `GET  /health` — ping
- `GET  /qr?salonId=X` — devolve QR (se não autenticado) ou status `open`
- `GET  /status?salonId=X` — estado actual sem gerar QR
- `POST /logout?salonId=X` — desliga e apaga credenciais
- `POST /send` — body `{salonId, to, text}` — envia mensagem manual

## Multi-tenant

Cada salão tem a sua pasta `auth/{salonId}/` com as credenciais.
Um único processo serve N salões em paralelo.

## Reconexão

Se o WhatsApp desconectar (rede instável, restart…), o serviço tenta reconectar
sozinho ao fim de 3s. Se a dona fizer logout manualmente do iPhone, as
credenciais são apagadas e na próxima vez aparece novo QR.
