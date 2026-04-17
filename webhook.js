const axios = require('axios');
const { procesarMensaje } = require('./agente');
const config = require('./config');

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

      const respuesta = await procesarMensaje(telefono, texto, 'whatsapp');
      await enviarWhatsApp(phoneId, telefono, respuesta);
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

      const respuesta = await procesarMensaje(senderId, texto, 'instagram');
      await enviarInstagram(senderId, respuesta);
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

      const respuesta = await procesarMensaje(senderId, texto, 'messenger');
      await enviarMessenger(senderId, respuesta);
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
}

async function enviarInstagram(recipientId, texto) {
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
  console.log(`[Instagram] Respuesta enviada a ${recipientId}`);
}

async function enviarMessenger(recipientId, texto) {
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
}

module.exports = { verificarWebhook, recibirMensaje };
