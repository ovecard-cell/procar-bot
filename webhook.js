const axios = require('axios');
const { procesarMensaje } = require('./agente');
const { getSetting } = require('./database');
const { limpiarRecordatorios } = require('./recordatorios');
const config = require('./config');

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

      if (!mensaje || mensaje.type !== 'text') return;

      const telefono = mensaje.from;
      const texto    = mensaje.text.body;
      const phoneId  = value.metadata.phone_number_id;

      console.log(`[WhatsApp] Mensaje de ${telefono}: ${texto}`);

      limpiarRecordatorios(telefono);
      const respuesta = await procesarMensaje(telefono, texto, 'whatsapp');
      if (respuesta) await enviarWhatsApp(phoneId, telefono, respuesta);
      return;
    }

    // ── Instagram ──
    if (body.object === 'instagram') {
      const entry    = body.entry?.[0];
      const messaging = entry?.messaging?.[0];

      if (!messaging?.message?.text) return;

      const senderId = messaging.sender.id;
      const texto    = messaging.message.text;

      console.log(`[Instagram] Mensaje de ${senderId}: ${texto}`);

      limpiarRecordatorios(senderId);
      const respuesta = await procesarMensaje(senderId, texto, 'instagram');
      if (respuesta) await enviarInstagram(senderId, respuesta);
      return;
    }

    // ── Messenger (Facebook / Marketplace) ──
    if (body.object === 'page') {
      const entry    = body.entry?.[0];
      const messaging = entry?.messaging?.[0];

      if (!messaging?.message?.text) return;

      const senderId = messaging.sender.id;
      const texto    = messaging.message.text;

      console.log(`[Messenger] Mensaje de ${senderId}: ${texto}`);

      limpiarRecordatorios(senderId);
      const respuesta = await procesarMensaje(senderId, texto, 'messenger');
      if (respuesta) await enviarMessenger(senderId, respuesta);
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
          Authorization: `Bearer ${config.META_ACCESS_TOKEN}`,
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
