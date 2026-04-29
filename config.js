// Configuración del bot
// Usa variables de entorno, con fallback solo para el verify token (no es secreto)

const limpiar = (v) => (v || '').trim();

// Token específico para WhatsApp Business (con permisos whatsapp_business_management
// y whatsapp_business_messaging). Si no está, caemos al META_ACCESS_TOKEN, pero
// hay endpoints de WA que solo andan con el token específico.
const WHATSAPP_TOKEN = limpiar(process.env.WHATSAPP_TOKEN);
const META_ACCESS_TOKEN = limpiar(process.env.META_ACCESS_TOKEN);

module.exports = {
  WHATSAPP_VERIFY_TOKEN: limpiar(process.env.WHATSAPP_VERIFY_TOKEN) || 'procar2024',
  META_ACCESS_TOKEN,
  INSTAGRAM_ACCESS_TOKEN: limpiar(process.env.INSTAGRAM_ACCESS_TOKEN),
  ANTHROPIC_API_KEY: limpiar(process.env.ANTHROPIC_API_KEY),
  WHATSAPP_PHONE_ID: limpiar(process.env.WHATSAPP_PHONE_ID),
  WHATSAPP_TOKEN,
  // Helper: el token correcto para llamar a las APIs de WhatsApp
  WA_TOKEN: WHATSAPP_TOKEN || META_ACCESS_TOKEN,
};
