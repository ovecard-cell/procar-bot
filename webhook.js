const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { procesarMensaje } = require('./agente');
const { getSetting, setSetting, MEDIA_DIR, guardarMensaje } = require('./database');
const { limpiarRecordatorios } = require('./recordatorios');
const config = require('./config');

// ─────────────────────────────────────────────
// DESCARGA DE MEDIA (imágenes, audios, videos)
// ─────────────────────────────────────────────

const TIPO_POR_MIME = {
  'image/jpeg': { tipo: 'imagen', ext: 'jpg' },
  'image/jpg':  { tipo: 'imagen', ext: 'jpg' },
  'image/png':  { tipo: 'imagen', ext: 'png' },
  'image/webp': { tipo: 'imagen', ext: 'webp' },
  'image/gif':  { tipo: 'imagen', ext: 'gif' },
  'audio/mpeg': { tipo: 'audio',  ext: 'mp3' },
  'audio/mp4':  { tipo: 'audio',  ext: 'm4a' },
  'audio/aac':  { tipo: 'audio',  ext: 'aac' },
  'audio/ogg':  { tipo: 'audio',  ext: 'ogg' },
  'audio/webm': { tipo: 'audio',  ext: 'webm' },
  'video/mp4':  { tipo: 'video',  ext: 'mp4' },
  'video/3gpp': { tipo: 'video',  ext: '3gp' },
};

function tipoDesdeAttachment(attType, mime) {
  if (mime && TIPO_POR_MIME[mime]) return TIPO_POR_MIME[mime];
  if (attType === 'image') return { tipo: 'imagen', ext: 'jpg' };
  if (attType === 'audio') return { tipo: 'audio',  ext: 'mp3' };
  if (attType === 'video') return { tipo: 'video',  ext: 'mp4' };
  return { tipo: 'archivo', ext: 'bin' };
}

// Descarga una URL a la carpeta de media y devuelve el nombre del archivo
async function descargarMedia(url, ext, headers = {}) {
  try {
    const r = await axios.get(url, { responseType: 'arraybuffer', headers, timeout: 20000 });
    const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const fullPath = path.join(MEDIA_DIR, filename);
    fs.writeFileSync(fullPath, r.data);
    console.log(`[Media] Descargado ${filename} (${r.data.length} bytes)`);
    return filename;
  } catch (err) {
    console.error('[Media] Error descargando:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// HELPERS DE ERRORES DE META
// ─────────────────────────────────────────────

function describirErrorMeta(err, contexto) {
  const status = err.response?.status;
  const data = err.response?.data;
  const errorMeta = data?.error || {};

  if (status === 401 || errorMeta.code === 190 || errorMeta.type === 'OAuthException') {
    console.error(`[ERROR] Token de Meta inválido o expirado (HTTP ${status}) — renovar META_ACCESS_TOKEN [${contexto}]`);
    console.error(`        Detalle: ${errorMeta.message || 'sin detalle'}`);
    return;
  }

  if (status === 403) {
    console.error(`[ERROR] Permiso denegado por Meta (HTTP 403) — el token no tiene los scopes necesarios [${contexto}]`);
    console.error(`        Detalle: ${errorMeta.message || 'sin detalle'}`);
    return;
  }

  if (status === 400) {
    console.error(`[ERROR] Petición inválida a Meta (HTTP 400) [${contexto}]`);
    console.error(`        Detalle: ${errorMeta.message || JSON.stringify(data)}`);
    return;
  }

  console.error(`[ERROR] Falla al llamar a Meta [${contexto}]: ${err.message}`);
  if (data) console.error(`        Respuesta: ${JSON.stringify(data)}`);
}

// ─────────────────────────────────────────────
// VALIDACIÓN DEL TOKEN AL ARRANCAR
// ─────────────────────────────────────────────

async function validarToken() {
  if (!config.META_ACCESS_TOKEN) {
    console.error('[STARTUP] META_ACCESS_TOKEN está vacío. El bot no podrá responder mensajes.');
    return false;
  }

  try {
    const res = await axios.get(`https://graph.facebook.com/me`, {
      params: { access_token: config.META_ACCESS_TOKEN, fields: 'id' },
    });
    console.log(`[STARTUP] ✅ Token de Meta presente y respondiendo. ID: ${res.data.id}`);
    return true;
  } catch (err) {
    const status = err.response?.status;
    const errorMeta = err.response?.data?.error || {};

    // Solo 401 o code 190 indica token realmente expirado/inválido.
    if (status === 401 || errorMeta.code === 190) {
      console.error(`[STARTUP] ❌ Token de Meta EXPIRADO o INVÁLIDO. Hay que renovar META_ACCESS_TOKEN en Railway.`);
      return false;
    }

    // Cualquier otro error (incluido 400 con code 100 por permisos faltantes
    // en modo desarrollo) NO es un problema: el token sirve para enviar mensajes.
    console.log(`[STARTUP] ✅ Token de Meta presente. Validación de identidad limitada por modo desarrollo (normal).`);
    return true;
  }
}

// ─────────────────────────────────────────────
// MANEJO COMÚN DE MENSAJES DE INSTAGRAM / MESSENGER
// (texto + attachments — descarga imágenes, audios, videos)
// ─────────────────────────────────────────────

// Maneja un mensaje "echo" (eco que Meta nos rebota cuando alguien manda
// algo desde la página). Si trae nuestra metadata es del propio bot → ignorar.
// Si NO trae nuestra metadata, lo mandó un humano desde Business Suite →
// guardar en la conversación como assistant Y pausar al bot, así no se pisan.
// Extrae el texto/titulo más útil de un attachment de Messenger. Los anuncios
// suelen mandar templates generic con title/subtitle (ej: "PEUGEOT 208 L/20 2021"),
// o imágenes con caption. Probamos en varios lados según la estructura.
function extraerTextoAttachment(att) {
  if (!att) return null;
  const p = att.payload || {};
  // Template generic: payload.elements[0].title / .subtitle
  if (Array.isArray(p.elements) && p.elements.length) {
    const e = p.elements[0];
    const partes = [e.title, e.subtitle].filter(Boolean);
    if (partes.length) return partes.join(' — ');
  }
  // Algunos templates: payload.title / payload.text
  if (p.title) return p.title;
  if (p.text) return p.text;
  // Fallback: tipo + url
  if (att.type) return null;
  return null;
}

function manejarEcho({ canal, messaging }) {
  const recipientId = messaging.recipient?.id;
  const message = messaging.message;
  const textoEcho = (message?.text || '').trim();

  // Detección 1: metadata que pusimos al enviar (Meta a veces la conserva).
  const matchMetadata = message?.metadata === BOT_METADATA;
  // Detección 2: fingerprint por (recipient + texto) que enviamos en últimos 60s.
  // Esto cubre el caso de Instagram donde Meta descarta la metadata en el echo.
  const matchFingerprint = textoEcho && fueEnviadoPorBot(recipientId, textoEcho);
  // Detección 3: fingerprint por URL de attachment. Si el bot mando foto/video
  // via Send API, Meta hace echo del attachment con la misma URL pero SIN
  // text — sin esta deteccion el echo se interpretaba como humano y pausaba.
  let matchAttachmentUrl = false;
  if (Array.isArray(message?.attachments) && message.attachments.length) {
    const urls = message.attachments.map(a => a?.payload?.url).filter(Boolean);
    if (urls.length && urls.every(u => fueUrlEnviadaPorBot(recipientId, u))) {
      matchAttachmentUrl = true;
    }
  }

  if (matchMetadata || matchFingerprint || matchAttachmentUrl) {
    console.log(`[${canal}] Echo del propio bot ignorado (meta=${matchMetadata}, fp=${matchFingerprint}, attUrl=${matchAttachmentUrl})`);
    return;
  }
  if (!recipientId) return;

  // Echo de humano desde Business Suite o saludo automático del anuncio. Lo
  // guardamos en el historial (rol assistant) así Gonzalo lo ve de contexto.
  const texto = (message?.text || '').trim();
  if (texto) {
    try {
      guardarMensaje({ telefono: recipientId, rol: 'assistant', contenido: texto, canal, tipo: 'texto' });
    } catch (err) {
      console.error(`[${canal}] No pude guardar echo humano:`, err.message);
    }
  }

  // Adjuntos: muchos anuncios mandan un template/imagen con el modelo del auto
  // como título. Extraemos eso para que Gonzalo lo vea como contexto.
  if (Array.isArray(message?.attachments) && message.attachments.length) {
    for (const att of message.attachments) {
      const txt = extraerTextoAttachment(att);
      if (txt) {
        try {
          guardarMensaje({
            telefono: recipientId, rol: 'assistant',
            contenido: `[publicación: ${txt}]`,
            canal, tipo: 'texto',
          });
          console.log(`[${canal}] Capturé contexto de attachment: "${txt}"`);
        } catch { /* noop */ }
      } else if (!texto) {
        // Si no había texto y no pudimos extraer del attachment, dejamos
        // un placeholder para que Gonzalo sepa que algo se mandó.
        try {
          guardarMensaje({
            telefono: recipientId, rol: 'assistant',
            contenido: `[adjunto: ${att.type}]`,
            canal, tipo: 'texto',
          });
        } catch { /* noop */ }
      }
    }
  }

  // Solo pausamos el bot si el cliente YA escribió antes. Caso contrario el
  // echo es el saludo automático del anuncio de Meta (o un primer toque del
  // vendedor) — pausarlo dejaría a Gonzalo sin atender al cliente cuando
  // responda, que es lo opuesto a lo que queremos.
  try {
    const { db } = require('./database');
    const tieneUser = db.prepare(
      "SELECT 1 FROM conversaciones WHERE telefono = ? AND rol = 'user' LIMIT 1"
    ).get(recipientId);
    if (!tieneUser) {
      console.log(`[${canal}] Echo humano sin conversación previa del cliente — NO pauso bot (probable saludo de anuncio)`);
      return;
    }
  } catch (err) {
    console.error(`[${canal}] No pude chequear historial:`, err.message);
  }

  setSetting(`bot_pausado_${recipientId}`, 'true');
  console.log(`[${canal}] Humano respondió desde Business Suite → bot PAUSADO para ${recipientId}`);
}

async function manejarMensajeMeta({ canal, senderId, message, enviar }) {
  // Resolver nombre del cliente (en background — no bloqueamos la respuesta).
  // Solo se hace una vez por sender (cache + check DB).
  asegurarNombreCliente(canal, senderId).catch(() => {});

  // Caso 1: tiene attachments (imágenes / audios / videos / archivos)
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const guardados = [];
    for (const att of message.attachments) {
      // Stickers de IG/FB suelen venir como image — los tratamos igual.
      // Templates / fallback (links compartidos, etc.) los ignoramos.
      if (!['image', 'audio', 'video', 'file'].includes(att.type)) {
        console.log(`[${canal}] Attachment tipo '${att.type}' ignorado`);
        continue;
      }
      const url = att.payload?.url;
      if (!url) {
        console.log(`[${canal}] Attachment sin URL, salteado`);
        continue;
      }
      const { tipo, ext } = tipoDesdeAttachment(att.type);
      const archivo = await descargarMedia(url, ext);
      if (!archivo) continue;
      console.log(`[${canal}] ${tipo} de ${senderId}: ${archivo}`);
      guardados.push({ tipo, archivo });
    }
    if (guardados.length === 0) return;

    // Si vinieron varios attachments en un mismo mensaje, los guardamos todos
    // pero solo llamamos al LLM una vez (con el último). Así Gonzalo "ve"
    // todas las fotos en el historial y responde una sola vez.
    for (let i = 0; i < guardados.length - 1; i++) {
      const { tipo, archivo } = guardados[i];
      guardarMensaje({ telefono: senderId, rol: 'user', contenido: '', canal, tipo, archivo });
    }
    const ultimo = guardados[guardados.length - 1];
    try {
      const respuesta = await procesarMensaje(senderId, '', canal, ultimo);
      if (respuesta) await enviar(senderId, respuesta);
    } catch (err) {
      console.error(`[${canal}] CRASH procesando attachment de ${senderId} | tipo=${ultimo.tipo} archivo=${ultimo.archivo} | error: ${err.message}\n${err.stack || ''}`);
    }
    return;
  }

  // Caso 2: mensaje de texto puro
  if (typeof message.text === 'string' && message.text.trim()) {
    const texto = message.text;
    console.log(`[${canal}] INBOUND sender_id="${senderId}" (type=${typeof senderId}, len=${String(senderId).length}) texto="${texto}"`);
    try {
      const respuesta = await procesarMensaje(senderId, texto, canal);
      if (respuesta) await enviar(senderId, respuesta);
    } catch (err) {
      // Catch puntual: si procesarMensaje o enviar() crashean, queremos saberlo
      // CON el sender_id y el texto que dispararon — sino el silencio queda mudo.
      console.error(`[${canal}] CRASH procesando mensaje de ${senderId} | texto="${texto.slice(0, 200)}" | error: ${err.message}\n${err.stack || ''}`);
    }
    return;
  }

  console.log(`[${canal}] Mensaje sin texto ni attachments soportados, ignorado`);
}

// ─────────────────────────────────────────────
// VERIFICACIÓN DEL WEBHOOK (Meta lo llama al configurar)
// ─────────────────────────────────────────────

function verificarWebhook(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = config.WHATSAPP_VERIFY_TOKEN;

  console.log(`[Webhook] Verificación - mode: ${mode}, token recibido: ${token}, token esperado: ${verifyToken}`);

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('Webhook verificado por Meta.');
    res.status(200).send(challenge);
  } else {
    console.error('Verificación fallida. Token incorrecto.');
    res.sendStatus(403);
  }
}

// ─────────────────────────────────────────────
// RECIBIR MENSAJES (WhatsApp, Instagram, Messenger)
// ─────────────────────────────────────────────

// Cache en memoria de mids ya procesados, con TTL. Meta reintenta el mismo
// evento varias veces (especialmente en Instagram), o manda dups con el mismo
// mid en el mismo segundo. Sin esto el bot responde 2-3 veces al mismo mensaje.
const MID_CACHE = new Map();         // mid → timestamp ms
const MID_TTL_MS = 5 * 60 * 1000;    // 5 minutos
function midYaProcesado(mid) {
  if (!mid) return false;
  const ahora = Date.now();
  // Limpieza oportunista: cada llamada borra entradas expiradas
  for (const [k, ts] of MID_CACHE) {
    if (ahora - ts > MID_TTL_MS) MID_CACHE.delete(k);
  }
  if (MID_CACHE.has(mid)) return true;
  MID_CACHE.set(mid, ahora);
  return false;
}

// Saca todos los mids posibles del body (uno por canal y formato).
function extraerMidsDelBody(body) {
  const mids = [];
  const entry = body?.entry?.[0];
  if (!entry) return mids;

  // WhatsApp Cloud API: entry.changes[0].value.messages[0].id
  const wa = entry.changes?.[0]?.value?.messages?.[0]?.id;
  if (wa) mids.push(wa);

  // Messenger / Instagram (formato A): entry.messaging[0].message.mid
  const m = entry.messaging?.[0]?.message?.mid;
  if (m) mids.push(m);

  // Instagram formato B: entry.changes[0].value.messages[0].id (mismo que WA)
  // ya cubierto arriba.

  return mids;
}

async function recibirMensaje(req, res) {
  res.sendStatus(200);

  // Si el agente está pausado globalmente, no respondemos
  const agenteActivo = getSetting('agente_activo', 'true') === 'true';
  if (!agenteActivo) {
    console.log('[Webhook] Agente pausado globalmente — mensaje recibido pero NO se responde');
    return;
  }

  try {
    const body = req.body;

    // Dedupe por mid: Meta puede mandar el mismo evento 2-3 veces. Si ya lo
    // procesamos en los últimos 5 min, ignoramos.
    const mids = extraerMidsDelBody(body);
    for (const mid of mids) {
      if (midYaProcesado(mid)) {
        console.log(`[Webhook] DUP ignorado mid=${mid} (Meta reintento)`);
        return;
      }
    }

    // ── WhatsApp ──
    if (body.object === 'whatsapp_business_account') {
      const entry   = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value   = changes?.value;
      const mensaje = value?.messages?.[0];

      if (!mensaje) return;

      const telefono = mensaje.from;
      const phoneId  = value.metadata.phone_number_id;

      limpiarRecordatorios(telefono);

      // Texto puro
      if (mensaje.type === 'text') {
        const texto = mensaje.text.body;
        console.log(`[WhatsApp] Mensaje de ${telefono}: ${texto}`);
        const respuesta = await procesarMensaje(telefono, texto, 'whatsapp');
        if (respuesta) await enviarWhatsApp(phoneId, telefono, respuesta);
        return;
      }

      // Media (imagen, audio, video, documento). WhatsApp manda solo un media_id;
      // hay que pedirle a Meta la URL, descargarla con el token y guardarla.
      if (['image', 'audio', 'video', 'document'].includes(mensaje.type)) {
        const mediaInfo = mensaje[mensaje.type];
        const mediaId = mediaInfo?.id;
        if (!mediaId) return;
        try {
          const meta = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${config.WA_TOKEN}` },
          });
          const { tipo, ext } = tipoDesdeAttachment(mensaje.type, meta.data.mime_type);
          const archivo = await descargarMedia(meta.data.url, ext, {
            Authorization: `Bearer ${config.WA_TOKEN}`,
          });
          if (!archivo) return;
          console.log(`[WhatsApp] ${tipo} de ${telefono}: ${archivo}`);
          const respuesta = await procesarMensaje(telefono, '', 'whatsapp', { tipo, archivo });
          if (respuesta) await enviarWhatsApp(phoneId, telefono, respuesta);
        } catch (err) {
          describirErrorMeta(err, `descargar media WhatsApp ${mediaId}`);
        }
        return;
      }

      console.log(`[WhatsApp] Tipo de mensaje '${mensaje.type}' ignorado`);
      return;
    }

    // ── Instagram ──
    if (body.object === 'instagram') {
      const entry    = body.entry?.[0];
      // Formato A (Messenger-style): entry.messaging[0]
      // Formato B (Instagram Graph API moderno): entry.changes[0].value.messages[0]
      let messaging = entry?.messaging?.[0];

      // DIAGNOSTICO: dump del shape para ver qué estructura llega
      console.log(`[Instagram] WEBHOOK shape: messaging=${!!entry?.messaging} (len=${entry?.messaging?.length || 0}) changes=${!!entry?.changes} (len=${entry?.changes?.length || 0}) keys=${Object.keys(entry || {}).join(',')}`);

      // Soporte para Formato B — convertimos a la forma "messaging" para reutilizar
      // todo el flujo posterior.
      if (!messaging && Array.isArray(entry?.changes) && entry.changes.length) {
        const ch = entry.changes[0];
        const val = ch?.value || {};
        const msg = Array.isArray(val.messages) && val.messages[0];
        const fromId = val.contacts?.[0]?.wa_id || val.from || msg?.from;
        if (msg && fromId) {
          messaging = {
            sender: { id: String(fromId) },
            recipient: { id: val.metadata?.phone_number_id || entry.id },
            timestamp: msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now(),
            message: {
              mid: msg.id,
              text: msg.text?.body || msg.text,
              attachments: msg.attachments,
            },
          };
          console.log(`[Instagram] Formato B detectado, sender=${fromId}`);
        }
      }

      if (!messaging) {
        console.log(`[Instagram] No pude extraer messaging del body. Body completo:`, JSON.stringify(body).slice(0, 800));
        return;
      }

      // Capturar referral del anuncio (ads-to-Instagram-direct).
      const refIg = messaging.referral || messaging.message?.referral;
      if (refIg) {
        const senderRef = messaging.sender?.id;
        if (senderRef) {
          const partes = [];
          if (refIg.ad_id) partes.push(`ad_id=${refIg.ad_id}`);
          if (refIg.ref) partes.push(`ref=${refIg.ref}`);
          if (refIg.source) partes.push(`source=${refIg.source}`);
          try {
            guardarMensaje({
              telefono: senderRef, rol: 'assistant',
              contenido: `[cliente vino de un anuncio: ${partes.join(', ')}]`,
              canal: 'instagram', tipo: 'texto',
            });
            console.log(`[Instagram] Referral capturado: ${partes.join(', ')}`);
          } catch { /* noop */ }
        }
      }

      if (!messaging.message) return;

      if (messaging.message.is_echo) {
        manejarEcho({ canal: 'instagram', messaging });
        return;
      }

      const senderId = messaging.sender.id;
      limpiarRecordatorios(senderId);
      await manejarMensajeMeta({
        canal: 'instagram',
        senderId,
        message: messaging.message,
        enviar: enviarInstagram,
      });
      return;
    }

    // ── Messenger (Facebook / Marketplace) ──
    if (body.object === 'page') {
      const entry    = body.entry?.[0];
      const messaging = entry?.messaging?.[0];

      if (!messaging) return;

      // Capturar referral del anuncio (puede venir solo, sin mensaje, cuando el
      // cliente abre el chat desde un click-to-Messenger ad).
      const ref = messaging.referral || messaging.message?.referral;
      if (ref) {
        const senderRef = messaging.sender?.id;
        if (senderRef) {
          const partes = [];
          if (ref.ad_id) partes.push(`ad_id=${ref.ad_id}`);
          if (ref.ref) partes.push(`ref=${ref.ref}`);
          if (ref.source) partes.push(`source=${ref.source}`);
          try {
            guardarMensaje({
              telefono: senderRef, rol: 'assistant',
              contenido: `[cliente vino de un anuncio: ${partes.join(', ')}]`,
              canal: 'messenger', tipo: 'texto',
            });
            console.log(`[Messenger] Referral capturado: ${partes.join(', ')}`);
          } catch { /* noop */ }
        }
      }

      if (!messaging.message) return;

      if (messaging.message.is_echo) {
        manejarEcho({ canal: 'messenger', messaging });
        return;
      }

      const senderId = messaging.sender.id;
      limpiarRecordatorios(senderId);
      await manejarMensajeMeta({
        canal: 'messenger',
        senderId,
        message: messaging.message,
        enviar: enviarMessenger,
      });
      return;
    }

  } catch (err) {
    // Stack completo y body resumido — sin esto los crashes async quedan
    // mudos (caso Nicolas Torres 2026-05-07: bot procesando, sin respuesta,
    // sin error visible).
    const bodyResumen = JSON.stringify(req.body || {}).slice(0, 400);
    console.error(`[Webhook] Error procesando mensaje: ${err.message}\nbody=${bodyResumen}\n${err.stack || ''}`);
  }
}

// ─────────────────────────────────────────────
// ENVIAR MENSAJES POR CADA CANAL
// ─────────────────────────────────────────────

async function enviarWhatsApp(phoneId, destinatario, texto) {
  try {
    const { normalizarTelefonoWA } = require('./mensajero');
    const destino = normalizarTelefonoWA(destinatario);
    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: destino,
        type: 'text',
        text: { body: texto }
      },
      {
        headers: {
          Authorization: `Bearer ${config.WA_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`[WhatsApp] Respuesta enviada a ${destinatario}`);
  } catch (err) {
    describirErrorMeta(err, `enviarWhatsApp a ${destinatario}`);
    throw err;
  }
}

// Marca que ponemos a TODOS los mensajes salientes del bot. Cuando Meta nos
// rebota un echo, si trae esta metadata sabemos que es nuestro y lo ignoramos.
// PERO: Meta NO siempre conserva la metadata en el echo (especialmente en
// Instagram). Por eso además mantenemos un cache de "recién enviados" como
// fingerprint de respaldo.
const BOT_METADATA = 'procar-bot-v1';

// Cache de telefonos a los que ya intentamos resolver el nombre. Evita pegarle
// a la API de Meta en cada mensaje. Aun si Meta rechazó (sin permisos),
// guardamos para no reintentar todo el día.
const PERFILES_CONSULTADOS = new Set();

// Llama a la Graph API de Meta para obtener el nombre del usuario que escribió.
// Devuelve string con el nombre o null si no pudo.
async function obtenerPerfilMeta(canal, senderId) {
  if (!senderId) return null;
  try {
    if (canal === 'instagram') {
      // Instagram: con INSTAGRAM_ACCESS_TOKEN usamos graph.instagram.com.
      // Sin él, fallback a graph.facebook.com.
      const token = config.INSTAGRAM_ACCESS_TOKEN || config.META_ACCESS_TOKEN;
      const baseUrl = config.INSTAGRAM_ACCESS_TOKEN
        ? `https://graph.instagram.com/v21.0/${senderId}`
        : `https://graph.facebook.com/v19.0/${senderId}`;
      const r = await axios.get(baseUrl, {
        params: { fields: 'name,username', access_token: token },
        timeout: 5000,
      });
      const nombre = r.data?.name || r.data?.username || null;
      return nombre ? String(nombre).trim() : null;
    }

    if (canal === 'messenger' || canal === 'facebook') {
      // Messenger PSID — necesita Page Access Token con scope pages_messaging.
      const r = await axios.get(`https://graph.facebook.com/v19.0/${senderId}`, {
        params: { fields: 'first_name,last_name', access_token: config.META_ACCESS_TOKEN },
        timeout: 5000,
      });
      const partes = [r.data?.first_name, r.data?.last_name].filter(Boolean);
      return partes.length ? partes.join(' ').trim() : null;
    }
  } catch (err) {
    const meta = err.response?.data?.error;
    console.log(`[Perfil ${canal}] no pude resolver nombre de ${senderId}: ${meta?.message || err.message}`);
    return null;
  }
  return null;
}

// Wrapper que consulta UNA sola vez por sender (cache + check DB) y si encuentra
// el nombre lo guarda en clientes vía guardarLead. Silencioso ante fallos.
async function asegurarNombreCliente(canal, senderId) {
  if (!senderId || PERFILES_CONSULTADOS.has(senderId)) return;
  PERFILES_CONSULTADOS.add(senderId);
  try {
    const { db, guardarLead } = require('./database');
    const ya = db.prepare('SELECT nombre FROM clientes WHERE telefono = ?').get(senderId);
    if (ya?.nombre && ya.nombre.trim()) return; // ya tiene nombre, no necesitamos pedirlo
    const nombre = await obtenerPerfilMeta(canal, senderId);
    if (nombre) {
      guardarLead({ telefono: senderId, nombre, canal });
      console.log(`[Perfil ${canal}] nombre guardado para ${senderId}: "${nombre}"`);
    }
  } catch (err) {
    console.error(`[asegurarNombreCliente] ${err.message}`);
  }
}

// Cache de mensajes que el bot envió recientemente: clave "recipient::text" → ts.
// Cuando llega un echo, si el (recipient, text) matchea algo enviado en los
// últimos 60s, sabemos que es nuestro echo y lo ignoramos sin pausar.
const RECIENTES_BOT = new Map();
const RECIENTES_TTL_MS = 60 * 1000;
function marcarEnviadoPorBot(recipientId, texto) {
  if (!recipientId || !texto) return;
  const key = `${recipientId}::${String(texto).slice(0, 200)}`;
  const ahora = Date.now();
  // limpieza
  for (const [k, ts] of RECIENTES_BOT) if (ahora - ts > RECIENTES_TTL_MS) RECIENTES_BOT.delete(k);
  RECIENTES_BOT.set(key, ahora);
}
function fueEnviadoPorBot(recipientId, texto) {
  if (!recipientId || !texto) return false;
  const key = `${recipientId}::${String(texto).slice(0, 200)}`;
  return RECIENTES_BOT.has(key);
}

// Mismo fingerprint que el de texto pero por URL de attachment. Cuando el
// bot manda foto/video via Send API, Meta hace echo del attachment con la
// misma URL — sin este registro, manejarEcho lo interpretaba como 'humano
// desde Business Suite' y pausaba al bot (caso real: Nisim Valenzuela
// 2026-05-09, bot pausado tras mandar 4 fotos del Corolla, no respondio
// despues a 'sería financiado').
const RECIENTES_URLS_BOT = new Map();
function marcarUrlEnviadaPorBot(recipientId, urlPublica) {
  if (!recipientId || !urlPublica) return;
  const key = `${recipientId}::${urlPublica}`;
  const ahora = Date.now();
  for (const [k, ts] of RECIENTES_URLS_BOT) if (ahora - ts > RECIENTES_TTL_MS) RECIENTES_URLS_BOT.delete(k);
  RECIENTES_URLS_BOT.set(key, ahora);
}
function fueUrlEnviadaPorBot(recipientId, urlPublica) {
  if (!recipientId || !urlPublica) return false;
  const key = `${recipientId}::${urlPublica}`;
  return RECIENTES_URLS_BOT.has(key);
}

async function enviarInstagram(recipientId, texto) {
  const token = config.INSTAGRAM_ACCESS_TOKEN || config.META_ACCESS_TOKEN;
  const url = config.INSTAGRAM_ACCESS_TOKEN
    ? `https://graph.instagram.com/v21.0/me/messages`
    : `https://graph.facebook.com/v19.0/me/messages`;

  try {
    marcarEnviadoPorBot(recipientId, texto);
    await axios.post(
      url,
      { recipient: { id: recipientId }, message: { text: texto, metadata: BOT_METADATA } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[Instagram] Respuesta enviada a ${recipientId}`);
  } catch (err) {
    describirErrorMeta(err, `enviarInstagram a ${recipientId}`);
    throw err;
  }
}

async function enviarMessenger(recipientId, texto) {
  try {
    marcarEnviadoPorBot(recipientId, texto);
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text: texto, metadata: BOT_METADATA }
      },
      {
        headers: {
          Authorization: `Bearer ${config.META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`[Messenger] Respuesta enviada a ${recipientId}`);
  } catch (err) {
    describirErrorMeta(err, `enviarMessenger a ${recipientId}`);
    throw err;
  }
}

// ─────────────────────────────────────────────
// ENVIAR MEDIA (imagen / video) POR CADA CANAL
// El archivo ya está guardado en MEDIA_DIR y servido por /media/<filename>.
// Le pasamos a Meta una URL pública HTTPS (la que ve el cliente al request)
// y Meta la baja por su cuenta.
// ─────────────────────────────────────────────

async function enviarMessengerMedia(recipientId, urlPublica, tipo) {
  // tipo: 'image' o 'video'
  try {
    console.log(`[Messenger] enviando ${tipo} a ${recipientId} url=${urlPublica}`);
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      {
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: tipo,
            payload: { url: urlPublica, is_reusable: true },
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${config.META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[Messenger] ${tipo} enviado OK a ${recipientId}`);
    marcarUrlEnviadaPorBot(recipientId, urlPublica);
  } catch (err) {
    describirErrorMeta(err, `enviarMessengerMedia(${tipo}) a ${recipientId}`);
    const metaMsg = err.response?.data?.error?.message || err.message;
    const metaCode = err.response?.data?.error?.code || err.response?.status;
    const e = new Error(`MSG_${metaCode}: ${metaMsg}`);
    e.original = err;
    throw e;
  }
}

async function enviarInstagramMedia(recipientId, urlPublica, tipo) {
  const token = config.INSTAGRAM_ACCESS_TOKEN || config.META_ACCESS_TOKEN;
  const url = config.INSTAGRAM_ACCESS_TOKEN
    ? `https://graph.instagram.com/v21.0/me/messages`
    : `https://graph.facebook.com/v19.0/me/messages`;
  // Instagram messaging API NO soporta is_reusable (es de Messenger/FB).
  // Mandar solo url limpio.
  const payload = {
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: tipo,
        payload: { url: urlPublica },
      },
    },
  };
  try {
    console.log(`[Instagram] enviando ${tipo} a ${recipientId} url=${urlPublica}`);
    await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    console.log(`[Instagram] ${tipo} enviado OK a ${recipientId}`);
    marcarUrlEnviadaPorBot(recipientId, urlPublica);
  } catch (err) {
    describirErrorMeta(err, `enviarInstagramMedia(${tipo}) a ${recipientId}`);
    // Re-lanzo con mensaje rico (incluye el motivo real de Meta) para que el
    // tool result pueda registrarlo en logs y diagnostico.
    const metaMsg = err.response?.data?.error?.message || err.message;
    const metaCode = err.response?.data?.error?.code || err.response?.status;
    const e = new Error(`IG_${metaCode}: ${metaMsg}`);
    e.original = err;
    throw e;
  }
}

async function enviarWhatsAppMedia(phoneId, destinatario, urlPublica, tipo, caption) {
  // tipo: 'image' o 'video'. WhatsApp Cloud API acepta link directo.
  try {
    const { normalizarTelefonoWA } = require('./mensajero');
    const destino = normalizarTelefonoWA(destinatario);
    const mediaPayload = { link: urlPublica };
    if (caption) mediaPayload.caption = caption;
    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: destino,
        type: tipo,
        [tipo]: mediaPayload,
      },
      {
        headers: {
          Authorization: `Bearer ${config.WA_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[WhatsApp] ${tipo} enviado a ${destinatario}: ${urlPublica}`);
  } catch (err) {
    describirErrorMeta(err, `enviarWhatsAppMedia(${tipo}) a ${destinatario}`);
    throw err;
  }
}

module.exports = {
  verificarWebhook,
  recibirMensaje,
  validarToken,
  enviarMessenger,
  enviarInstagram,
  enviarWhatsApp,
  enviarMessengerMedia,
  enviarInstagramMedia,
  enviarWhatsAppMedia,
  obtenerPerfilMeta,
};
