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
const { verificarWebhook, recibirMensaje, validarToken } = require('./webhook');
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
    SELECT v.nombre, COUNT(a.id) as total,
           SUM(CASE WHEN a.estado = 'pendiente' THEN 1 ELSE 0 END) as pendientes,
           SUM(CASE WHEN a.estado = 'cerrado' THEN 1 ELSE 0 END) as cerrados
    FROM vendedores v
    LEFT JOIN asignaciones a ON a.vendedor_id = v.id
    GROUP BY v.id
    ORDER BY total DESC
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
  res.json({ nombre: cliente?.nombre, cuil: cliente?.cuil, presupuesto: cliente?.presupuesto, interes: cliente?.interes, mensajes, asignaciones });
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
});
