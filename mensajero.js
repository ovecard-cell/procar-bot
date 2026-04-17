const axios = require('axios');
const config = require('./config');

// Enviar WhatsApp a vendedores (escalado)
async function enviarWhatsAppVendedor(telefono, texto) {
  const phoneId = config.WHATSAPP_PHONE_ID;
  if (!phoneId) {
    console.error('[Escalado] Falta WHATSAPP_PHONE_ID en config');
    return;
  }

  await axios.post(
    `https://graph.facebook.com/v19.0/${phoneId}/messages`,
    {
      messaging_product: 'whatsapp',
      to: telefono,
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
  console.log(`[Escalado] WhatsApp enviado a vendedor ${telefono}`);
}

module.exports = { enviarWhatsAppVendedor };
