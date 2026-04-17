const axios = require('axios');

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

// Enviar WhatsApp a vendedores (escalado)
async function enviarWhatsAppVendedor(telefono, texto) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!phoneId) {
    console.error('[Escalado] Falta WHATSAPP_PHONE_ID en las variables de entorno');
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
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
  console.log(`[Escalado] WhatsApp enviado a vendedor ${telefono}`);
}

module.exports = { enviarWhatsAppVendedor };
