/**
 * ATEMPO Baileys Gateway
 * ─────────────────────────────────────────────────────────
 * Pontes entre o WhatsApp e o servidor Python do ATEMPO.
 *
 * Fluxo:
 *   1. Dona abre dashboard no iPhone → GET /qr?salonId=X
 *   2. Página mostra QR code → ela escaneia pelo WhatsApp do iPhone
 *   3. Sessão Baileys autenticada → recebe mensagens em tempo real
 *   4. Para cada mensagem nova:
 *        a. POST → ATEMPO Python /v1/messages/incoming
 *        b. Python responde com texto da IA
 *        c. Baileys envia para o WhatsApp da cliente
 *
 * Multi-tenant: cada salão tem a sua pasta auth/{salonId}/ com
 * as credenciais. Reconecta sozinho após reboot.
 *
 * Dependências mínimas — corre em qualquer Render free tier.
 */

import express from "express";
import QRCode from "qrcode";
import pino from "pino";
import fetch from "node-fetch";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
} from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const ATEMPO_URL = process.env.ATEMPO_URL || "https://atempo-pc0w.onrender.com";
const INTERNAL_KEY = process.env.ATEMPO_INTERNAL_KEY || "";
const AUTH_DIR = path.join(__dirname, "auth");

const log = pino({ level: "info", transport: undefined });

// Sessões activas por salonId.
//   { sock: WASocket, qrDataUrl: string|null, status: "qr"|"connecting"|"open"|"closed" }
const sessions = new Map();

// ─────────────────────────────────────────────────────────
// Baileys session lifecycle
// ─────────────────────────────────────────────────────────

async function startSession(salonId) {
  if (sessions.has(salonId)) {
    const existing = sessions.get(salonId);
    if (existing.status === "open" || existing.status === "connecting") {
      return existing;
    }
  }

  const sessionDir = path.join(AUTH_DIR, salonId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["ATEMPO", "Chrome", "1.0"],
    syncFullHistory: true,
    markOnlineOnConnect: false,
  });

  const session = {
    sock,
    qrDataUrl: null,
    status: "connecting",
    connectedAt: null,
    lastError: null,
    // IDs de mensagens que o BOT enviou — para não as confundir com a voz do
    // dono quando reaparecem em messages.upsert como fromMe.
    botSentIds: new Set(),
  };
  sessions.set(salonId, session);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qrDataUrl = await QRCode.toDataURL(qr, {
        margin: 2,
        width: 300,
        color: { dark: "#0A0A0A", light: "#F5F1EA" },
      });
      session.status = "qr";
      log.info(`[${salonId}] QR code gerado`);
    }

    if (connection === "open") {
      session.status = "open";
      session.qrDataUrl = null;
      session.connectedAt = new Date().toISOString();
      log.info(`[${salonId}] ✅ ligado ao WhatsApp`);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode
                  ?? lastDisconnect?.error?.statusCode
                  ?? null;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      session.status = "closed";
      session.lastError = reason;
      log.warn(`[${salonId}] desligado (reason=${reason}, reconnect=${shouldReconnect})`);
      sessions.delete(salonId);
      if (shouldReconnect) {
        setTimeout(() => startSession(salonId), 3000);
      } else {
        // Logged out — limpa credenciais para forçar novo QR
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  });

  sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, isLatest }) => {
    try {
      if (!messages || messages.length === 0) return;
      log.info(`[${salonId}] 📚 Histórico de mensagens recebido (${messages.length} mensagens)`);
      const ownerTexts = [];
      // Reverter as mensagens para ficarem em ordem cronológica (mais antiga para mais recente)
      // pois o WhatsApp envia em ordem reversa (mais recente primeiro)
      const sortedMessages = messages.slice().reverse();
      for (const m of sortedMessages) {
        if (m.key.fromMe) {
          // Filtrar mensagens enviadas pelo próprio bot (seus IDs conhecidos nesta sessão)
          if (m.key.id && session.botSentIds.has(m.key.id)) {
            continue;
          }
          const text =
            m.message?.conversation ||
            m.message?.extendedTextMessage?.text ||
            null;
          if (text && text.trim().length >= 3 && text.trim().length <= 600) {
            ownerTexts.push(text.trim());
          }
        }
      }

      if (ownerTexts.length === 0) return;

      log.info(`[${salonId}] 📚 Enviando ${ownerTexts.length} mensagens históricas para análise de voz...`);
      const headers = { "Content-Type": "application/json" };
      if (INTERNAL_KEY) headers["X-Internal-Key"] = INTERNAL_KEY;
      
      const res = await fetch(`${ATEMPO_URL}/v1/messages/outgoing/bulk`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          salonId,
          messages: ownerTexts,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        log.info(`[${salonId}] 📚 Sincronizadas ${data.added} novas mensagens de histórico (Total no buffer: ${data.count})`);
      } else {
        log.error(`[${salonId}] 📚 Erro ao enviar lote de histórico: status ${res.status}`);
      }
    } catch (e) {
      log.error({ err: e.message }, `[${salonId}] history sync handling failed`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        if (m.key.fromMe) {
          // Mensagem enviada pela conta do dono — pode ser ele a escrever
          // (voz a aprender) ou o próprio bot (a ignorar).
          await handleOwnerOutgoing(salonId, session, m);
        } else {
          await handleIncoming(salonId, session, m);
        }
      } catch (e) {
        log.error({ err: e.message }, `[${salonId}] upsert failed`);
      }
    }
  });

  return session;
}

// ─────────────────────────────────────────────────────────
// Mensagem recebida → ATEMPO Python → resposta
// ─────────────────────────────────────────────────────────

async function handleIncoming(salonId, session, m) {
  const sock = session.sock;
  // Ignora as nossas próprias mensagens, grupos, canais/newsletters, broadcasts e status.
  // Só respondemos a conversas pessoais 1:1 (clientes reais).
  if (m.key.fromMe) return;
  const jid = m.key.remoteJid || "";
  if (
    jid.endsWith("@g.us") ||         // grupos
    jid.endsWith("@newsletter") ||   // canais
    jid.endsWith("@broadcast") ||    // listas de difusão / status
    jid === "status@broadcast"
  ) return;

  const text =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    null;

  // Nota de voz: descarrega o áudio para o ATEMPO transcrever (Whisper).
  let audioBase64 = null, audioMime = null;
  const audioMsg = m.message?.audioMessage;
  if ((!text || !text.trim()) && audioMsg) {
    try {
      const stream = await downloadContentFromMessage(audioMsg, "audio");
      let buf = Buffer.from([]);
      for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
      audioBase64 = buf.toString("base64");
      audioMime = audioMsg.mimetype || "audio/ogg";
      log.info(`[${salonId}] 🎤 nota de voz recebida (${buf.length} bytes)`);
    } catch (e) {
      log.warn(`[${salonId}] falha a descarregar áudio: ${e.message}`);
    }
  }

  // Imagem (ex.: comprovativo de pagamento): descarrega para o ATEMPO ler com visão.
  let imageBase64 = null, imageMime = null;
  const imgMsg = m.message?.imageMessage;
  if (imgMsg) {
    try {
      const stream = await downloadContentFromMessage(imgMsg, "image");
      let buf = Buffer.from([]);
      for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
      imageBase64 = buf.toString("base64");
      imageMime = imgMsg.mimetype || "image/jpeg";
      log.info(`[${salonId}] 🖼️ imagem recebida (${buf.length} bytes)`);
    } catch (e) {
      log.warn(`[${salonId}] falha a descarregar imagem: ${e.message}`);
    }
  }

  if ((!text || !text.trim()) && !audioBase64 && !imageBase64) return;  // nada de útil

  const remoteJid = m.key.remoteJid;
  const contactName = m.pushName || remoteJid.split("@")[0];

  log.info(`[${salonId}] 📨 ${contactName}: ${text || (imageBase64 ? "[imagem]" : "[áudio]")}`);

  // Indicador "a escrever..." enquanto a IA pensa — toque humano
  try { await sock.sendPresenceUpdate("composing", remoteJid); } catch {}

  const headers = { "Content-Type": "application/json" };
  if (INTERNAL_KEY) headers["X-Internal-Key"] = INTERNAL_KEY;
  const res = await fetch(`${ATEMPO_URL}/v1/messages/incoming`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      salonId,
      contactName,
      contactJid: remoteJid,
      text: text || "",
      audioBase64,
      audioMime,
      imageBase64,
      imageMime,
      timestamp: Math.floor(Date.now() / 1000),
    }),
  });

  if (!res.ok) {
    log.error(`[${salonId}] ATEMPO respondeu ${res.status}`);
    try { await sock.sendPresenceUpdate("paused", remoteJid); } catch {}
    return;
  }

  const data = await res.json();
  const reply = data.reply;

  if (data.pending) {
    log.info(`[${salonId}] ⏸ pending approval — não envia`);
    try { await sock.sendPresenceUpdate("paused", remoteJid); } catch {}
    return;
  }

  if (!reply || !reply.trim()) {
    try { await sock.sendPresenceUpdate("paused", remoteJid); } catch {}
    return;
  }

  // Delay humano (0.8s + ~30ms por caractere, máx 6s) — sente-se como pessoa
  const typingDelay = Math.min(800 + reply.length * 30, 6000);
  if (data.audioReplyBase64) {
    try { await sock.sendPresenceUpdate("recording", remoteJid); } catch {}
  }
  await new Promise((r) => setTimeout(r, typingDelay));

  try { await sock.sendPresenceUpdate("paused", remoteJid); } catch {}

  let sent;
  if (data.audioReplyBase64) {
    // Responde com nota de voz (ogg/opus do TTS) — espelha o áudio do cliente
    const audioBuf = Buffer.from(data.audioReplyBase64, "base64");
    sent = await sock.sendMessage(remoteJid, {
      audio: audioBuf, ptt: true, mimetype: "audio/ogg; codecs=opus",
    });
    log.info(`[${salonId}] 🔊 resposta em áudio enviada (${audioBuf.length} bytes)`);
  } else {
    sent = await sock.sendMessage(remoteJid, { text: reply });
    log.info(`[${salonId}] ✉️ enviado: ${reply.slice(0, 60)}…`);
  }
  // Marca este id como "foi o bot" para o handleOwnerOutgoing o ignorar quando
  // reaparecer como fromMe (senão a assistente aprenderia consigo própria).
  if (sent?.key?.id) {
    session.botSentIds.add(sent.key.id);
    if (session.botSentIds.size > 500) session.botSentIds.clear();
  }
}

// ─────────────────────────────────────────────────────────
// Mensagem do PRÓPRIO dono → ATEMPO Python (aprender a voz)
// ─────────────────────────────────────────────────────────

async function handleOwnerOutgoing(salonId, session, m) {
  const remoteJid = m.key.remoteJid || "";
  if (remoteJid.endsWith("@g.us")) return;  // ignora grupos
  
  // Ignora mensagens enviadas para si próprio
  const me = session.sock.user?.id || "";
  const myNum = me.split(":")[0].split("@")[0];
  const targetNum = remoteJid.split("@")[0];
  if (myNum && targetNum === myNum) return;

  const id = m.key.id;
  if (id && session.botSentIds.has(id)) {           // foi o bot, não o dono
    session.botSentIds.delete(id);
    return;
  }
  const text =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    null;
  if (!text || !text.trim()) return;

  const headers = { "Content-Type": "application/json" };
  if (INTERNAL_KEY) headers["X-Internal-Key"] = INTERNAL_KEY;
  try {
    await fetch(`${ATEMPO_URL}/v1/messages/outgoing`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        salonId,
        text: text.trim(),
        contactName: m.pushName || "",
        contactJid: remoteJid,
        timestamp: Math.floor(Date.now() / 1000),
      }),
    });
  } catch (e) {
    log.warn(`[${salonId}] captura de voz falhou: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────
// HTTP API
// ─────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// Middleware — protege todos os endpoints excepto /health
function requireInternal(req, res, next) {
  if (!INTERNAL_KEY) return next();  // legacy mode
  const key = req.header("x-internal-key");
  if (!key || key !== INTERNAL_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/health", (_, res) => res.json({ ok: true, sessions: sessions.size }));

// Tudo abaixo exige X-Internal-Key (se configurada)
app.use(requireInternal);

/** Cria/recupera sessão e devolve QR (se ainda não autenticada). */
app.get("/qr", async (req, res) => {
  const salonId = req.query.salonId || "default";
  let session = sessions.get(salonId);
  if (!session) {
    session = await startSession(salonId);
  }
  // Pequeno wait para o QR ser gerado se for primeira vez
  for (let i = 0; i < 20 && !session.qrDataUrl && session.status !== "open"; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  res.json({
    salonId,
    status: session.status,
    qr: session.qrDataUrl,
    connectedAt: session.connectedAt,
  });
});

/** Estado actual sem gerar QR. */
app.get("/status", (req, res) => {
  const salonId = req.query.salonId || "default";
  const session = sessions.get(salonId);
  if (!session) return res.json({ salonId, status: "not_started" });
  res.json({
    salonId,
    status: session.status,
    connectedAt: session.connectedAt,
    hasQr: !!session.qrDataUrl,
  });
});

/** Desliga sessão (logout completo — exige novo QR para reactivar). */
app.post("/logout", async (req, res) => {
  const salonId = req.query.salonId || req.body?.salonId || "default";
  const session = sessions.get(salonId);
  if (!session) return res.json({ ok: false, error: "no_session" });
  try {
    await session.sock.logout();
  } catch {}
  sessions.delete(salonId);
  const dir = path.join(AUTH_DIR, salonId);
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

/** Envia mensagem manualmente (útil para o dashboard fazer takeover). */
app.post("/send", async (req, res) => {
  const { salonId = "default", to, text } = req.body || {};
  const session = sessions.get(salonId);
  if (!session || session.status !== "open") {
    return res.status(400).json({ ok: false, error: "not_connected" });
  }
  try {
    // "self" → o próprio número (notificação "Mensagem para mim" da gestora).
    let jid;
    if (to === "self") {
      const me = session.sock.user?.id || "";
      const num = me.split(":")[0].split("@")[0];
      if (!num) return res.status(400).json({ ok: false, error: "no_self_jid" });
      jid = `${num}@s.whatsapp.net`;
    } else {
      jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    }
    await session.sock.sendMessage(jid, { text });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// Boot — restaura sessões já autenticadas
// ─────────────────────────────────────────────────────────

async function restoreSavedSessions() {
  if (!fs.existsSync(AUTH_DIR)) return;
  const dirs = fs.readdirSync(AUTH_DIR).filter((d) => {
    const full = path.join(AUTH_DIR, d);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "creds.json"));
  });
  for (const salonId of dirs) {
    log.info(`a restaurar sessão: ${salonId}`);
    startSession(salonId).catch((e) =>
      log.error({ err: e.message }, `restore failed: ${salonId}`)
    );
  }
}

app.listen(PORT, async () => {
  log.info(`ATEMPO Baileys gateway → port ${PORT}`);
  log.info(`ATEMPO_URL = ${ATEMPO_URL}`);
  await restoreSavedSessions();
});
