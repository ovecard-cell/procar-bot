require('dotenv').config();

const relevantKeys = Object.keys(process.env).filter(k =>
  k.includes('WHATSAPP') || k.includes('META') || k.includes('ANTHROPIC') || k.includes('INSTAGRAM')
);
console.log('[DEBUG] Env vars relevantes encontradas:', relevantKeys);
console.log('[DEBUG] WHATSAPP_VERIFY_TOKEN:', process.env.WHATSAPP_VERIFY_TOKEN ? 'CARGADO' : 'UNDEFINED');
console.log('[DEBUG] META_ACCESS_TOKEN:', process.env.META_ACCESS_TOKEN ? 'CARGADO' : 'UNDEFINED');
console.log('[DEBUG] ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'CARGADO' : 'UNDEFINED');
console.log('[DEBUG] INSTAGRAM_ACCESS_TOKEN:', process.env.INSTAGRAM_ACCESS_TOKEN ? 'CARGADO' : 'UNDEFINED');

const express = require('express');
const path = require('path');
const { inicializarDB, cargarAutosEjemplo, cargarVendedoresEjemplo, getSetting, setSetting } = require('./database');
const { verificarWebhook, recibirMensaje, validarToken, enviarMessenger, enviarInstagram, enviarWhatsApp } = require('./webhook');
const { procesarMensaje } = require('./agente');
const { analizar, generarHTML } = require('./analizar');
const { distribuirLeads, generarHTMLReporte } = require('./distribuir');

const app = express();
const PORT = process.env.PORT || 3000;

// Parsear JSON de los webhooks de Meta
app.use(express.json());

// Inicializar base de datos y vendedores (sin autos de ejemplo — Gonzalo escala todo)
inicializarDB();
cargarVendedoresEjemplo();

// Health check
app.get('/', (req, res) => {
  res.send('Bot Procar funcionando correctamente');
});

// Mapa del proyecto (lectura del ROADMAP.md)
app.get('/mapa', (req, res) => {
  const fs = require('fs');
  try {
    const md = fs.readFileSync(path.join(__dirname, 'ROADMAP.md'), 'utf8');
    const html = md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/^- \[x\] (.+)$/gm, '<li class="done">✅ $1</li>')
      .replace(/^- \[ \] (.+)$/gm, '<li class="todo">⬜ $1</li>')
      .replace(/^- (.+)$/gm, '<li>• $1</li>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n\n/g, '<br><br>');
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Mapa Procar Bot</title>
      <style>
        body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 32px; background: #0f0f1a; color: #e8e8f0; line-height: 1.6; }
        h1 { color: #C9A84C; border-bottom: 2px solid #C9A84C; padding-bottom: 12px; }
        h2 { color: #C9A84C; margin-top: 32px; }
        h3 { color: #fff; margin-top: 20px; }
        li { list-style: none; padding: 4px 0; }
        li.done { color: #2a9d8f; }
        li.todo { color: #f4a261; }
        code { background: #1a1a2e; padding: 2px 6px; border-radius: 4px; color: #C9A84C; }
        a { color: #C9A84C; }
        strong { color: #fff; }
      </style></head><body>${html}</body></html>`);
  } catch (err) {
    res.status(500).send('Error leyendo el mapa: ' + err.message);
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Demo de chat (testing local)
app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, 'demo.html'));
});

// Política de privacidad (servida desde el bot mismo)
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy.html'));
});

app.get('/privacy.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy.html'));
});

// Dashboard de admin (jefe ve todo)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Dashboard por vendedor (solo ve sus asignados)
app.get('/vendedor/:nombre', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// API JSON para el dashboard
app.get('/api/stats', (req, res) => {
  const { db } = require('./database');
  const vendedor = req.query.vendedor;
  const hoy = new Date(); hoy.setHours(0,0,0,0);

  if (vendedor) {
    // Stats filtradas para un vendedor
    const filtroSql = `
      AND c.telefono IN (
        SELECT a.cliente_telefono FROM asignaciones a
        JOIN vendedores v ON v.id = a.vendedor_id
        WHERE LOWER(v.nombre) = LOWER(?)
      )
    `;
    const mensajesHoy = db.prepare(`SELECT COUNT(*) as n FROM conversaciones c WHERE c.creado_en >= ? ${filtroSql}`).get(hoy.toISOString(), vendedor).n;
    const clientes = db.prepare(`SELECT COUNT(DISTINCT c.telefono) as n FROM conversaciones c WHERE 1=1 ${filtroSql}`).get(vendedor).n;
    const asignacionesV = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN estado='pendiente' THEN 1 ELSE 0 END) as pendientes,
             SUM(CASE WHEN estado='cerrado' THEN 1 ELSE 0 END) as cerrados
      FROM asignaciones a
      JOIN vendedores v ON v.id = a.vendedor_id
      WHERE LOWER(v.nombre) = LOWER(?)
    `).get(vendedor);
    return res.json({
      vendedor,
      mensajes_hoy: mensajesHoy,
      clientes_unicos: clientes,
      leads: clientes,
      asignaciones: asignacionesV.total || 0,
      pendientes: asignacionesV.pendientes || 0,
      cerrados: asignacionesV.cerrados || 0,
    });
  }

  const mensajesHoy = db.prepare('SELECT COUNT(*) as n FROM conversaciones WHERE creado_en >= ?').get(hoy.toISOString()).n;
  const clientes = db.prepare('SELECT COUNT(DISTINCT telefono) as n FROM conversaciones').get().n;
  const leads = db.prepare('SELECT COUNT(*) as n FROM clientes').get().n;
  const asignaciones = db.prepare('SELECT COUNT(*) as n FROM asignaciones').get().n;
  const porCanal = db.prepare(`
    SELECT canal, COUNT(DISTINCT telefono) as clientes, COUNT(*) as mensajes
    FROM conversaciones
    GROUP BY canal
  `).all();
  res.json({ mensajes_hoy: mensajesHoy, clientes_unicos: clientes, leads, asignaciones, por_canal: porCanal });
});

app.get('/api/asignaciones', (req, res) => {
  const { db } = require('./database');
  const todas = db.prepare(`
    SELECT a.id, a.cliente_telefono, a.motivo, a.estado, a.creado_en,
           v.nombre as vendedor, v.telefono as vendedor_telefono,
           cl.nombre as cliente_nombre
    FROM asignaciones a
    JOIN vendedores v ON v.id = a.vendedor_id
    LEFT JOIN clientes cl ON cl.telefono = a.cliente_telefono
    ORDER BY a.creado_en DESC
    LIMIT 50
  `).all();
  const porVendedor = db.prepare(`
    SELECT v.nombre, v.activo, v.canales, COUNT(a.id) as total,
           SUM(CASE WHEN a.estado = 'pendiente' THEN 1 ELSE 0 END) as pendientes,
           SUM(CASE WHEN a.estado = 'cerrado' THEN 1 ELSE 0 END) as cerrados
    FROM vendedores v
    LEFT JOIN asignaciones a ON a.vendedor_id = v.id
    GROUP BY v.id
    ORDER BY v.activo DESC, total DESC
  `).all();
  res.json({ asignaciones: todas, por_vendedor: porVendedor });
});

app.get('/api/estado', (req, res) => {
  res.json({ activo: getSetting('agente_activo', 'true') === 'true' });
});

app.get('/api/conversaciones', (req, res) => {
  const { db } = require('./database');
  const vendedor = req.query.vendedor;

  let query = `
    SELECT c.telefono, c.canal, MAX(c.creado_en) as ultimo,
           cl.nombre,
           (SELECT contenido FROM conversaciones WHERE telefono = c.telefono ORDER BY creado_en DESC LIMIT 1) as preview,
           (SELECT v.nombre FROM asignaciones a JOIN vendedores v ON v.id = a.vendedor_id
            WHERE a.cliente_telefono = c.telefono ORDER BY a.creado_en DESC LIMIT 1) as vendedor_asignado
    FROM conversaciones c
    LEFT JOIN clientes cl ON cl.telefono = c.telefono
  `;
  const params = [];

  if (vendedor) {
    query += `
      WHERE c.telefono IN (
        SELECT a.cliente_telefono FROM asignaciones a
        JOIN vendedores v ON v.id = a.vendedor_id
        WHERE LOWER(v.nombre) = LOWER(?)
      )
    `;
    params.push(vendedor);
  }

  query += ` GROUP BY c.telefono ORDER BY ultimo DESC LIMIT 100`;
  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

// Vendedor escribe al cliente desde el dashboard
app.post('/api/conversacion/:telefono/enviar', async (req, res) => {
  try {
    const { db, guardarMensaje } = require('./database');
    const telefono = req.params.telefono;
    const { texto, vendedor } = req.body;

    if (!texto || !texto.trim()) {
      return res.status(400).json({ error: 'Falta texto' });
    }

    // Detectar el canal a partir de la última conversación
    const ultimo = db.prepare(`
      SELECT canal FROM conversaciones WHERE telefono = ? ORDER BY creado_en DESC LIMIT 1
    `).get(telefono);

    if (!ultimo) {
      return res.status(404).json({ error: 'No hay conversación previa con ese cliente' });
    }

    const canal = ultimo.canal;
    const mensaje = vendedor ? `${texto}` : texto;

    // Pausar el bot para esta conversación si no estaba pausado
    setSetting(`bot_pausado_${telefono}`, 'true');

    // Enviar al cliente por el canal correspondiente
    if (canal === 'messenger' || canal === 'facebook') {
      await enviarMessenger(telefono, mensaje);
    } else if (canal === 'instagram') {
      await enviarInstagram(telefono, mensaje);
    } else if (canal === 'whatsapp') {
      const config = require('./config');
      await enviarWhatsApp(config.WHATSAPP_PHONE_ID, telefono, mensaje);
    } else {
      return res.status(400).json({ error: `Canal ${canal} no soportado` });
    }

    // Guardar el mensaje en la DB con marca de quién lo escribió
    const contenido = vendedor ? `[${vendedor}] ${texto}` : texto;
    guardarMensaje({ telefono, rol: 'assistant', contenido, canal });

    res.json({ ok: true, canal });
  } catch (err) {
    console.error('[Enviar manual] Error:', err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Reactivar el bot para una conversación (vendedor termina y suelta)
app.post('/api/conversacion/:telefono/reactivar-bot', (req, res) => {
  const { db } = require('./database');
  db.prepare('DELETE FROM settings WHERE key = ?').run(`bot_pausado_${req.params.telefono}`);
  console.log(`[Bot] Reactivado para ${req.params.telefono}`);
  res.json({ ok: true });
});

app.get('/api/conversacion/:telefono', (req, res) => {
  const { db } = require('./database');
  const cliente = db.prepare('SELECT nombre, cuil, presupuesto, interes FROM clientes WHERE telefono = ?').get(req.params.telefono);
  const mensajes = db.prepare(`
    SELECT rol, contenido, creado_en
    FROM conversaciones
    WHERE telefono = ?
    ORDER BY creado_en ASC
  `).all(req.params.telefono);
  const asignaciones = db.prepare(`
    SELECT a.motivo, a.creado_en, v.nombre as vendedor
    FROM asignaciones a
    JOIN vendedores v ON v.id = a.vendedor_id
    WHERE a.cliente_telefono = ?
    ORDER BY a.creado_en ASC
  `).all(req.params.telefono);
  const botPausado = getSetting(`bot_pausado_${req.params.telefono}`, 'false') === 'true';
  res.json({ nombre: cliente?.nombre, cuil: cliente?.cuil, presupuesto: cliente?.presupuesto, interes: cliente?.interes, mensajes, asignaciones, bot_pausado: botPausado });
});

app.post('/chat', async (req, res) => {
  try {
    const { telefono, mensaje } = req.body;
    const respuesta = await procesarMensaje(telefono, mensaje, 'demo');
    res.json({ respuesta });
  } catch (err) {
    console.error('[Chat demo] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Análisis de mensajes históricos de IG y FB
app.get('/analizar', async (req, res) => {
  try {
    const desde = new Date(req.query.desde || Date.now() - 7 * 24 * 60 * 60 * 1000);
    console.log(`[Analizar] Iniciando análisis desde ${desde.toISOString()}`);
    const data = await analizar(desde);
    res.send(generarHTML(data, desde));
  } catch (err) {
    console.error('[Analizar] Error:', err.message);
    res.status(500).send(`<pre style="padding:24px;font-family:monospace">Error: ${err.message}</pre>`);
  }
});

// Importar conversaciones desde el Inbox de Meta (manualmente via Claude Desktop)
app.post('/importar-conversacion', (req, res) => {
  try {
    const { db, guardarMensaje } = require('./database');
    const { telefono, canal, nombre, mensajes } = req.body;

    if (!telefono || !canal || !Array.isArray(mensajes) || mensajes.length === 0) {
      return res.status(400).json({ error: 'Faltan datos: telefono, canal, mensajes (array)' });
    }

    // Borrar conversación previa con ese telefono+canal para evitar duplicados
    db.prepare('DELETE FROM conversaciones WHERE telefono = ? AND canal = ?').run(telefono, canal);

    let insertados = 0;
    const stmt = db.prepare(`
      INSERT INTO conversaciones (telefono, rol, contenido, canal, creado_en)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const m of mensajes) {
      if (!m.rol || !m.contenido) continue;
      const rol = m.rol === 'user' || m.rol === 'cliente' ? 'user' : 'assistant';
      const fecha = m.fecha || new Date().toISOString();
      stmt.run(telefono, rol, m.contenido, canal, fecha);
      insertados++;
    }

    // Guardar/actualizar el lead
    if (nombre) {
      db.prepare(`
        INSERT INTO clientes (telefono, nombre, canal)
        VALUES (?, ?, ?)
        ON CONFLICT(telefono) DO UPDATE SET nombre = COALESCE(?, nombre), canal = ?, actualizado_en = CURRENT_TIMESTAMP
      `).run(telefono, nombre, canal, nombre, canal);
    }

    console.log(`[Importar] ${insertados} mensajes de ${telefono} (${canal})`);
    res.json({ ok: true, insertados, telefono, canal });
  } catch (err) {
    console.error('[Importar] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Distribuir leads calientes a vendedores por WhatsApp
app.get('/distribuir', async (req, res) => {
  try {
    const desde = new Date(req.query.desde || Date.now() - 7 * 24 * 60 * 60 * 1000);
    console.log(`[Distribuir] Distribuyendo leads desde ${desde.toISOString()}`);
    const resultado = await distribuirLeads(desde);
    res.send(generarHTMLReporte(resultado));
  } catch (err) {
    console.error('[Distribuir] Error:', err.message);
    res.status(500).send(`<pre style="padding:24px">Error: ${err.message}</pre>`);
  }
});

// Info del número de WhatsApp API configurado
app.get('/api/wa-info', async (req, res) => {
  try {
    const config = require('./config');
    const axios = require('axios');
    if (!config.WHATSAPP_PHONE_ID) {
      return res.json({ error: 'WHATSAPP_PHONE_ID no está configurado en Railway' });
    }
    const r = await axios.get(`https://graph.facebook.com/v19.0/${config.WHATSAPP_PHONE_ID}`, {
      params: {
        fields: 'display_phone_number,verified_name,quality_rating,name_status',
        access_token: config.META_ACCESS_TOKEN,
      },
    });
    res.json({
      ok: true,
      numero: r.data.display_phone_number,
      nombre_verificado: r.data.verified_name,
      calidad: r.data.quality_rating,
      estado: r.data.name_status,
      phone_id: config.WHATSAPP_PHONE_ID,
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Test rápido: mandar WhatsApp desde el bot a cualquier número
app.get('/test-wa', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8" /><title>Test WhatsApp Procar</title>
<style>
  body { font-family: sans-serif; background: #0f0f1a; color: #fff; padding: 32px; max-width: 600px; margin: 0 auto; }
  h1 { color: #C9A84C; }
  input, textarea { width: 100%; padding: 12px; border-radius: 6px; border: 1px solid #444; background: #1a1a2e; color: #fff; font-size: 14px; margin-bottom: 12px; box-sizing: border-box; }
  button { background: #25d366; color: white; padding: 14px 24px; border: none; border-radius: 6px; font-size: 16px; font-weight: bold; cursor: pointer; }
  button:disabled { background: #444; }
  label { display: block; margin-bottom: 6px; color: #C9A84C; font-weight: 600; }
  .res { margin-top: 20px; padding: 16px; border-radius: 8px; }
  .ok { background: #2a9d8f33; border: 1px solid #2a9d8f; }
  .err { background: #e6394633; border: 1px solid #e63946; }
  .nota { background: #C9A84C22; border-left: 4px solid #C9A84C; padding: 14px; border-radius: 4px; margin-bottom: 24px; font-size: 0.9rem; }
</style></head>
<body>
  <h1>📱 Test WhatsApp Procar</h1>
  <div class="nota">
    <strong>⚠️ Antes de probar:</strong> el destinatario tiene que haberle mandado al menos un mensaje al WhatsApp de Procar en las últimas 24hs.
    Si no lo hizo, el envío va a fallar con error de Meta.
  </div>
  <label>Número (con código país, sin +. Ej: 5493794617070)</label>
  <input type="text" id="numero" placeholder="5493794617070" value="5493794617070" />
  <label>Mensaje</label>
  <textarea id="texto" rows="4">Che, soy Gonzalo de Procar. Te mando este mensaje de prueba para ver cómo se ve. Si te llega, decime "ok".</textarea>
  <button id="btn">Mandar WhatsApp</button>
  <div id="resultado"></div>
<script>
  document.getElementById('btn').addEventListener('click', async () => {
    const numero = document.getElementById('numero').value.trim();
    const texto = document.getElementById('texto').value.trim();
    const btn = document.getElementById('btn');
    const res = document.getElementById('resultado');
    if (!numero || !texto) { alert('Faltan datos'); return; }
    btn.disabled = true; btn.textContent = 'Mandando...';
    res.innerHTML = '';
    try {
      const r = await fetch('/api/test-whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numero, texto })
      });
      const data = await r.json();
      if (data.ok) {
        res.innerHTML = '<div class="res ok">✅ Mensaje enviado. Fijate el WhatsApp del destinatario.</div>';
      } else {
        res.innerHTML = '<div class="res err">❌ Error: ' + (data.error || 'desconocido') + '</div>';
      }
    } catch (err) {
      res.innerHTML = '<div class="res err">❌ Error de red: ' + err.message + '</div>';
    }
    btn.disabled = false; btn.textContent = 'Mandar WhatsApp';
  });
</script>
</body></html>`);
});

app.post('/api/test-whatsapp', async (req, res) => {
  try {
    const { numero, texto } = req.body;
    if (!numero || !texto) return res.status(400).json({ error: 'Faltan datos' });
    const { enviarWhatsAppVendedor } = require('./mensajero');
    await enviarWhatsAppVendedor(numero, texto);
    console.log(`[Test WA] Mensaje enviado a ${numero}`);
    res.json({ ok: true });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error('[Test WA] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

// Cambiar canales que maneja un vendedor
// Body: { canales: 'redes' | 'whatsapp' | 'todos' | 'facebook,instagram' }
app.post('/api/vendedor/:nombre/canales', (req, res) => {
  const { db } = require('./database');
  const { canales } = req.body;
  if (!canales) return res.status(400).json({ error: 'Falta canales' });
  const v = db.prepare('SELECT * FROM vendedores WHERE LOWER(nombre) = LOWER(?)').get(req.params.nombre);
  if (!v) return res.status(404).json({ error: 'Vendedor no encontrado' });
  db.prepare('UPDATE vendedores SET canales = ? WHERE id = ?').run(canales, v.id);
  console.log(`[Vendedor] ${v.nombre} ahora maneja: ${canales}`);
  res.json({ ok: true });
});

// Configuración rápida: redes (FB+IG) van a Tiki+Facu, todos los demás pausados o whatsapp
app.post('/api/setup-routing', (req, res) => {
  const { db } = require('./database');
  // Tiki y Facu activos en redes (FB + IG)
  db.prepare("UPDATE vendedores SET activo = 1, canales = 'redes' WHERE LOWER(nombre) IN ('tiki', 'facu')").run();
  // Antonio y Gustavo activos en whatsapp solamente
  db.prepare("UPDATE vendedores SET activo = 1, canales = 'whatsapp' WHERE LOWER(nombre) IN ('antonio', 'gustavo')").run();
  res.json({ ok: true, mensaje: 'Routing configurado: Tiki+Facu en redes, Antonio+Gustavo en WhatsApp' });
});

// Activar/pausar un vendedor (no recibe leads nuevos si está pausado)
app.post('/api/vendedor/:nombre/toggle', (req, res) => {
  const { db } = require('./database');
  const v = db.prepare('SELECT * FROM vendedores WHERE LOWER(nombre) = LOWER(?)').get(req.params.nombre);
  if (!v) return res.status(404).json({ error: 'Vendedor no encontrado' });
  const nuevoEstado = v.activo ? 0 : 1;
  db.prepare('UPDATE vendedores SET activo = ? WHERE id = ?').run(nuevoEstado, v.id);
  console.log(`[Vendedor] ${v.nombre} ahora ${nuevoEstado ? 'ACTIVO' : 'PAUSADO'}`);
  res.json({ ok: true, activo: nuevoEstado === 1 });
});

// Pausar / activar el agente
app.get('/agente/estado', (req, res) => {
  const activo = getSetting('agente_activo', 'true') === 'true';
  res.send(`
    <html><body style="font-family:sans-serif;padding:24px">
      <h1>Agente Gonzalo</h1>
      <p>Estado actual: <strong style="color:${activo ? 'green' : 'red'}">${activo ? '🟢 ACTIVO' : '🔴 PAUSADO'}</strong></p>
      ${activo
        ? '<a href="/agente/pausar" style="background:#e63946;color:white;padding:12px 24px;border-radius:6px;text-decoration:none">PAUSAR (no responder más)</a>'
        : '<a href="/agente/activar" style="background:#2a9d8f;color:white;padding:12px 24px;border-radius:6px;text-decoration:none">ACTIVAR (volver a responder)</a>'
      }
    </body></html>
  `);
});

app.get('/agente/pausar', (req, res) => {
  setSetting('agente_activo', 'false');
  console.log('[Agente] PAUSADO desde el panel');
  res.redirect('/agente/estado');
});

app.get('/agente/activar', (req, res) => {
  setSetting('agente_activo', 'true');
  console.log('[Agente] ACTIVADO desde el panel');
  res.redirect('/agente/estado');
});

// Webhook de Meta (WhatsApp + Instagram + Messenger)
app.get('/webhook', verificarWebhook);
app.post('/webhook', recibirMensaje);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor Procar Bot v1.1 corriendo en puerto ${PORT}`);
  // Validar token de Meta al arrancar (no bloquea el servidor)
  validarToken().catch(() => {});
  // Iniciar cron de recordatorios (24h y 72h)
  require('./recordatorios').iniciarCron();
});
