// Configuración del bot
// Usa variables de entorno, con fallback solo para el verify token (no es secreto)

module.exports = {
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || 'procar2024',
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID || '',
};
