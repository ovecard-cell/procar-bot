const axios = require('axios');
const config = require('./config');

// ─────────────────────────────────────────────
// Mensaje de texto libre — solo funciona si la ventana de 24hs está abierta.
// Usado en pruebas y en el flujo de distribuir leads (donde quizás los vendedores
// ya tenían ventana abierta porque se mensajearon antes).
// ─────────────────────────────────────────────
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
        Authorization: `Bearer ${config.WA_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
  console.log(`[Escalado] WhatsApp enviado a vendedor ${telefono}`);
}

// ─────────────────────────────────────────────
// Mensaje de PLANTILLA aprobada por Meta — funciona aunque no haya ventana abierta.
// Es lo que necesitamos para avisarle al vendedor de un lead nuevo, porque
// el vendedor no nos mensajeó primero.
//
// Plantilla: lead_asignado (Utility, Spanish ARG)
//   Notificación: nuevo contacto asignado.
//   Nombre: {{1}}
//   Vehículo consultado: {{2}}
//   Consulta: {{3}}
//   Atender a la brevedad.
// ─────────────────────────────────────────────
async function enviarLeadAsignado(telefono, { cliente, vehiculo, consulta }) {
  const phoneId = config.WHATSAPP_PHONE_ID;
  if (!phoneId) {
    console.error('[Escalado] Falta WHATSAPP_PHONE_ID en config');
    return;
  }
  // Saneamos los valores: WhatsApp template no acepta saltos de línea ni más de
  // 4 espacios seguidos en una variable. Recortamos a 1024 chars por las dudas.
  const limpiar = (v) => String(v || '—').replace(/\s+/g, ' ').trim().slice(0, 1024);

  await axios.post(
    `https://graph.facebook.com/v19.0/${phoneId}/messages`,
    {
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'template',
      template: {
        name: 'lead_asignado',
        language: { code: 'es_AR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: limpiar(cliente) },
              { type: 'text', text: limpiar(vehiculo) },
              { type: 'text', text: limpiar(consulta) },
            ],
          },
        ],
      },
    },
    {
      headers: {
        Authorization: `Bearer ${config.WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  console.log(`[Escalado] Plantilla lead_asignado enviada a vendedor ${telefono}`);
}

module.exports = { enviarWhatsAppVendedor, enviarLeadAsignado };
