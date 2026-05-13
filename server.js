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

function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}]`, ...args);
}

// ── Servidor HTTP base ──────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  log('HTTP', `${req.method} ${req.url} from=${req.socket.remoteAddress}`);
  log('HTTP', `  headers: ${JSON.stringify(req.headers)}`);

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

// Log de upgrades WebSocket antes del handshake
httpServer.on('upgrade', (req) => {
  log('WS-UPGRADE', `url=${req.url} from=${req.socket.remoteAddress}`);
  log('WS-UPGRADE', 'headers:', JSON.stringify(req.headers, null, 2));
});

// ── Log a nivel TCP: detecta cualquier conexión entrante ──────────────────
httpServer.on('connection', (socket) => {
  log('TCP', `Nueva conexión TCP desde ${socket.remoteAddress}:${socket.remotePort}`);
  socket.on('close', (hadError) => {
    log('TCP', `Conexión cerrada ${socket.remoteAddress}:${socket.remotePort} hadError=${hadError}`);
  });
  socket.on('error', (err) => {
    log('TCP', `Error en socket ${socket.remoteAddress}:${socket.remotePort} — ${err.message}`);
  });
});

// ── Errores del servidor HTTP ─────────────────────────────────────────────
httpServer.on('error', (err) => {
  log('SERVER-ERROR', err.message, err.stack);
});

// ── Errores del servidor WebSocket ───────────────────────────────────────
// (se define aquí para que quede junto a los otros listeners globales)

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
    log('WS-VERIFY', `from=${info.req.socket.remoteAddress} url=${info.req.url}`);
    log('WS-VERIFY', 'headers recibidos:', JSON.stringify(info.req.headers, null, 2));
    if (!apiKey) {
      log('WS-VERIFY', 'RECHAZADO — falta cabecera x-api-key');
      return cb(false, 401, 'Unauthorized');
    }
    if (apiKey !== API_KEY) {
      log('WS-VERIFY', `RECHAZADO — API key incorrecta: "${apiKey}"`);
      return cb(false, 401, 'Unauthorized');
    }
    log('WS-VERIFY', 'ACEPTADO');
    cb(true);
  },
});

wss.on('error', (err) => {
  log('WSS-ERROR', err.message, err.stack);
});

wss.on('connection', (ws, req) => {
  const sessionId = req.headers['audiohook-session-id']      || crypto.randomUUID();
  const corrId    = req.headers['audiohook-correlation-id']  || '?';

  log('SESSION', `▶ NUEVA SESIÓN sesión=${sessionId} org=${orgId} corr=${corrId}`);
  log('SESSION', `  remoteAddress=${req.socket.remoteAddress}`);

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
      if (session.audioBytes % (16 * 1024) < data.byteLength) {
        // Log cada ~16KB para no saturar la consola
        log('AUDIO', `sesión=${sessionId.slice(0,8)} totalKB=${(session.audioBytes/1024).toFixed(1)}`);
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(data); } catch (e) {
      log('ERROR', `[${sessionId.slice(0,8)}] JSON inválido:`, data.toString().slice(0, 200));
      return;
    }

    log('MSG-IN', `sesión=${sessionId.slice(0,8)} type=${msg.type} seq=${msg.seq}`);
    session.clientseq = msg.seq ?? session.clientseq;

    switch (msg.type) {

      case 'open': {
        session.conversationId = msg.parameters?.conversationId ?? null;
        session.participant    = msg.parameters?.participant    ?? null;
        session.state          = 'open';

        // Elegir el primer formato de media ofrecido
        const offered = msg.parameters?.media || [];
        session.mediaFormat = offered[0] ?? null;

        log('OPEN', `sesión=${sessionId.slice(0,8)} conv=${session.conversationId} lang=${msg.parameters?.language}`);
        log('OPEN', `  participant=${JSON.stringify(session.participant)}`);
        log('OPEN', `  mediaOffered=${JSON.stringify(offered)}`);
        log('OPEN', `  mediaSelected=${JSON.stringify(session.mediaFormat)}`);

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
        log('CLOSE', `sesión=${sessionId.slice(0,8)} dur=${durationSec}s audio=${(session.audioBytes/1024).toFixed(1)}KB reason=${msg.parameters?.reason}`);
        send(session, 'closed', {});
        session.state = 'closed';
        sessions.delete(sessionId);
        break;
      }

      case 'update': {
        log('UPDATE', `sesión=${sessionId.slice(0,8)} lang=${msg.parameters?.language}`);
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
        log('DISCONNECT', `sesión=${sessionId.slice(0,8)} reason=${msg.parameters?.reason}`);
        sessions.delete(sessionId);
        break;
      }

      default:
        log('MSG-IN', `sesión=${sessionId.slice(0,8)} tipo DESCONOCIDO type=${msg.type} body=${JSON.stringify(msg).slice(0,200)}`);
    }
  });

  ws.on('close', (code, reason) => {
    log('WS-CLOSE', `sesión=${sessionId.slice(0,8)} code=${code} reason=${reason?.toString()}`);
    sessions.delete(sessionId);
  });

  ws.on('error', (err) => {
    log('WS-ERROR', `sesión=${sessionId.slice(0,8)} ${err.message}`);
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
  log('MSG-OUT', `sesión=${session.sessionId.slice(0,8)} type=${type} seq=${session.seq}`);
  try { session.ws.send(JSON.stringify(msg)); } catch (e) {
    log('ERROR', `sesión=${session.sessionId.slice(0,8)} send error: ${e.message}`);
  }
}

// ── Arrancar ─────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  const maskedKey = API_KEY.length > 8
    ? API_KEY.slice(0, 4) + '****' + API_KEY.slice(-4)
    : '****';
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
  log('INIT', `Servidor listo. API_KEY cargada: ${maskedKey} (longitud: ${API_KEY.length})`);
  log('INIT', `Modo de logs detallados: ACTIVADO`);
});
