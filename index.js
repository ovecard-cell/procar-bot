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

// Inicializar base de datos, inventario y vendedores
inicializarDB();
cargarAutosEjemplo();
cargarVendedoresEjemplo();

// Health check
app.get('/', (req, res) => {
  res.send('Bot Procar funcionando correctamente');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Demo de chat (testing local)
app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, 'demo.html'));
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
