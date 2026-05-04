const cron = require('node-cron');
const { db, getSetting } = require('./database');

// Cadencia de recuperación — todo dentro de la ventana de 24hs de Meta
// Cada mensaje suma algo nuevo, no repite "te recuerdo"
// Tenemos dos modos: general (no escalado) y postEscalado (ya hubo vendedor asignado)
// Cada paso tiene varias variantes — elegimos una random así no suena enlatado.
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const CADENCIA_GENERAL = [
  {
    tipo: '2h',
    horas: 2,
    get texto() { return pick([
      'che, ¿le diste una mirada? cualquier cosa decime',
      '¿qué te pareció? si querés saber algo puntual decime',
      'ahí cualquier duda que tengas tirame, sin drama',
      '¿pudiste ver? si tenés alguna pregunta avisame',
    ]); },
  },
  {
    tipo: '6h',
    horas: 6,
    get texto() { return pick([
      'che, ¿lo pensaste? si querés te lo muestro en el local cuando puedas, así lo ves en vivo',
      'hola, ¿qué decís del auto? si te queda más cómodo vení a verlo, total el local está abierto',
      '¿te quedaste pensando? si querés pasá a verlo en persona, ahí terminás de decidir mejor',
      'si todavía estás interesado, ¿te animás a venir a verlo? así lo charlamos en persona',
    ]); },
  },
  {
    tipo: '18h',
    horas: 18,
    get texto() { return pick([
      'cualquier cosa estoy por acá ✌️',
      'si querés retomar avisame, igual te dejo tranqui',
      'ahí cuando quieras seguimos, sin apuro',
      'te dejo tranquilo. cualquier cosa estoy 👍',
    ]); },
  },
];

const CADENCIA_POST_ESCALADO = [
  {
    tipo: 'esc_6h',
    horas: 6,
    plantilla: (vendedor) => pick([
      `che, ¿pudo escribirte ${vendedor || 'el vendedor'}? si no, avisame y le toco la puerta`,
      `¿${vendedor || 'el vendedor'} ya se comunicó? cualquier cosa decime`,
      `¿te llegó el mensaje de ${vendedor || 'el vendedor'}? si no, lo apuro`,
    ]),
  },
  {
    tipo: 'esc_18h',
    horas: 18,
    plantilla: (vendedor) => pick([
      `¿qué te pareció lo que te pasó ${vendedor || 'el vendedor'}? si hay algo para ajustar, decime y vemos`,
      `che, ¿pudiste hablar con ${vendedor || 'el vendedor'}? cualquier cosa que quieras revisar avisame`,
      `¿cómo quedó la cosa con ${vendedor || 'el vendedor'}? si querés ajustar algo decime`,
    ]),
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
    const { normalizarTelefonoWA } = require('./mensajero');
    const destino = normalizarTelefonoWA(cliente.telefono);
    await axios.post(
      `https://graph.facebook.com/v19.0/${config.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', to: destino, type: 'text', text: { body: texto } },
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
    // Elegimos cadencia según si ya hubo escalado a vendedor o no.
    const yaEscalado = !!db.prepare('SELECT 1 FROM asignaciones WHERE cliente_telefono = ? LIMIT 1').get(c.telefono);
    const cadencia = yaEscalado ? CADENCIA_POST_ESCALADO : CADENCIA_GENERAL;

    const siguiente = cadencia.find(p =>
      horasSinRespuesta >= p.horas && (ultimoTipo === null || cadencia.findIndex(x => x.tipo === ultimoTipo) < cadencia.findIndex(x => x.tipo === p.tipo))
    );

    if (!siguiente) continue;

    // Buscamos vendedor (si hubo escalado) para pasarle al LLM/plantilla.
    const vendedorRow = db.prepare(`
      SELECT v.nombre FROM asignaciones a
      JOIN vendedores v ON v.id = a.vendedor_id
      WHERE a.cliente_telefono = ? ORDER BY a.creado_en DESC LIMIT 1
    `).get(c.telefono);
    const vendedorNombre = vendedorRow?.nombre || null;

    // Intentamos generar un mensaje contextual con el LLM (lee la conversación).
    // Si el LLM falla o devuelve vacío, caemos al texto fijo (variante random).
    let texto = null;
    try {
      const { generarRecordatorioContextual } = require('./agente');
      texto = await generarRecordatorioContextual(c.telefono, siguiente.tipo, vendedorNombre);
    } catch (err) {
      console.error(`[Recordatorios] LLM falló para ${c.telefono}, uso fallback:`, err.message);
    }
    if (!texto) {
      texto = siguiente.texto || (siguiente.plantilla && siguiente.plantilla(vendedorNombre));
    }
    if (!texto) continue;

    try {
      await enviarRecordatorio(c, texto);
      db.prepare('INSERT INTO conversaciones (telefono, rol, contenido, canal) VALUES (?, ?, ?, ?)')
        .run(c.telefono, 'assistant', texto, c.canal);
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

// ─────────────────────────────────────────────
// COLA DE NOTIFICACIONES A VENDEDORES
// Si entra un lead cuando el vendedor asignado tiene "no recibir leads"
// activado, no le tocamos la puerta. Encolamos y mandamos cuando se ponga
// como "disponible" otra vez.
// ─────────────────────────────────────────────
async function procesarColaDeNotificacionesAVendedores() {
  const { asignacionesPendientesDeNotificar, marcarAsignacionNotificada } = require('./database');
  const { enviarLeadAsignado } = require('./mensajero');
  const pendientes = asignacionesPendientesDeNotificar();
  if (pendientes.length === 0) return;

  let enviados = 0, fallados = 0, salteados = 0;
  for (const a of pendientes) {
    if (!a.vendedor_activo) {
      // Pausado por el admin — no le mandamos nunca. Marcamos como notificado
      // para no dejar la asignación colgada (igual queda visible en el dashboard).
      marcarAsignacionNotificada(a.id);
      console.log(`[Cola WA] Asignación ${a.id} de ${a.vendedor_nombre} (pausado por admin): salteada.`);
      salteados++;
      continue;
    }
    if (!a.vendedor_disponible) {
      // Vendedor todavía con "no recibir leads" — esperamos a que vuelva.
      continue;
    }
    try {
      await enviarLeadAsignado(a.vendedor_telefono, {
        cliente: a.cliente_nombre || `Cliente ${String(a.cliente_telefono).slice(-4)}`,
        vehiculo: a.vehiculo_interes || 'consulta general',
        consulta: a.motivo || 'sin detalle',
      });
      marcarAsignacionNotificada(a.id);
      enviados++;
      console.log(`[Cola WA] Notificada asignación ${a.id} → ${a.vendedor_nombre}`);
    } catch (err) {
      fallados++;
      console.error(`[Cola WA] Error notificando asignación ${a.id} → ${a.vendedor_nombre}:`,
        err.response?.data?.error?.message || err.message);
    }
  }
  if (enviados > 0 || fallados > 0 || salteados > 0) {
    console.log(`[Cola WA] Vuelta: ${enviados} notificadas, ${fallados} con error, ${salteados} salteadas.`);
  }
}

function iniciarCron() {
  // Cada 15 minutos: recordatorios al cliente.
  // Antes acá tambien corria el rescate del bot (que reactivaba a Gonzalo si el
  // vendedor se colgaba). Lo sacamos: el dashboard ahora muestra alerta visual
  // al vendedor en vez de meter al bot a la conversacion.
  cron.schedule('*/15 * * * *', () => {
    procesarRecordatorios().catch(err => console.error('[Recordatorios] Crash:', err.message));
  });
  // Cada 5 minutos chequeamos la cola de notificaciones a vendedores. Es liviano:
  // si estamos fuera de horario, ni se conecta. Si entramos en horario, vacía la cola.
  cron.schedule('*/5 * * * *', () => {
    procesarColaDeNotificacionesAVendedores().catch(err => console.error('[Cola WA] Crash:', err.message));
  });
  console.log('[Recordatorios] Cron iniciado (recordatorios cada 15min, cola WA cada 5min — rescate desactivado)');
}

module.exports = { iniciarCron, procesarRecordatorios, limpiarRecordatorios, procesarColaDeNotificacionesAVendedores };
