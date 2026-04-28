const cron = require('node-cron');
const { db, getSetting } = require('./database');

// Texto del primer recordatorio (24hs sin respuesta)
const TEXTO_24H = '¡Che! ¿Pudiste ver lo que te pasé? Si tenés alguna duda escribime por acá, o si querés te paso al vendedor para coordinar algo.';

// Texto del segundo y último recordatorio (72hs sin respuesta)
const TEXTO_72H = 'Te dejo el WhatsApp de la agencia por las dudas: +54 9 379 487-4815. Cuando puedas retomar la conversación, escribime acá o por WhatsApp. ¡Saludos!';

// Quién manda el recordatorio según el canal
async function enviarRecordatorio(cliente, texto) {
  const config = require('./config');
  const axios = require('axios');

  if (cliente.canal === 'messenger' || cliente.canal === 'facebook') {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      { recipient: { id: cliente.telefono }, message: { text: texto } },
      { headers: { Authorization: `Bearer ${config.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } else if (cliente.canal === 'instagram') {
    await axios.post(
      `https://graph.instagram.com/v21.0/me/messages`,
      { recipient: { id: cliente.telefono }, message: { text: texto } },
      { headers: { Authorization: `Bearer ${config.INSTAGRAM_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } else if (cliente.canal === 'whatsapp' && config.WHATSAPP_PHONE_ID) {
    await axios.post(
      `https://graph.facebook.com/v19.0/${config.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', to: cliente.telefono, type: 'text', text: { body: texto } },
      { headers: { Authorization: `Bearer ${config.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } else {
    throw new Error(`Canal ${cliente.canal} no soportado para recordatorios`);
  }
}

// Lógica principal: encontrar conversaciones colgadas y mandar recordatorio
async function procesarRecordatorios() {
  // Si el agente está pausado, no mandamos recordatorios tampoco
  if (getSetting('agente_activo', 'true') !== 'true') {
    console.log('[Recordatorios] Agente pausado, salteamos esta vuelta');
    return;
  }

  const ahora = Date.now();
  const HORA = 60 * 60 * 1000;

  // Buscar todas las conversaciones cuyo último mensaje fue del bot (assistant)
  // y agrupar por telefono
  const candidatos = db.prepare(`
    SELECT c.telefono, c.canal,
           MAX(c.creado_en) as ultimo_msg,
           (SELECT rol FROM conversaciones WHERE telefono = c.telefono ORDER BY creado_en DESC LIMIT 1) as ultimo_rol,
           (SELECT value FROM settings WHERE key = 'recordatorio_' || c.telefono) as ultimo_recordatorio
    FROM conversaciones c
    GROUP BY c.telefono
  `).all();

  let enviados = 0, errores = 0;

  for (const c of candidatos) {
    if (c.ultimo_rol !== 'assistant') continue;

    const horasSinRespuesta = (ahora - new Date(c.ultimo_msg).getTime()) / HORA;
    const ultimoRec = c.ultimo_recordatorio ? JSON.parse(c.ultimo_recordatorio) : null;

    let texto = null;

    // Primer recordatorio a las 24hs
    if (horasSinRespuesta >= 24 && (!ultimoRec || ultimoRec.tipo !== '24h')) {
      texto = TEXTO_24H;
    }
    // Segundo recordatorio a las 72hs (3 días)
    else if (horasSinRespuesta >= 72 && ultimoRec?.tipo === '24h') {
      texto = TEXTO_72H;
    }

    if (!texto) continue;

    try {
      await enviarRecordatorio(c, texto);
      // Guardar el mensaje en la DB
      db.prepare('INSERT INTO conversaciones (telefono, rol, contenido, canal) VALUES (?, ?, ?, ?)')
        .run(c.telefono, 'assistant', texto, c.canal);
      // Marcar el recordatorio enviado
      const tipo = (ultimoRec?.tipo === '24h') ? '72h' : '24h';
      db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?
      `).run(`recordatorio_${c.telefono}`, JSON.stringify({ tipo, fecha: new Date().toISOString() }),
              JSON.stringify({ tipo, fecha: new Date().toISOString() }));
      enviados++;
      console.log(`[Recordatorios] ${tipo} enviado a ${c.telefono} (${c.canal}, ${horasSinRespuesta.toFixed(1)}hs)`);
    } catch (err) {
      errores++;
      console.error(`[Recordatorios] Error con ${c.telefono}:`, err.response?.data?.error?.message || err.message);
    }
  }

  if (enviados > 0 || errores > 0) {
    console.log(`[Recordatorios] Vuelta completa: ${enviados} enviados, ${errores} errores`);
  }
}

// Resetear el flag de recordatorio cuando el cliente vuelve a escribir
function limpiarRecordatorios(telefono) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(`recordatorio_${telefono}`);
}

function iniciarCron() {
  // Cada 30 minutos
  cron.schedule('*/30 * * * *', () => {
    procesarRecordatorios().catch(err => console.error('[Recordatorios] Crash:', err.message));
  });
  console.log('[Recordatorios] Cron iniciado (cada 30 min)');
}

module.exports = { iniciarCron, procesarRecordatorios, limpiarRecordatorios };
