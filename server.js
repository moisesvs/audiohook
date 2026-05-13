/**
 * AudioHook Monitor Server
 * Implementa el protocolo AudioHook de Genesys Cloud.
 * Genesys Cloud actúa como CLIENTE y conecta a este servidor (wss://tu-host/audiohook).
 *
 * Documentación: https://developer.genesys.cloud/devapps/audiohook/
 *
 * Arrancar: node server.js
 * Variables de entorno:
 *   PORT          Puerto HTTP/WS (default: 3001)
 *   API_KEY       Clave que debe enviar Genesys en la cabecera X-API-KEY (default: "changeme")
 */

const http    = require('http');
const { WebSocketServer } = require('ws');
const crypto  = require('crypto');

const PORT    = process.env.PORT    || 3001;
const API_KEY = process.env.API_KEY || 'changeme';

// ── Servidor HTTP base ──────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // Health check para proxies / load balancers
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', activeSessions: sessions.size }));
    return;
  }

  // Lista de sesiones activas
  if (req.url === '/sessions') {
    const list = [...sessions.values()].map(s => ({
      sessionId:      s.sessionId,
      conversationId: s.conversationId,
      orgId:          s.orgId,
      state:          s.state,
      participant:    s.participant,
      mediaFormat:    s.mediaFormat,
      audioKB:        (s.audioBytes / 1024).toFixed(1),
      durationSec:    ((Date.now() - s.startedAt) / 1000).toFixed(1),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: list.length, sessions: list }, null, 2));
    return;
  }

  res.writeHead(404);
  res.end();
});

// ── Mapa de sesiones activas ────────────────────────────────────────────────
// sessionId → { ws, orgId, conversationId, participant, mediaFormat, seq, serverseq, startedAt }
const sessions = new Map();

// ── Servidor WebSocket ──────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server: httpServer,
  path: '/audiohook',
  // Verificar la API key durante el handshake HTTP
  verifyClient: (info, cb) => {
    const apiKey = info.req.headers['x-api-key'];
    if (!apiKey || apiKey !== API_KEY) {
      console.warn(`[AudioHook] Conexión rechazada — API key inválida (${info.req.socket.remoteAddress})`);
      return cb(false, 401, 'Unauthorized');
    }
    cb(true);
  },
});

wss.on('connection', (ws, req) => {
  const orgId     = req.headers['audiohook-organization-id'] || '?';
  const sessionId = req.headers['audiohook-session-id']      || crypto.randomUUID();
  const corrId    = req.headers['audiohook-correlation-id']  || '?';

  console.log(`[AudioHook] ▶ Nueva conexión sesión=${sessionId.slice(0,8)}… org=${orgId.slice(0,8)}…`);

  const session = {
    ws,
    sessionId,
    orgId,
    corrId,
    conversationId: null,
    participant: null,
    mediaFormat: null,
    seq: 0,          // próximo seq de mensaje del servidor
    clientseq: 0,    // último seq recibido del cliente
    startedAt: Date.now(),
    audioBytes: 0,
    state: 'connecting', // connecting | open | paused | closing | closed
  };
  sessions.set(sessionId, session);

  // ── Mensajes de texto (JSON del protocolo) ──────────────────────────────
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Trama de audio binario (PCMU, headerless)
      session.audioBytes += data.byteLength;
      // Aquí puedes procesar / reenviar el audio a un servicio externo (p.ej. transcripción)
      return;
    }

    let msg;
    try { msg = JSON.parse(data); } catch (e) {
      console.error(`[${sessionId.slice(0,8)}] JSON inválido:`, data.toString().slice(0, 200));
      return;
    }

    session.clientseq = msg.seq ?? session.clientseq;

    switch (msg.type) {

      case 'open': {
        session.conversationId = msg.parameters?.conversationId ?? null;
        session.participant    = msg.parameters?.participant    ?? null;
        session.state          = 'open';

        // Elegir el primer formato de media ofrecido
        const offered = msg.parameters?.media || [];
        session.mediaFormat = offered[0] ?? null;

        console.log(`[${sessionId.slice(0,8)}] open  conv=${session.conversationId?.slice(0,8)}… lang=${msg.parameters?.language}`);

        // Responder con 'opened' seleccionando el primer formato ofrecido
        send(session, 'opened', {
          startPaused: false,
          media: session.mediaFormat ? [session.mediaFormat] : [],
        });
        break;
      }

      case 'ping': {
        send(session, 'pong', { rtt: msg.parameters?.rtt ?? null });
        break;
      }

      case 'close': {
        session.state = 'closing';
        const durationSec = ((Date.now() - session.startedAt) / 1000).toFixed(1);
        console.log(`[${sessionId.slice(0,8)}] close  dur=${durationSec}s  audio=${(session.audioBytes / 1024).toFixed(1)}KB`);
        send(session, 'closed', {});
        session.state = 'closed';
        sessions.delete(sessionId);
        break;
      }

      case 'update': {
        console.log(`[${sessionId.slice(0,8)}] update lang=${msg.parameters?.language}`);
        send(session, 'updated', {});
        break;
      }

      case 'pause': {
        session.state = 'paused';
        send(session, 'paused', {});
        break;
      }

      case 'resume': {
        session.state = 'open';
        send(session, 'resumed', {});
        break;
      }

      case 'disconnect': {
        console.log(`[${sessionId.slice(0,8)}] disconnect reason=${msg.parameters?.reason}`);
        sessions.delete(sessionId);
        break;
      }

      default:
        console.log(`[${sessionId.slice(0,8)}] msg desconocido type=${msg.type}`);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[${sessionId.slice(0,8)}] ✖ WebSocket cerrado code=${code} reason=${reason?.toString()}`);
    sessions.delete(sessionId);
  });

  ws.on('error', (err) => {
    console.error(`[${sessionId.slice(0,8)}] error:`, err.message);
    sessions.delete(sessionId);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function send(session, type, parameters) {
  session.seq++;
  const msg = {
    version:   '2',
    type,
    seq:       session.seq,
    clientseq: session.clientseq,
    id:        session.sessionId,
    parameters,
  };
  try { session.ws.send(JSON.stringify(msg)); } catch (e) {
    console.error(`[${session.sessionId.slice(0,8)}] send error:`, e.message);
  }
}

// ── Arrancar ─────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n┌─────────────────────────────────────────────────────┐`);
  console.log(`│  AudioHook Monitor Server                           │`);
  console.log(`│                                                     │`);
  console.log(`│  Puerto local : http://localhost:${PORT}               │`);
  console.log(`│  Endpoint WS  : ws://localhost:${PORT}/audiohook       │`);
  console.log(`│  Health check : http://localhost:${PORT}/health        │`);
  console.log(`│  Sesiones     : http://localhost:${PORT}/sessions      │`);
  console.log(`│                                                     │`);
  console.log(`│  Cuando expongas el servidor públicamente           │`);
  console.log(`│  configura en Genesys:                              │`);
  console.log(`│    URI: wss://<tu-dominio>/audiohook                │`);
  console.log(`│    API Key: ${API_KEY.padEnd(40)}│`);
  console.log(`└─────────────────────────────────────────────────────┘\n`);
});
