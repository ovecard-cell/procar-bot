const cron = require('node-cron');
const { db, getSetting } = require('./database');

// Cadencia de recuperación — todo dentro de la ventana de 24hs de Meta
// Cada mensaje suma algo nuevo, no repite "te recuerdo"
const CADENCIA = [
  {
    tipo: '2h',
    horas: 2,
    texto: 'Che, ¿pudiste ver lo que te pasé? Cualquier duda decime.',
  },
  {
    tipo: '6h',
    horas: 6,
    texto: 'Si te interesa el auto, podemos ver tema financiación o si tenés algo para entregar en parte de pago. Avisame.',
  },
  {
    tipo: '18h',
    horas: 18,
    texto: 'Por si quedaste a medias o se te complicó el día, te dejo el WhatsApp: +54 9 379 487-4815. Cuando puedas retomamos por donde te quede más cómodo.',
  },
];

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

// Lógica principal: encontrar conversaciones colgadas y mandar el siguiente recordatorio según la cadencia
async function procesarRecordatorios() {
  // Si el agente está pausado, no mandamos recordatorios tampoco
  if (getSetting('agente_activo', 'true') !== 'true') {
    console.log('[Recordatorios] Agente pausado, salteamos esta vuelta');
    return;
  }

  const ahora = Date.now();
  const HORA = 60 * 60 * 1000;

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
    // Después de 23hs ya no mandamos nada (ventana de 24hs de Meta)
    if (horasSinRespuesta >= 23) continue;

    const ultimoRec = c.ultimo_recordatorio ? JSON.parse(c.ultimo_recordatorio) : null;
    const ultimoTipo = ultimoRec?.tipo || null;

    // Encontrar el siguiente paso de la cadencia que corresponde según horas y último enviado
    const siguiente = CADENCIA.find(p =>
      horasSinRespuesta >= p.horas && (ultimoTipo === null || CADENCIA.findIndex(x => x.tipo === ultimoTipo) < CADENCIA.findIndex(x => x.tipo === p.tipo))
    );

    if (!siguiente) continue;

    try {
      await enviarRecordatorio(c, siguiente.texto);
      db.prepare('INSERT INTO conversaciones (telefono, rol, contenido, canal) VALUES (?, ?, ?, ?)')
        .run(c.telefono, 'assistant', siguiente.texto, c.canal);
      const valor = JSON.stringify({ tipo: siguiente.tipo, fecha: new Date().toISOString() });
      db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?
      `).run(`recordatorio_${c.telefono}`, valor, valor);
      enviados++;
      console.log(`[Recordatorios] ${siguiente.tipo} enviado a ${c.telefono} (${c.canal}, ${horasSinRespuesta.toFixed(1)}hs)`);
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
  // Cada 15 minutos para reaccionar más rápido a los pasos de 2h/6h/18h
  cron.schedule('*/15 * * * *', () => {
    procesarRecordatorios().catch(err => console.error('[Recordatorios] Crash:', err.message));
  });
  console.log('[Recordatorios] Cron iniciado (cada 15 min, cadencia 2h/6h/18h)');
}

module.exports = { iniciarCron, procesarRecordatorios, limpiarRecordatorios };
