/**
 * Cliente de prueba AudioHook — simula lo que hace Genesys Cloud
 * Conecta al servidor desplegado y ejecuta el protocolo completo:
 *   open → opened → [audio binario] → close → closed → disconnect
 *
 * Uso:
 *   node test-client.js [wss://host/audiohook] [api-key] [duracion-segundos]
 *
 * Ejemplos:
 *   node test-client.js
 *   node test-client.js wss://audiohook-n0lu.onrender.com/audiohook a7f3d2...3c41 10
 */

const { WebSocket } = require('ws');
const { randomUUID } = require('crypto');

// ── Parámetros (desde args o valores por defecto) ─────────────────────────
const URI        = process.argv[2] || 'wss://audiohook-n0lu.onrender.com/audiohook';
const API_KEY    = process.argv[3] || 'a7f3d2e8b1c94560f2a8d71e3b06c9f47d821e5a0c34b76f9e120d85a2b73c41';
const DURATION_S = parseFloat(process.argv[4] || '5');

const ORG_ID     = randomUUID();
const SESSION_ID = randomUUID();
const CORR_ID    = randomUUID();
const CONV_ID    = randomUUID();
const PART_ID    = randomUUID();

let seq       = 0;   // seq de mensajes enviados
let serverSeq = 0;   // último seq recibido del servidor
let audioInterval = null;

function ts() { return new Date().toISOString(); }
function log(tag, ...args) { console.log(`[${ts()}] [${tag}]`, ...args); }

// ── Generador de audio PCMU silencio (valor 0xFF = silencio en PCMU/µ-law) ─
// 8000 Hz, 2 canales intercalados → 16000 muestras/segundo = 16000 bytes/s
// Enviamos tramas de 20ms → 320 bytes por trama
const FRAME_BYTES = 320; // 20ms a 8kHz estéreo (2 ch * 8000 * 0.02)
function makeSilenceFrame() {
  return Buffer.alloc(FRAME_BYTES, 0xFF); // 0xFF = silencio PCMU
}

// ── Conexión WebSocket ────────────────────────────────────────────────────
log('CLIENT', `Conectando a ${URI}`);
log('CLIENT', `org=${ORG_ID.slice(0,8)}… session=${SESSION_ID.slice(0,8)}… conv=${CONV_ID.slice(0,8)}…`);

const ws = new WebSocket(URI, {
  headers: {
    'x-api-key':                  API_KEY,
    'audiohook-organization-id':  ORG_ID,
    'audiohook-session-id':       SESSION_ID,
    'audiohook-correlation-id':   CORR_ID,
    'user-agent':                 'GenesysCloud-AudioHook-Client-TEST',
    'cache-control':              'no-cache',
  }
});

function send(type, parameters) {
  seq++;
  const msg = { version: '2', type, seq, clientseq: serverSeq, id: SESSION_ID, parameters };
  log('MSG-OUT', `type=${type} seq=${seq}`);
  ws.send(JSON.stringify(msg));
}

function sendAudio() {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(makeSilenceFrame());
}

// ── Eventos del WebSocket ─────────────────────────────────────────────────
ws.on('open', () => {
  log('WS', 'Conexión WebSocket establecida ✓');
  log('WS', 'Enviando mensaje open...');

  send('open', {
    version:        '2',
    conversationId: CONV_ID,
    participant: {
      id:      PART_ID,
      ani:     '+34600123456',
      aniName: 'Test Caller',
      dnis:    '+34900000001',
    },
    media: [
      { type: 'audio', format: 'PCMU', channels: ['external', 'internal'], rate: 8000 },
      { type: 'audio', format: 'PCMU', channels: ['external'], rate: 8000 },
    ],
    language: 'es-ES',
  });
});

ws.on('message', (data, isBinary) => {
  // isBinary=true → trama de audio; isBinary=false → mensaje JSON del protocolo
  if (isBinary) {
    log('MSG-IN', `[AUDIO BINARIO del servidor] ${data.byteLength} bytes`);
    return;
  }

  let msg;
  try { msg = JSON.parse(data.toString()); } catch (e) {
    log('ERROR', 'JSON inválido:', data.toString().slice(0, 200));
    return;
  }

  serverSeq = msg.seq ?? serverSeq;
  log('MSG-IN', `type=${msg.type} seq=${msg.seq}`);
  if (msg.parameters && Object.keys(msg.parameters).length > 0) {
    log('MSG-IN', `  params=${JSON.stringify(msg.parameters)}`);
  }

  switch (msg.type) {
    case 'opened': {
      log('CLIENT', `✓ Servidor aceptó la sesión. Formato seleccionado: ${JSON.stringify(msg.parameters?.media?.[0])}`);
      log('CLIENT', `Enviando audio silencioso durante ${DURATION_S}s...`);

      // Enviar audio binario cada 20ms
      audioInterval = setInterval(sendAudio, 20);

      // Cerrar tras DURATION_S segundos
      setTimeout(() => {
        log('CLIENT', `${DURATION_S}s completados. Iniciando cierre...`);
        clearInterval(audioInterval);
        audioInterval = null;
        send('close', { reason: 'end' });
      }, DURATION_S * 1000);
      break;
    }

    case 'ping': {
      send('pong', { rtt: msg.parameters?.rtt ?? null });
      break;
    }

    case 'closed': {
      log('CLIENT', '✓ Servidor confirmó el cierre. Enviando disconnect...');
      send('disconnect', { reason: 'end' });
      setTimeout(() => ws.close(1000, 'Session Ended'), 100);
      break;
    }

    case 'error': {
      log('ERROR', `Servidor devolvió error: ${JSON.stringify(msg.parameters)}`);
      break;
    }

    default:
      log('MSG-IN', `Tipo desconocido: ${msg.type}`);
  }
});

ws.on('close', (code, reason) => {
  if (audioInterval) { clearInterval(audioInterval); }
  log('WS', `Conexión cerrada. code=${code} reason=${reason.toString()}`);
  log('CLIENT', '── Sesión completada ──');
});

ws.on('error', (err) => {
  if (audioInterval) { clearInterval(audioInterval); }
  log('ERROR', `WebSocket error: ${err.message}`);
  if (err.message.includes('401')) {
    log('ERROR', '→ API key incorrecta o no enviada');
  } else if (err.message.includes('ECONNREFUSED')) {
    log('ERROR', '→ Servidor no accesible en esa dirección');
  }
  process.exit(1);
});

// Ctrl+C → cierre limpio
process.on('SIGINT', () => {
  log('CLIENT', 'Interrupción. Cerrando sesión...');
  if (audioInterval) { clearInterval(audioInterval); audioInterval = null; }
  try { send('close', { reason: 'end' }); } catch (_) {}
  setTimeout(() => process.exit(0), 500);
});
