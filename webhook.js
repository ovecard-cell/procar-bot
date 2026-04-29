const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { procesarMensaje } = require('./agente');
const { getSetting, MEDIA_DIR, guardarMensaje } = require('./database');
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

async function manejarMensajeMeta({ canal, senderId, message, enviar }) {
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
    const respuesta = await procesarMensaje(senderId, '', canal, ultimo);
    if (respuesta) await enviar(senderId, respuesta);
    return;
  }

  // Caso 2: mensaje de texto puro
  if (typeof message.text === 'string' && message.text.trim()) {
    const texto = message.text;
    console.log(`[${canal}] Mensaje de ${senderId}: ${texto}`);
    const respuesta = await procesarMensaje(senderId, texto, canal);
    if (respuesta) await enviar(senderId, respuesta);
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
      const messaging = entry?.messaging?.[0];

      if (!messaging?.message) return;

      // Ignorar echoes (los mensajes que el bot envió y Meta nos rebota como evento)
      if (messaging.message.is_echo) {
        console.log('[Instagram] Echo ignorado (mensaje del propio bot)');
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

      if (!messaging?.message) return;

      // Ignorar echoes (los mensajes que el bot envió y Meta nos rebota como evento)
      if (messaging.message.is_echo) {
        console.log('[Messenger] Echo ignorado (mensaje del propio bot)');
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
    console.error('Error procesando mensaje:', err.message);
  }
}

// ─────────────────────────────────────────────
// ENVIAR MENSAJES POR CADA CANAL
// ─────────────────────────────────────────────

async function enviarWhatsApp(phoneId, destinatario, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: destinatario,
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

async function enviarInstagram(recipientId, texto) {
  // Fallback: si no hay INSTAGRAM_ACCESS_TOKEN, usar META_ACCESS_TOKEN (suele
  // funcionar cuando la cuenta de IG está vinculada a la página de Facebook).
  const token = config.INSTAGRAM_ACCESS_TOKEN || config.META_ACCESS_TOKEN;
  // Si tenemos token específico de IG, usamos graph.instagram.com.
  // Sino, usamos graph.facebook.com con el endpoint de la página.
  const url = config.INSTAGRAM_ACCESS_TOKEN
    ? `https://graph.instagram.com/v21.0/me/messages`
    : `https://graph.facebook.com/v19.0/me/messages`;

  try {
    await axios.post(
      url,
      { recipient: { id: recipientId }, message: { text: texto } },
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
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text: texto }
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

module.exports = { verificarWebhook, recibirMensaje, validarToken, enviarMessenger, enviarInstagram, enviarWhatsApp };
