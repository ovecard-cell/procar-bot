const axios = require('axios');
const { procesarMensaje } = require('./agente');

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

// ─────────────────────────────────────────────
// VERIFICACIÓN DEL WEBHOOK (Meta lo llama una sola vez al configurar)
// ─────────────────────────────────────────────

function verificarWebhook(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado por Meta.');
    res.status(200).send(challenge);
  } else {
    console.error('Verificación fallida. Token incorrecto.');
    res.sendStatus(403);
  }
}

// ─────────────────────────────────────────────
// RECIBIR MENSAJES DE WHATSAPP
// ─────────────────────────────────────────────

async function recibirMensaje(req, res) {
  // Meta espera un 200 inmediato, si no reintenta el envío
  res.sendStatus(200);

  try {
    const body = req.body;

    // Verificar que sea un evento de WhatsApp
    if (body.object !== 'whatsapp_business_account') return;

    const entry    = body.entry?.[0];
    const changes  = entry?.changes?.[0];
    const value    = changes?.value;
    const mensaje  = value?.messages?.[0];

    // Solo procesamos mensajes de texto
    if (!mensaje || mensaje.type !== 'text') return;

    const telefono = mensaje.from;           // Número del cliente
    const texto    = mensaje.text.body;      // Texto del mensaje
    const phoneId  = value.metadata.phone_number_id;

    console.log(`[WhatsApp] Mensaje de ${telefono}: ${texto}`);

    // Procesar con el agente de IA
    const respuesta = await procesarMensaje(telefono, texto);

    // Enviar respuesta por WhatsApp
    await enviarMensaje(phoneId, telefono, respuesta);

  } catch (err) {
    console.error('Error procesando mensaje de WhatsApp:', err.message);
  }
}

// ─────────────────────────────────────────────
// ENVIAR MENSAJE POR WHATSAPP
// ─────────────────────────────────────────────

async function enviarMensaje(phoneId, destinatario, texto) {
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
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
  console.log(`[WhatsApp] Respuesta enviada a ${destinatario}`);
}

module.exports = { verificarWebhook, recibirMensaje };
