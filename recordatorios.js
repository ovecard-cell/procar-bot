const cron = require('node-cron');
const { db, getSetting } = require('./database');

// Cadencia de recuperación — todo dentro de la ventana de 24hs de Meta
// Cada mensaje suma algo nuevo, no repite "te recuerdo"
// Tenemos dos modos: general (no escalado) y postEscalado (ya hubo vendedor asignado)
const CADENCIA_GENERAL = [
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
    texto: 'Quedo atento por si querés retomar. Acá o por el WhatsApp que te pasé, lo que te quede más cómodo.',
  },
];

const CADENCIA_POST_ESCALADO = [
  {
    tipo: 'esc_6h',
    horas: 6,
    plantilla: (vendedor) => `Che, ¿pudo escribirte ${vendedor || 'el vendedor'}? Si todavía no, decime y reviso.`,
  },
  {
    tipo: 'esc_18h',
    horas: 18,
    plantilla: (vendedor) => `¿Qué te pareció la propuesta de ${vendedor || 'el vendedor'}? Cualquier ajuste que necesites decime, vemos cómo armarlo.`,
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
      { headers: { Authorization: `Bearer ${config.WA_TOKEN}`, 'Content-Type': 'application/json' } }
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

// ─────────────────────────────────────────────
// RESCATE: si vendedor se cuelga, el bot retoma
// ─────────────────────────────────────────────
async function rescatarConversacionesColgadas() {
  if (getSetting('agente_activo', 'true') !== 'true') return;

  const ahora = Date.now();
  const HORA = 60 * 60 * 1000;

  // Conversaciones donde:
  // - Hubo asignación a vendedor (bot pausado)
  // - El cliente escribió DESPUÉS de la asignación
  // - El vendedor NO respondió en >30 min desde que el cliente escribió
  const candidatos = db.prepare(`
    SELECT c.telefono, c.canal, c.creado_en as ultimo_msg_cliente,
           a.creado_en as fecha_asignacion,
           v.nombre as vendedor_nombre
    FROM conversaciones c
    JOIN asignaciones a ON a.cliente_telefono = c.telefono
    JOIN vendedores v ON v.id = a.vendedor_id
    WHERE c.rol = 'user'
      AND c.creado_en = (
        SELECT MAX(creado_en) FROM conversaciones WHERE telefono = c.telefono
      )
      AND a.creado_en = (
        SELECT MAX(creado_en) FROM asignaciones WHERE cliente_telefono = c.telefono
      )
      AND c.creado_en > a.creado_en
  `).all();

  let rescatados = 0;
  const { generarRespuestaRescate } = require('./agente');
  for (const c of candidatos) {
    const minSinRespuesta = (ahora - new Date(c.ultimo_msg_cliente).getTime()) / (60 * 1000);
    // 30 min sin que el vendedor responda en el dashboard
    if (minSinRespuesta < 30) continue;

    // Reactivar el bot para esta conversación
    const { setSetting } = require('./database');
    setSetting(`bot_pausado_${c.telefono}`, 'false');

    let texto;
    try {
      // Generamos la respuesta con el LLM, así Gonzalo lee el historial,
      // sabe la hora actual, y puede contestar la pregunta pendiente del cliente
      // y avisar el horario real del vendedor.
      texto = await generarRespuestaRescate(c.telefono, c.vendedor_nombre);
      if (!texto || !texto.trim()) {
        // Fallback si el LLM no devolvió nada
        texto = `Disculpá la demora, ${c.vendedor_nombre || 'el vendedor'} está con otro cliente. Te escribe en cuanto pueda.`;
      }
    } catch (err) {
      console.error(`[Rescate] Error generando respuesta LLM para ${c.telefono}:`, err.message);
      texto = `Disculpá la demora, ${c.vendedor_nombre || 'el vendedor'} está con otro cliente. Te escribe en cuanto pueda.`;
    }

    try {
      await enviarRecordatorio(c, texto);
      db.prepare('INSERT INTO conversaciones (telefono, rol, contenido, canal) VALUES (?, ?, ?, ?)')
        .run(c.telefono, 'assistant', texto, c.canal);
      console.log(`[Rescate] Bot retomó conversación de ${c.telefono} (vendedor ${c.vendedor_nombre} colgado ${minSinRespuesta.toFixed(0)} min)`);
      rescatados++;
    } catch (err) {
      console.error(`[Rescate] Error con ${c.telefono}:`, err.message);
    }
  }

  if (rescatados > 0) console.log(`[Rescate] ${rescatados} conversaciones retomadas por el bot`);
}

function iniciarCron() {
  // Cada 15 minutos para recordatorios y rescates
  cron.schedule('*/15 * * * *', () => {
    procesarRecordatorios().catch(err => console.error('[Recordatorios] Crash:', err.message));
    rescatarConversacionesColgadas().catch(err => console.error('[Rescate] Crash:', err.message));
  });
  console.log('[Recordatorios] Cron iniciado (cada 15 min, recordatorios + rescate)');
}

module.exports = { iniciarCron, procesarRecordatorios, limpiarRecordatorios };
