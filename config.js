// Configuración del bot
// Usa variables de entorno, con fallback solo para el verify token (no es secreto)

const limpiar = (v) => (v || '').trim();

module.exports = {
  WHATSAPP_VERIFY_TOKEN: limpiar(process.env.WHATSAPP_VERIFY_TOKEN) || 'procar2024',
  META_ACCESS_TOKEN: limpiar(process.env.META_ACCESS_TOKEN),
  INSTAGRAM_ACCESS_TOKEN: limpiar(process.env.INSTAGRAM_ACCESS_TOKEN),
  ANTHROPIC_API_KEY: limpiar(process.env.ANTHROPIC_API_KEY),
  WHATSAPP_PHONE_ID: limpiar(process.env.WHATSAPP_PHONE_ID),
};
