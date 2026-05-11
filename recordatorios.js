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
      'cualquier duda que tengas tirame, sin drama',
      '¿alguna pregunta puntual? avisame',
      'ahí cuando quieras avanzar decime',
    ]); },
  },
  {
    tipo: '6h',
    horas: 6,
    get texto() { return pick([
      '¿te quedó alguna duda? si querés pasá a verlo en persona, ahí terminás de decidir mejor',
      'si querés vení a verlo cuando puedas, el local está abierto',
      '¿te animás a venir a verlo? así lo charlamos en persona',
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

// IMPORTANTE: cuando el cliente ya fue escalado a un vendedor, NO le mandamos
// recordatorios al cliente — sería como que el bot lo persiga por algo que es
// problema interno nuestro (que el vendedor no respondió). En vez de eso, le
// avisamos al VENDEDOR que tiene un lead colgado (ver pingearVendedoresColgados).
const CADENCIA_POST_ESCALADO = [];

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

  // Horario silencioso: entre 00:00 y 07:00 (hora Argentina) NO mandamos
  // recordatorios ni re-enganches. La gente que dejó de hablar a las 11 de la
  // noche no quiere que le toque la puerta a las 2am — queda como bot acosador.
  // (Si un cliente ESCRIBE de madrugada, Gonzalo igual le contesta — esto solo
  // bloquea los recordatorios proactivos.)
  const horaArg = parseInt(new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false,
  }).format(new Date()), 10);
  if (horaArg >= 0 && horaArg < 7) {
    console.log(`[Recordatorios] Horario silencioso (${horaArg}hs), no mando nada`);
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

    // Si el bot está PAUSADO para esta conversación (vendedor humano la tomó),
    // NO mandamos recordatorio. Sino el bot pisa lo que el vendedor escribió a mano.
    if (getSetting(`bot_pausado_${c.telefono}`, 'false') === 'true') continue;

    const ultimoRec = c.ultimo_recordatorio ? JSON.parse(c.ultimo_recordatorio) : null;
    const ultimoTipo = ultimoRec?.tipo || null;

    // Si ya marcamos la ventana como cerrada, no reintentamos hasta que el
    // cliente vuelva a escribir (limpiarRecordatorios borra el flag).
    if (ultimoTipo === 'ventana_cerrada') continue;

    // Ventana de 24hs de Meta: se cuenta desde el ÚLTIMO MENSAJE DEL CLIENTE,
    // no desde el último mensaje del bot. Si pasaron >=24h sin que el cliente
    // escriba, Meta rechaza el envío con "fuera del período permitido".
    const ultimoUser = db.prepare(
      "SELECT creado_en FROM conversaciones WHERE telefono = ? AND rol = 'user' ORDER BY creado_en DESC LIMIT 1"
    ).get(c.telefono);
    if (!ultimoUser) continue;
    const horasDesdeUser = (ahora - new Date(ultimoUser.creado_en).getTime()) / HORA;
    if (horasDesdeUser >= 24) {
      const valor = JSON.stringify({ tipo: 'ventana_cerrada', fecha: new Date().toISOString() });
      db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?
      `).run(`recordatorio_${c.telefono}`, valor, valor);
      console.log(`[Recordatorios] Ventana cerrada para ${c.telefono} (${horasDesdeUser.toFixed(1)}h desde último msg del cliente)`);
      continue;
    }

    // Cadencia: contamos las horas desde el último mensaje DEL CLIENTE para
    // que los pasos 2h/6h/18h tengan sentido (sino se gatillan apenas el bot
    // contesta). horasSinRespuesta = horas desde que el cliente quedó callado.
    const horasSinRespuesta = horasDesdeUser;

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
// PING AL VENDEDOR — leads colgados de su lado
// Cada vez que corre el cron, miramos qué vendedores tienen leads donde:
//  - Está pausado el bot (vendedor a cargo)
//  - El último mensaje es del CLIENTE (rol=user)
//  - Pasó >2hs sin que el vendedor responda
//  - No le pingueamos en las últimas 4hs por ESE cliente
// Le mandamos al vendedor por WhatsApp un recordatorio puntual.
// ─────────────────────────────────────────────
async function pingearVendedoresColgados() {
  if (getSetting('agente_activo', 'true') !== 'true') return;

  // Respetamos horario silencioso 00-07 también para no despertar al vendedor
  const horaArg = parseInt(new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false,
  }).format(new Date()), 10);
  if (horaArg >= 0 && horaArg < 7) return;

  const candidatos = db.prepare(`
    SELECT c.telefono, c.canal, c.creado_en as ultimo_msg_cliente,
           v.id as vendedor_id, v.nombre as vendedor_nombre, v.telefono as vendedor_telefono,
           v.activo as vendedor_activo, v.disponible as vendedor_disponible,
           a.vehiculo_interes, a.cliente_nombre,
           (SELECT value FROM settings WHERE key = 'ping_vendedor_' || c.telefono) as ultimo_ping
    FROM conversaciones c
    JOIN asignaciones a ON a.cliente_telefono = c.telefono
    JOIN vendedores v ON v.id = a.vendedor_id
    WHERE c.id = (SELECT MAX(id) FROM conversaciones WHERE telefono = c.telefono)
      AND c.rol = 'user'
      AND a.creado_en = (SELECT MAX(creado_en) FROM asignaciones WHERE cliente_telefono = c.telefono)
      AND (SELECT value FROM settings WHERE key = 'bot_pausado_' || c.telefono) = 'true'
  `).all();

  let pingueados = 0;
  for (const c of candidatos) {
    const horasSinResponder = (Date.now() - new Date(c.ultimo_msg_cliente).getTime()) / (60 * 60 * 1000);
    if (horasSinResponder < 2) continue;
    if (!c.vendedor_activo || !c.vendedor_telefono) continue;

    // No spamear: si pingueamos por este cliente hace <4hs, salteamos.
    if (c.ultimo_ping) {
      const horasDesdeUltimoPing = (Date.now() - new Date(c.ultimo_ping).getTime()) / (60 * 60 * 1000);
      if (horasDesdeUltimoPing < 4) continue;
    }

    const cliente = c.cliente_nombre || `Cliente ${String(c.telefono).slice(-4)}`;
    const auto = c.vehiculo_interes || 'consulta';
    const horas = Math.floor(horasSinResponder);
    const texto = `🔔 ${c.vendedor_nombre}, ${cliente} (${auto}) está esperando tu respuesta hace ${horas}h. Le toca a vos contestarle.`;

    try {
      const { enviarWhatsAppVendedor } = require('./mensajero');
      await enviarWhatsAppVendedor(c.vendedor_telefono, texto);
      db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?
      `).run(`ping_vendedor_${c.telefono}`, new Date().toISOString(), new Date().toISOString());
      pingueados++;
      console.log(`[Ping vendedor] ${c.vendedor_nombre} avisado por ${cliente} (${horas}h sin respuesta)`);
    } catch (err) {
      // Probablemente WA todavía no aprobado — log silencioso.
      console.log(`[Ping vendedor] No pude avisar a ${c.vendedor_nombre} (WA no disponible): ${err.message}`);
    }
  }
  if (pingueados > 0) console.log(`[Ping vendedor] ${pingueados} vendedores avisados`);
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
      const msg = err.response?.data?.error?.message || err.message;
      // El error #133010 (Account not registered) es conocido y se va a repetir
      // hasta que aprueben el WA en Meta. Lo logueamos UNA sola vez por vuelta.
      if (msg.includes('133010') || msg.toLowerCase().includes('not registered')) {
        if (!cuentaNoRegistradaYaLogueado) {
          console.log(`[Cola WA] WhatsApp no registrado en Meta — ${pendientes.length} leads en cola esperando aprobacion`);
          cuentaNoRegistradaYaLogueado = true;
        }
      } else {
        console.error(`[Cola WA] Error notificando asignación ${a.id} → ${a.vendedor_nombre}:`, msg);
      }
    }
  }
  if (enviados > 0) {
    console.log(`[Cola WA] Vuelta: ${enviados} notificadas, ${fallados} con error, ${salteados} salteadas.`);
  }
}
// Flag para no spamear logs con el error de cuenta no registrada.
let cuentaNoRegistradaYaLogueado = false;

// ─────────────────────────────────────────────
// RESCATE DE LEADS (2026-05-10)
// Reemplaza al viejo procesarRecordatorios (kill-switch 2026-05-06).
// Logica simple: 1 umbral (4h), max 2 intentos, despues marca 'inactivo'.
// Si el lead tiene vendedor asignado → alerta vendedor por WA y NO toca al cliente.
// Si no tiene vendedor → genera mensaje contextual con Haiku y lo manda al cliente.
// Horario silencioso 00-07 ARG.
// ─────────────────────────────────────────────
const RESCATE_UMBRAL_HORAS = 4;
const RESCATE_MAX_INTENTOS = 2;

function leerEstadoRescate(telefono) {
  const raw = getSetting(`rescate_${telefono}`, null);
  if (!raw) return { intentos: 0, ultimo: null, estado: 'activo' };
  try { return JSON.parse(raw); } catch { return { intentos: 0, ultimo: null, estado: 'activo' }; }
}

function guardarEstadoRescate(telefono, est) {
  const valor = JSON.stringify(est);
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = ?
  `).run(`rescate_${telefono}`, valor, valor);
}

function limpiarRescate(telefono) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(`rescate_${telefono}`);
}

async function procesarRescateLeads() {
  if (getSetting('agente_activo', 'true') !== 'true') {
    console.log('[Rescate-leads] Agente pausado, salteamos vuelta');
    return;
  }

  const horaArg = parseInt(new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false,
  }).format(new Date()), 10);
  if (horaArg >= 0 && horaArg < 7) {
    console.log(`[Rescate-leads] Horario silencioso (${horaArg}hs), no mando nada`);
    return;
  }

  const ahora = Date.now();
  const HORA = 60 * 60 * 1000;

  // Candidatos: ultimo mensaje del cliente >= 4h atras, ventana 24h Meta abierta,
  // bot no pausado por humano (eso se chequea por cliente porque tiene vendedor asig).
  const candidatos = db.prepare(`
    SELECT c.telefono, c.canal,
           (SELECT creado_en FROM conversaciones WHERE telefono = c.telefono AND rol = 'user' ORDER BY creado_en DESC LIMIT 1) as ultimo_user_ts,
           (SELECT contenido FROM conversaciones WHERE telefono = c.telefono AND rol = 'user' ORDER BY creado_en DESC LIMIT 1) as ultimo_user_txt,
           (SELECT rol FROM conversaciones WHERE telefono = c.telefono ORDER BY creado_en DESC LIMIT 1) as ultimo_rol
    FROM conversaciones c
    GROUP BY c.telefono
  `).all();

  let enviadosCliente = 0, alertasVendedor = 0, marcadosInactivos = 0, errores = 0;

  for (const c of candidatos) {
    if (!c.ultimo_user_ts) continue;
    const horasSinResponder = (ahora - new Date(c.ultimo_user_ts).getTime()) / HORA;
    if (horasSinResponder < RESCATE_UMBRAL_HORAS) continue;
    if (horasSinResponder >= 24) continue; // ventana Meta cerrada
    // Si el ultimo mensaje es del cliente, todavia no respondio el bot/vendedor:
    // tiene sentido rescatar. Si el ultimo es del assistant, tambien aplica
    // (bot mando algo y el cliente nunca contesto).

    const est = leerEstadoRescate(c.telefono);
    if (est.estado === 'inactivo') continue;
    if (est.intentos >= RESCATE_MAX_INTENTOS) {
      guardarEstadoRescate(c.telefono, { ...est, estado: 'inactivo' });
      marcadosInactivos++;
      console.log(`[Rescate-leads] ${c.telefono} marcado inactivo (alcanzo ${est.intentos} intentos)`);
      continue;
    }
    // No reintentar antes de 4h desde el ultimo intento de rescate
    if (est.ultimo) {
      const horasDesdeUltimoIntento = (ahora - new Date(est.ultimo).getTime()) / HORA;
      if (horasDesdeUltimoIntento < RESCATE_UMBRAL_HORAS) continue;
    }

    // Buscar si el cliente tiene asignacion a vendedor
    const asig = db.prepare(`
      SELECT a.id, a.cliente_nombre, v.id as vid, v.nombre as vendedor_nombre,
             v.telefono as vendedor_telefono, v.activo as vendedor_activo
      FROM asignaciones a
      JOIN vendedores v ON v.id = a.vendedor_id
      WHERE a.cliente_telefono = ?
      ORDER BY a.creado_en DESC LIMIT 1
    `).get(c.telefono);

    if (asig && asig.vendedor_activo && asig.vendedor_telefono) {
      // ─── Lead con vendedor asignado: alerta WhatsApp al vendedor ───
      const nombreCliente = asig.cliente_nombre || `Cliente ${String(c.telefono).slice(-4)}`;
      const previewMsg = (c.ultimo_user_txt || '').trim().slice(0, 180);
      const textoAlerta = previewMsg
        ? `${asig.vendedor_nombre}, ${nombreCliente} sigue sin respuesta. Último mensaje: "${previewMsg}"`
        : `${asig.vendedor_nombre}, ${nombreCliente} sigue sin respuesta.`;

      try {
        const { enviarWhatsAppVendedor } = require('./mensajero');
        await enviarWhatsAppVendedor(asig.vendedor_telefono, textoAlerta);
        guardarEstadoRescate(c.telefono, {
          intentos: est.intentos + 1,
          ultimo: new Date().toISOString(),
          estado: est.intentos + 1 >= RESCATE_MAX_INTENTOS ? 'inactivo' : 'activo',
          tipo: 'alerta_vendedor',
        });
        alertasVendedor++;
        console.log(`[Rescate-leads] Alerta a vendedor ${asig.vendedor_nombre} por ${nombreCliente} (intento ${est.intentos + 1})`);
      } catch (err) {
        errores++;
        console.log(`[Rescate-leads] No pude avisar a ${asig.vendedor_nombre} (WA no disponible): ${err.message}`);
      }
      continue;
    }

    // ─── Sin vendedor asignado: bot manda mensaje contextual al cliente ───
    // Si el bot esta pausado para esta conversacion (vendedor humano metio mano),
    // no mandamos nada — respetamos al humano.
    if (getSetting(`bot_pausado_${c.telefono}`, 'false') === 'true') continue;

    let texto = null;
    try {
      const { generarMensajeRescateLead } = require('./agente');
      texto = await generarMensajeRescateLead(c.telefono);
    } catch (err) {
      console.error(`[Rescate-leads] LLM fallo para ${c.telefono}:`, err.message);
    }
    if (!texto || !texto.trim()) continue;

    try {
      await enviarRecordatorio(c, texto);
      db.prepare('INSERT INTO conversaciones (telefono, rol, contenido, canal) VALUES (?, ?, ?, ?)')
        .run(c.telefono, 'assistant', texto, c.canal);
      guardarEstadoRescate(c.telefono, {
        intentos: est.intentos + 1,
        ultimo: new Date().toISOString(),
        estado: est.intentos + 1 >= RESCATE_MAX_INTENTOS ? 'inactivo' : 'activo',
        tipo: 'mensaje_cliente',
      });
      enviadosCliente++;
      console.log(`[Rescate-leads] Mensaje al cliente ${c.telefono} (${c.canal}, ${horasSinResponder.toFixed(1)}h, intento ${est.intentos + 1})`);
    } catch (err) {
      errores++;
      console.error(`[Rescate-leads] Error enviando a ${c.telefono}:`, err.response?.data?.error?.message || err.message);
    }
  }

  if (enviadosCliente || alertasVendedor || marcadosInactivos || errores) {
    console.log(`[Rescate-leads] Vuelta: ${enviadosCliente} cliente, ${alertasVendedor} vendedor, ${marcadosInactivos} inactivos, ${errores} errores`);
  }
}

function iniciarCron() {
  // 2026-05-10: REACTIVADO el rescate de leads.
  // Reemplaza al viejo procesarRecordatorios (kill switch 2026-05-06) y al
  // pingearVendedoresColgados (que duplicaba alerta al vendedor con umbral distinto).
  // Cron unico cada 30min, costo controlado (max 2 intentos por conversacion).
  cron.schedule('*/30 * * * *', () => {
    procesarRescateLeads().catch(err => console.error('[Rescate-leads] Crash:', err.message));
  });
  // Cada 5 minutos chequeamos la cola de notificaciones a vendedores (asignaciones
  // que esperan a que el vendedor se ponga "disponible"). No usa LLM.
  cron.schedule('*/5 * * * *', () => {
    procesarColaDeNotificacionesAVendedores().catch(err => console.error('[Cola WA] Crash:', err.message));
  });
  console.log('[Recordatorios] Cron iniciado — rescate-leads cada 30min, cola WA cada 5min');
}

module.exports = {
  iniciarCron,
  procesarRecordatorios,
  procesarRescateLeads,
  limpiarRecordatorios,
  limpiarRescate,
  procesarColaDeNotificacionesAVendedores,
};
