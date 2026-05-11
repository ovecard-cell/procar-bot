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
const crypto = require('crypto');
const {
  inicializarDB, cargarAutosEjemplo, cargarVendedoresEjemplo,
  getSetting, setSetting, autenticarVendedor, cambiarPassword, MEDIA_DIR,
  obtenerEmbudo, actualizarEtapaAsignacion, ETAPAS_VALIDAS, ETAPA_LABEL,
  obtenerUltimaAsignacionPorTelefono, avanzarAEnConversacion,
  detectarEtapaPorTexto, moverEtapaSiAvanza,
  listarInventario, obtenerAuto, crearAuto, actualizarAuto, eliminarAuto,
  cambiarEstadoAuto, ESTADOS_AUTO,
} = require('./database');
const importador = require('./importador');

const COOKIE_SECRET = process.env.COOKIE_SECRET || 'procar-secret-' + (process.env.ANTHROPIC_API_KEY || 'default').slice(0, 16);

function firmarCookie(valor) {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(valor).digest('hex').slice(0, 32);
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(c => {
    const [name, ...rest] = c.trim().split('=');
    if (name) cookies[name] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}

function getVendedorAutenticado(req) {
  const cookies = parseCookies(req);
  const v = cookies.procar_vendedor;
  if (!v) return null;
  const partes = v.split('|');
  if (partes.length !== 3) return null;
  const [nombre, ts, firma] = partes;
  const esperada = firmarCookie(`${nombre}|${ts}`);
  if (firma !== esperada) return null;
  // Cookie válida 30 días
  if (Date.now() - parseInt(ts) > 30 * 24 * 60 * 60 * 1000) return null;
  return nombre;
}

function setCookieVendedor(res, nombre) {
  const ts = Date.now();
  const firma = firmarCookie(`${nombre}|${ts}`);
  const valor = `${nombre}|${ts}|${firma}`;
  res.setHeader('Set-Cookie', `procar_vendedor=${encodeURIComponent(valor)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`);
}
const {
  verificarWebhook, recibirMensaje, validarToken,
  enviarMessenger, enviarInstagram, enviarWhatsApp,
  enviarMessengerMedia, enviarInstagramMedia, enviarWhatsAppMedia,
} = require('./webhook');
const multer = require('multer');
const fs = require('fs');
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

// Servir archivos de media (imágenes, audios, videos enviados por clientes)
app.use('/media', express.static(MEDIA_DIR, { maxAge: '7d' }));

// SQLite devuelve los timestamps como "YYYY-MM-DD HH:MM:SS" (UTC, sin marcar zona).
// Algunos navegadores los interpretan como hora local y rompen el formateo.
// Esta función los normaliza a ISO 8601 con Z explícita antes de mandarlos al cliente.
function toISO(s) {
  if (typeof s !== 'string') return s;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return s.replace(' ', 'T') + 'Z';
  }
  // Si ya viene con T pero sin Z ni offset, agregamos Z
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) {
    return s + 'Z';
  }
  return s;
}
function normalizarTimestamps(obj, campos) {
  if (!obj) return obj;
  if (Array.isArray(obj)) return obj.map(o => normalizarTimestamps(o, campos));
  for (const c of campos) {
    if (c in obj) obj[c] = toISO(obj[c]);
  }
  return obj;
}

// ─────────────────────────────────────────────
// UPLOAD DE MEDIA — multer compartido por chat-media e inventario.
// Guarda en MEDIA_DIR (servido por /media). Acepta imagenes y videos chicos.
// ─────────────────────────────────────────────
const MIME_TIPO = {
  'image/jpeg': { tipo: 'image', ext: 'jpg' },
  'image/jpg':  { tipo: 'image', ext: 'jpg' },
  'image/png':  { tipo: 'image', ext: 'png' },
  'image/webp': { tipo: 'image', ext: 'webp' },
  'image/gif':  { tipo: 'image', ext: 'gif' },
  'video/mp4':  { tipo: 'video', ext: 'mp4' },
  'video/3gpp': { tipo: 'video', ext: '3gp' },
  'video/quicktime': { tipo: 'video', ext: 'mov' },
};

const storageMedia = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
    cb(null, MEDIA_DIR);
  },
  filename: (req, file, cb) => {
    const map = MIME_TIPO[file.mimetype];
    const ext = map ? map.ext : 'bin';
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`);
  },
});
const uploadMedia = multer({
  storage: storageMedia,
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB — limite de WhatsApp Cloud API para video
  fileFilter: (req, file, cb) => {
    if (MIME_TIPO[file.mimetype]) cb(null, true);
    else cb(new Error(`Tipo de archivo no soportado: ${file.mimetype}`));
  },
});

// Comprime una imagen (resize a max 1600px de ancho, jpg quality 80) para ahorrar
// espacio en el volumen. Re-escribe el mismo archivo. Si no es imagen, no toca.
// Si la imagen ya pesa poco (<150KB), no la toca tampoco.
async function comprimirImagen(filePath) {
  try {
    const sharp = require('sharp');
    const stat = fs.statSync(filePath);
    if (stat.size < 150 * 1024) return; // ya es chica
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return;
    const tmp = filePath + '.tmp';
    await sharp(filePath)
      .rotate() // respeta orientación EXIF y la aplica
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toFile(tmp);
    fs.renameSync(tmp, filePath);
    const after = fs.statSync(filePath).size;
    console.log(`[Compresion] ${filePath.split('/').pop()}: ${(stat.size/1024).toFixed(0)}KB → ${(after/1024).toFixed(0)}KB`);
  } catch (err) {
    console.error('[Compresion] error:', err.message);
  }
}

// Helper para comprimir un array de archivos subidos por multer.
async function comprimirSubidas(files) {
  if (!Array.isArray(files)) return;
  for (const f of files) {
    if (f.mimetype && f.mimetype.startsWith('image/')) {
      await comprimirImagen(f.path);
    }
  }
}

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

// Vista del embudo de leads (admin ve todo, vendedor solo el suyo)
app.get('/admin/embudo', (req, res) => {
  res.sendFile(path.join(__dirname, 'embudo.html'));
});

// Vista del inventario (mismo HTML para admin y vendedor — todos pueden cargar/editar)
app.get('/admin/inventario', (req, res) => {
  res.sendFile(path.join(__dirname, 'inventario.html'));
});
app.get('/vendedor/:nombre/inventario', (req, res) => {
  const autenticado = getVendedorAutenticado(req);
  const pedido = req.params.nombre;
  if (autenticado && autenticado.toLowerCase() === pedido.toLowerCase()) {
    return res.sendFile(path.join(__dirname, 'inventario.html'));
  }
  res.redirect(`/vendedor/${encodeURIComponent(pedido)}`);
});
app.get('/vendedor/:nombre/embudo', (req, res) => {
  const autenticado = getVendedorAutenticado(req);
  const pedido = req.params.nombre;
  if (autenticado && autenticado.toLowerCase() === pedido.toLowerCase()) {
    return res.sendFile(path.join(__dirname, 'embudo.html'));
  }
  res.redirect(`/vendedor/${encodeURIComponent(pedido)}`);
});

// Dashboard por vendedor con login
app.get('/vendedor/:nombre', (req, res) => {
  const autenticado = getVendedorAutenticado(req);
  const pedido = req.params.nombre;

  // Si está autenticado y coincide con el pedido (case insensitive), serve dashboard
  if (autenticado && autenticado.toLowerCase() === pedido.toLowerCase()) {
    return res.sendFile(path.join(__dirname, 'admin.html'));
  }

  // Sino mostrar login
  res.send(`
<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Login — Procar</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0f0f1a; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1a1a2e; padding: 40px; border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); border-top: 4px solid #C9A84C; min-width: 320px; }
  h1 { color: #C9A84C; margin: 0 0 8px 0; font-size: 1.4rem; letter-spacing: 0.05em; }
  p { color: #888; margin: 0 0 24px 0; font-size: 0.9rem; }
  label { display: block; color: #C9A84C; font-size: 0.8rem; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
  input { width: 100%; padding: 12px; border-radius: 6px; border: 1px solid #444; background: #0f0f1a; color: #fff; font-size: 1rem; box-sizing: border-box; margin-bottom: 16px; }
  input:focus { border-color: #C9A84C; outline: none; }
  button { width: 100%; padding: 14px; background: #C9A84C; color: #1a1a2e; border: none; border-radius: 8px; font-weight: 800; font-size: 1rem; cursor: pointer; text-transform: uppercase; letter-spacing: 0.05em; }
  button:hover { background: #d8b860; }
  .err { color: #e63946; font-size: 0.85rem; margin-top: 8px; min-height: 18px; }
</style></head><body>
<div class="card">
  <h1>PROCAR</h1>
  <p>Acceso para vendedor: <strong>${pedido}</strong></p>
  <form id="loginForm">
    <label>Contraseña</label>
    <input type="password" id="pass" required autofocus />
    <button type="submit">Entrar</button>
    <div class="err" id="err"></div>
  </form>
</div>
<script>
  document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const pass = document.getElementById('pass').value;
    const err = document.getElementById('err');
    err.textContent = '';
    const r = await fetch('/api/vendedor/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: ${JSON.stringify(pedido)}, password: pass }),
    });
    const data = await r.json();
    if (data.ok) location.reload();
    else err.textContent = data.error || 'Contraseña incorrecta';
  });
</script>
</body></html>`);
});

app.post('/api/vendedor/login', (req, res) => {
  const { nombre, password } = req.body;
  if (!nombre || !password) return res.status(400).json({ error: 'Faltan datos' });
  const v = autenticarVendedor(nombre, password);
  if (!v) return res.status(401).json({ error: 'Contraseña incorrecta' });
  if (!v.activo) return res.status(403).json({ error: 'Tu cuenta está pausada. Hablá con el jefe.' });
  setCookieVendedor(res, v.nombre);
  console.log(`[Login] ${v.nombre} se logueó`);
  res.json({ ok: true });
});

app.post('/api/vendedor/logout', (req, res) => {
  res.setHeader('Set-Cookie', `procar_vendedor=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.post('/api/vendedor/cambiar-password', (req, res) => {
  const autenticado = getVendedorAutenticado(req);
  if (!autenticado) return res.status(401).json({ error: 'No autenticado' });
  const { nueva } = req.body;
  if (!nueva || nueva.length < 4) return res.status(400).json({ error: 'Mínimo 4 caracteres' });
  cambiarPassword(autenticado, nueva);
  res.json({ ok: true });
});

// API JSON para el dashboard
// Resumen por vendedor: para la barra de tarjetas del tope del dashboard.
// Devuelve por cada vendedor: estado, leads asignados, leads de hoy, y el
// lead mas viejo sin respuesta (si lo hay).
app.get('/api/vendedores/resumen', (req, res) => {
  try {
    const { db } = require('./database');
    const vendedores = db.prepare(`
      SELECT id, nombre, activo, disponible
      FROM vendedores
      ORDER BY id ASC
    `).all();

    const ahora = Date.now();
    const resumen = vendedores.map(v => {
      // Total de leads asignados a este vendedor (asignaciones distintas por cliente).
      const leadsTotales = db.prepare(`
        SELECT COUNT(DISTINCT cliente_telefono) as n
        FROM asignaciones WHERE vendedor_id = ?
      `).get(v.id)?.n || 0;

      // Leads asignados HOY (desde 00:00 hora local del server — Railway corre UTC,
      // pero Argentina es UTC-3; usamos la hora actual de Argentina).
      const tzOff = 3 * 60; // minutos
      const ahoraDate = new Date(Date.now() - tzOff * 60 * 1000);
      const inicioHoyAR = new Date(Date.UTC(
        ahoraDate.getUTCFullYear(), ahoraDate.getUTCMonth(), ahoraDate.getUTCDate(), 3, 0, 0
      )); // 00:00 ARG = 03:00 UTC
      const leadsHoy = db.prepare(`
        SELECT COUNT(*) as n
        FROM asignaciones
        WHERE vendedor_id = ? AND creado_en >= ?
      `).get(v.id, inicioHoyAR.toISOString())?.n || 0;

      // Lead mas viejo SIN RESPUESTA del vendedor:
      // - vendedor asignado a este cliente (ultima asignacion)
      // - bot_pausado_<tel> = 'true'
      // - ultimo mensaje es 'user'
      // - no marcado como leido (marcado_leido_ts < ts del ultimo user)
      const masViejo = db.prepare(`
        SELECT cl.nombre, c.telefono, MAX(c.creado_en) as ultimo
        FROM conversaciones c
        LEFT JOIN clientes cl ON cl.telefono = c.telefono
        WHERE c.telefono IN (
          SELECT a.cliente_telefono FROM asignaciones a
          WHERE a.vendedor_id = ?
            AND a.creado_en = (SELECT MAX(creado_en) FROM asignaciones WHERE cliente_telefono = a.cliente_telefono)
        )
        AND (SELECT value FROM settings WHERE key = 'bot_pausado_' || c.telefono) = 'true'
        AND (SELECT rol FROM conversaciones WHERE telefono = c.telefono ORDER BY creado_en DESC LIMIT 1) = 'user'
        AND COALESCE(
          (SELECT value FROM settings WHERE key = 'marcado_leido_' || c.telefono),
          '1970-01-01'
        ) < (SELECT creado_en FROM conversaciones WHERE telefono = c.telefono AND rol = 'user' ORDER BY creado_en DESC LIMIT 1)
        GROUP BY c.telefono
        ORDER BY ultimo ASC
        LIMIT 1
      `).get(v.id);

      let leadMasViejo = null;
      if (masViejo) {
        const horas = Math.floor((ahora - new Date(masViejo.ultimo).getTime()) / (60 * 60 * 1000));
        const dias = Math.floor(horas / 24);
        const label = dias >= 1
          ? `${dias}d ${horas % 24}h sin respuesta`
          : horas >= 1 ? `${horas}h sin respuesta` : 'reciente sin respuesta';
        leadMasViejo = {
          nombre: masViejo.nombre || `Cliente ${String(masViejo.telefono).slice(-4)}`,
          telefono: masViejo.telefono,
          horas, dias, label,
        };
      }

      return {
        id: v.id,
        nombre: v.nombre,
        activo: !!v.activo,
        disponible: !!v.disponible,
        leads_asignados: leadsTotales,
        leads_hoy: leadsHoy,
        lead_mas_viejo: leadMasViejo,
      };
    });

    res.json({ vendedores: resumen });
  } catch (err) {
    console.error('[vendedores/resumen] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
    SELECT v.nombre, v.activo, v.disponible, v.canales, COUNT(a.id) as total,
           SUM(CASE WHEN a.estado = 'pendiente' THEN 1 ELSE 0 END) as pendientes,
           SUM(CASE WHEN a.estado = 'cerrado' THEN 1 ELSE 0 END) as cerrados,
           SUM(CASE WHEN a.notificado_en IS NULL THEN 1 ELSE 0 END) as sin_notificar
    FROM vendedores v
    LEFT JOIN asignaciones a ON a.vendedor_id = v.id
    GROUP BY v.id
    ORDER BY v.activo DESC, total DESC
  `).all();
  res.json({
    asignaciones: normalizarTimestamps(todas, ['creado_en']),
    por_vendedor: porVendedor,
  });
});

app.get('/api/estado', (req, res) => {
  res.json({ activo: getSetting('agente_activo', 'true') === 'true' });
});

// LEADS ABANDONADOS — clientes donde la pelota quedó del lado nuestro y nadie
// respondió. Devuelve lista ordenada por más colgados primero.
// Reglas:
//   - El último mensaje es del CLIENTE (rol='user').
//   - Pasaron MÁS de 30 min desde ese mensaje.
//   - No se le respondió aún.
app.get('/api/leads-abandonados', (req, res) => {
  try {
    const { db } = require('./database');
    const filas = db.prepare(`
      SELECT c.telefono, c.canal, c.contenido as ultimo_msg, c.creado_en as fecha,
             cl.nombre as nombre_cliente,
             (SELECT v.nombre FROM asignaciones a
                JOIN vendedores v ON v.id = a.vendedor_id
                WHERE a.cliente_telefono = c.telefono
                ORDER BY a.creado_en DESC LIMIT 1) as vendedor_asignado,
             (SELECT value FROM settings WHERE key = 'bot_pausado_' || c.telefono) as bot_pausado
      FROM conversaciones c
      LEFT JOIN clientes cl ON cl.telefono = c.telefono
      WHERE c.id = (SELECT MAX(id) FROM conversaciones WHERE telefono = c.telefono)
        AND c.rol = 'user'
        AND (julianday('now') - julianday(c.creado_en)) * 24 * 60 > 30
        AND c.creado_en > COALESCE(
          (SELECT value FROM settings WHERE key = 'marcado_leido_' || c.telefono),
          '1970-01-01'
        )
      ORDER BY c.creado_en ASC
    `).all();

    const ahora = Date.now();
    const items = filas.map(f => {
      const min = Math.floor((ahora - new Date(f.fecha).getTime()) / 60000);
      let nivel = 'amarillo';
      let label = `${min} min`;
      if (min >= 120 && min < 1440) { nivel = 'rojo'; label = `${Math.floor(min/60)}h`; }
      else if (min >= 1440) { nivel = 'negro'; label = `${Math.floor(min/1440)}d`; }
      const aCargo = f.bot_pausado === 'true'
        ? (f.vendedor_asignado || 'vendedor')
        : 'Gonzalo (bot)';
      return {
        telefono: f.telefono,
        canal: f.canal,
        nombre: f.nombre_cliente || `Cliente ${String(f.telefono).slice(-4)}`,
        ultimo_msg: (f.ultimo_msg || '').slice(0, 120),
        minutos: min,
        nivel,
        label,
        a_cargo: aCargo,
      };
    });

    res.json({ total: items.length, items });
  } catch (err) {
    console.error('[Leads abandonados] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// EMBUDO DE LEADS — vista por etapas
// ─────────────────────────────────────────────
app.get('/api/embudo', (req, res) => {
  const vendedor = req.query.vendedor;
  const leads = obtenerEmbudo({ vendedor });
  res.json({
    etapas: ETAPAS_VALIDAS,
    leads: normalizarTimestamps(leads, ['creado_en', 'actualizado_en', 'ultimo_mensaje']),
  });
});

// ─────────────────────────────────────────────
// INVENTARIO — autos y motos
// ─────────────────────────────────────────────
app.get('/api/inventario', (req, res) => {
  const tipo = req.query.tipo;
  const soloDisponibles = req.query.disponibles === 'true';
  res.json({ items: listarInventario({ tipo, soloDisponibles }) });
});

// IMPORTANTE: este endpoint TIENE que ir antes de /api/inventario/:id sino
// Express matchea /:id con id="exportar", parseInt da NaN y devuelve 404.
// Exporta el inventario actual a un Excel con las MISMAS columnas que el
// importador acepta. Así el flujo recomendado es: exportar → editar → importar,
// y el id_externo viene siempre completo (evita duplicados).
app.get('/api/inventario/exportar', (req, res) => {
  try {
    const XLSX = require('xlsx');
    const filas = listarInventario({});
    // Mapeamos a las columnas que parsearExcel reconoce. El alias 'tipo' en el
    // importador apunta a 'carroceria', no a auto/moto — por eso usamos
    // 'TIPO' para carroceria y dejamos 'auto/moto' afuera (no afecta el match).
    const datos = filas.map(a => ({
      // Fallback al id autoincrement si no hay id_externo cargado: asi la
      // columna nunca sale vacia y el round-trip funciona (el importador
      // tiene un fallback que matchea por DB id cuando id_externo no existe).
      ID: a.id_externo || a.id,
      MARCA: a.marca || '',
      MODELO: a.modelo || '',
      TIPO: a.carroceria || '',
      AÑO: a.anio || '',
      COLOR: a.color || '',
      KM: a.km || 0,
      Caja: a.transmision || '',
      'Precio de lista': a.precio || 0,
      Estado: a.estado === 'senado' ? 'Señado'
            : a.estado === 'vendido' ? 'Vendido'
            : a.estado === 'pausado' ? 'Pausado'
            : 'Disponible',
      'Link Marketplace': a.link_publi || '',
    }));
    const ws = XLSX.utils.json_to_sheet(datos);
    // Anchos de columna explicitos asi los headers ('Precio de lista',
    // 'Link Marketplace') no salen truncados visualmente en Excel/Sheets.
    ws['!cols'] = [
      { wch: 8 },   // ID
      { wch: 14 },  // MARCA
      { wch: 22 },  // MODELO
      { wch: 12 },  // TIPO
      { wch: 6 },   // AÑO
      { wch: 12 },  // COLOR
      { wch: 9 },   // KM
      { wch: 12 },  // Caja
      { wch: 18 },  // Precio de lista
      { wch: 12 },  // Estado
      { wch: 40 },  // Link Marketplace
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inventario');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="inventario-procar-${fecha}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('[Exportar] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/inventario/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const auto = obtenerAuto(id);
  if (!auto) return res.status(404).json({ error: 'No encontrado' });
  res.json(auto);
});

// Subida de fotos del inventario — multer ya configurado arriba con MEDIA_DIR
const uploadFotosInventario = uploadMedia.array('fotos', 8);

app.post('/api/inventario', (req, res, next) => {
  uploadFotosInventario(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    await comprimirSubidas(req.files);
    const fotos = (req.files || []).map(f => f.filename);
    const id = crearAuto({ ...req.body, fotos });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('[Inventario] Error creando:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/inventario/:id', (req, res, next) => {
  uploadFotosInventario(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    await comprimirSubidas(req.files);
    const id = parseInt(req.params.id, 10);
    const data = { ...req.body };
    // Si hay fotos nuevas, las agregamos a las que ya tenia (sin pisar).
    // Si el frontend manda 'fotos_existentes' como JSON array, esas son las que
    // se conservan (permite borrar fotos viejas desde la UI).
    let fotosFinales;
    let fotosExistentes = [];
    if (data.fotos_existentes) {
      try { fotosExistentes = JSON.parse(data.fotos_existentes); }
      catch (e) { fotosExistentes = []; }
      delete data.fotos_existentes;
    } else {
      const actual = obtenerAuto(id);
      fotosExistentes = actual ? actual.fotos : [];
    }
    const fotosNuevas = (req.files || []).map(f => f.filename);
    fotosFinales = [...fotosExistentes, ...fotosNuevas];
    data.fotos = fotosFinales;
    if (data.disponible !== undefined) data.disponible = data.disponible === 'true' || data.disponible === true;
    actualizarAuto(id, data);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Inventario] Error actualizando:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/inventario/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    eliminarAuto(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Inventario] Error eliminando:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Cambiar el estado de un auto: disponible / senado / vendido.
app.patch('/api/inventario/:id/estado', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { estado } = req.body || {};
    cambiarEstadoAuto(id, estado);
    res.json({ ok: true, estado });
  } catch (err) {
    console.error('[Inventario] Error cambiando estado:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Importar Excel: subir archivo, devolver preview con nuevos / actualizados / sin cambios / faltantes.
const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

app.post('/api/inventario/importar/preview', (req, res, next) => {
  uploadExcel.single('archivo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo Excel' });
    const items = importador.parsearExcel(req.file.buffer);
    const cat = importador.categorizar(items);
    const faltantes = importador.detectarFaltantes(items);
    res.json({
      total: items.length,
      nuevos: cat.nuevos,
      actualizados: cat.actualizados,
      sin_cambios: cat.sinCambios.length,
      posibles_duplicados: cat.posibles_duplicados || [],
      faltantes,
    });
  } catch (err) {
    console.error('[Importar] Error en preview:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/inventario/importar/aplicar', express.json({ limit: '5mb' }), (req, res) => {
  try {
    const { nuevos, actualizados, marcar_vendidos } = req.body || {};
    let creados = 0, modificados = 0, vendidos = 0;
    if (Array.isArray(nuevos)) {
      for (const item of nuevos) {
        crearAuto(item);
        creados++;
      }
    }
    if (Array.isArray(actualizados)) {
      for (const upd of actualizados) {
        actualizarAuto(upd.id, upd.item);
        modificados++;
      }
    }
    if (Array.isArray(marcar_vendidos)) {
      for (const id of marcar_vendidos) {
        cambiarEstadoAuto(parseInt(id, 10), 'vendido');
        vendidos++;
      }
    }
    res.json({ ok: true, creados, modificados, vendidos });
  } catch (err) {
    console.error('[Importar] Error aplicando:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/asignacion/:id/etapa', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { etapa, motivo_perdido, vendedor } = req.body || {};
    if (!etapa) return res.status(400).json({ error: 'Falta etapa' });
    actualizarEtapaAsignacion(id, etapa, motivo_perdido, vendedor || 'manual');
    res.json({ ok: true, etapa });
  } catch (err) {
    console.error('[Etapa] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/conversaciones', (req, res) => {
  const { db } = require('./database');
  const vendedor = req.query.vendedor;

  let query = `
    SELECT c.telefono, c.canal, MAX(c.creado_en) as ultimo,
           cl.nombre,
           (SELECT CASE
              WHEN tipo = 'imagen' THEN '📷 [foto]'
              WHEN tipo = 'audio'  THEN '🎤 [audio]'
              WHEN tipo = 'video'  THEN '🎬 [video]'
              ELSE contenido
            END
            FROM conversaciones WHERE telefono = c.telefono ORDER BY creado_en DESC LIMIT 1) as preview,
           (SELECT rol FROM conversaciones WHERE telefono = c.telefono ORDER BY creado_en DESC LIMIT 1) as ultimo_rol,
           (SELECT creado_en FROM conversaciones WHERE telefono = c.telefono AND rol = 'user' ORDER BY creado_en DESC LIMIT 1) as ultimo_user_ts,
           (SELECT v.nombre FROM asignaciones a JOIN vendedores v ON v.id = a.vendedor_id
            WHERE a.cliente_telefono = c.telefono ORDER BY a.creado_en DESC LIMIT 1) as vendedor_asignado,
           (SELECT value FROM settings WHERE key = 'bot_pausado_' || c.telefono) as bot_pausado_raw,
           (SELECT value FROM settings WHERE key = 'marcado_leido_' || c.telefono) as marcado_leido_ts
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
  // Convertimos bot_pausado_raw (texto 'true'/'false'/null) a booleano y limpiamos
  const filas = rows.map(r => ({
    ...r,
    bot_pausado: r.bot_pausado_raw === 'true',
    bot_pausado_raw: undefined,
  }));
  res.json(normalizarTimestamps(filas, ['ultimo']));
});

// Endpoint de auditoria: analiza todas las conversaciones desde el ultimo
// 14:00 ARG (= 17:00 UTC) que paso, detecta problemas heuristicamente y
// devuelve JSON con detalle por conversacion + resumen agrupado.
//
// Detecta:
//  - respuesta_vacia: filas con rol='assistant' y contenido vacio (el log
//    defensivo de procesarMensaje se gatilla en este caso).
//  - fotos_no_enviadas: el bot dijo "te paso fotos / ahi van" pero no hay
//    una imagen guardada en conversaciones inmediatamente despues. OJO:
//    enviar_fotos_auto NO persiste imagenes en conversaciones, asi que
//    este check va a marcar TODOS los casos donde el bot prometio fotos.
//    Es mas un proxy "el bot dijo fotos" que un fallo confirmado.
//  - auto_confundido: el cliente dijo "tengo un X" y un mensaje del bot
//    posterior trata X como stock disponible (tenemos X / disponible / fotos
//    del X / esta en stock). Es heuristica, puede tener falsos positivos.
//  - derivacion_sin_nombre: hay asignacion creada en este rango pero los
//    mensajes del bot DESPUES de la asignacion no mencionan ningun nombre
//    de vendedor real (Antonio/Facu/Cristhian/Gustavo).
//
// Notas:
//  - "errores en logs" requiere acceso a Railway logs y no esta disponible
//    desde el container; lo dejamos fuera. respuesta_vacia cubre el error
//    mas comun que igual queda registrado en DB.
app.get('/api/admin/analisis-conversaciones', (req, res) => {
  try {
    const { db } = require('./database');

    // Most recent 14:00 ARG (= 17:00 UTC) que ya paso.
    const desde = new Date();
    desde.setUTCHours(17, 0, 0, 0);
    if (desde > new Date()) desde.setUTCDate(desde.getUTCDate() - 1);
    const desdeISO = desde.toISOString();
    const hastaISO = new Date().toISOString();

    const VENDEDORES = ['antonio', 'facu', 'facundo', 'cristhian', 'gustavo'];
    const PROM_FOTOS = /\b(te paso fotos|ah[ií] van|ac[aá] van|ac[aá] te (?:mando|paso)|te mando fotos|paso fotos|mando fotos|las fotos|te muestro)\b/i;
    const STOCK_TERMS = /(tenemos|disponible|en stock|te paso fotos del|te muestro|impecable|en venta|hay un)/i;

    const telefonos = db.prepare(`
      SELECT DISTINCT telefono FROM conversaciones WHERE creado_en >= ?
    `).all(desdeISO).map(r => r.telefono);

    const totales = {
      respuesta_vacia: 0,
      fotos_no_enviadas: 0,
      auto_confundido: 0,
      derivacion_sin_nombre: 0,
    };
    const conversaciones = [];

    for (const tel of telefonos) {
      const cliente = db.prepare('SELECT nombre, canal FROM clientes WHERE telefono = ?').get(tel);
      const mensajes = db.prepare(`
        SELECT rol, contenido, tipo, archivo, creado_en
        FROM conversaciones
        WHERE telefono = ? AND creado_en >= ?
        ORDER BY creado_en ASC
      `).all(tel, desdeISO);
      if (!mensajes.length) continue;

      const asig = db.prepare(`
        SELECT a.creado_en, v.nombre as vendedor_nombre
        FROM asignaciones a
        JOIN vendedores v ON v.id = a.vendedor_id
        WHERE a.cliente_telefono = ? AND a.creado_en >= ?
        ORDER BY a.creado_en DESC LIMIT 1
      `).get(tel, desdeISO);

      const problemas = [];

      // 1. respuesta_vacia
      const vacios = mensajes.filter(m => m.rol === 'assistant' && (!m.contenido || !m.contenido.trim()) && m.tipo !== 'imagen' && m.tipo !== 'audio' && m.tipo !== 'video');
      if (vacios.length) {
        problemas.push({ tipo: 'respuesta_vacia', detalle: `${vacios.length} mensaje(s) sin texto` });
        totales.respuesta_vacia += vacios.length;
      }

      // 2. fotos_no_enviadas — bot promete fotos y no hay imagen siguiente
      let fotosSinSeguir = 0;
      for (let i = 0; i < mensajes.length; i++) {
        const m = mensajes[i];
        if (m.rol !== 'assistant' || !m.contenido) continue;
        if (!PROM_FOTOS.test(m.contenido)) continue;
        const ventana = mensajes.slice(Math.max(0, i - 2), i + 3);
        const hayImagen = ventana.some(x => x.rol === 'assistant' && x.tipo === 'imagen');
        if (!hayImagen) fotosSinSeguir++;
      }
      if (fotosSinSeguir) {
        problemas.push({ tipo: 'fotos_no_enviadas', detalle: `${fotosSinSeguir} promesa(s) sin imagen registrada` });
        totales.fotos_no_enviadas += fotosSinSeguir;
      }

      // 3. auto_confundido
      let autoConfundido = null;
      for (let i = 0; i < mensajes.length - 1 && !autoConfundido; i++) {
        const m = mensajes[i];
        if (m.rol !== 'user' || !m.contenido) continue;
        const tieneM = m.contenido.match(/\btengo (?:un|una|el|la|mi|el|los)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+)/i);
        if (!tieneM) continue;
        const autoPermuta = tieneM[1].toLowerCase();
        // Fallback heuristica: ignorar "tengo un auto" / "tengo una moto" genericos
        if (['auto', 'auto.', 'moto', 'vehiculo', 'vehículo'].includes(autoPermuta)) continue;

        for (let j = i + 1; j < Math.min(i + 4, mensajes.length); j++) {
          if (mensajes[j].rol !== 'assistant' || !mensajes[j].contenido) continue;
          const cont = mensajes[j].contenido.toLowerCase();
          if (cont.includes(autoPermuta) && STOCK_TERMS.test(cont)) {
            autoConfundido = { permuta_modelo: autoPermuta, mensaje_bot: mensajes[j].contenido.slice(0, 160) };
            break;
          }
        }
      }
      if (autoConfundido) {
        problemas.push({ tipo: 'auto_confundido', detalle: autoConfundido });
        totales.auto_confundido += 1;
      }

      // 4. derivacion_sin_nombre
      if (asig) {
        const asigTime = new Date(asig.creado_en).getTime();
        const msjsDespues = mensajes.filter(m => m.rol === 'assistant' && new Date(m.creado_en).getTime() >= asigTime - 2000);
        if (msjsDespues.length) {
          const algunoMencionaVendedor = msjsDespues.some(m => {
            const c = (m.contenido || '').toLowerCase();
            return VENDEDORES.some(n => c.includes(n));
          });
          if (!algunoMencionaVendedor) {
            problemas.push({ tipo: 'derivacion_sin_nombre', detalle: `asignado a ${asig.vendedor_nombre} pero el bot no lo nombro` });
            totales.derivacion_sin_nombre += 1;
          }
        }
      }

      conversaciones.push({
        telefono: tel,
        canal: cliente?.canal || mensajes[0]?.canal || mensajes[mensajes.length - 1]?.canal || '?',
        nombre: cliente?.nombre || `Cliente ${String(tel).slice(-4)}`,
        vendedor_asignado: asig?.vendedor_nombre || null,
        mensajes_total: mensajes.length,
        problemas,
      });
    }

    // Ordenar: primero las que tienen mas problemas
    conversaciones.sort((a, b) => b.problemas.length - a.problemas.length);

    res.json({
      rango: { desde_utc: desdeISO, hasta_utc: hastaISO, nota: 'desde = ultimo 14:00 ARG = 17:00 UTC que ya paso' },
      total_conversaciones: conversaciones.length,
      resumen_problemas: totales,
      conversaciones,
    });
  } catch (err) {
    console.error('[Analisis] Error:', err.message);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Lista de leads calientes de las ultimas 48hs para arrancar la jornada.
// "Caliente" = tiene nombre o numero de contacto Y no cerro (etapa != vendido/
// perdido). Ordenado por antiguedad: los que mas esperan primero.
app.get('/api/admin/leads-calientes', (req, res) => {
  try {
    const { db } = require('./database');
    const ahora = Date.now();
    const desdeISO = new Date(ahora - 48 * 3600 * 1000).toISOString();

    // Conversaciones con actividad en 48hs.
    const filas = db.prepare(`
      SELECT c.telefono, c.canal,
             cl.nombre as nombre_clientes,
             cl.whatsapp as wa_clientes,
             ec.nombre_cliente as nombre_estado,
             ec.etapa as etapa_estado,
             ec.auto_interes as auto_interes_json,
             (SELECT MAX(creado_en) FROM conversaciones WHERE telefono = c.telefono) as ultimo_msg,
             (SELECT MAX(creado_en) FROM conversaciones WHERE telefono = c.telefono AND rol = 'user') as ultimo_msg_user,
             (SELECT contenido FROM conversaciones WHERE telefono = c.telefono ORDER BY creado_en DESC LIMIT 1) as preview_raw,
             (SELECT tipo FROM conversaciones WHERE telefono = c.telefono ORDER BY creado_en DESC LIMIT 1) as preview_tipo,
             (SELECT rol FROM conversaciones WHERE telefono = c.telefono ORDER BY creado_en DESC LIMIT 1) as preview_rol,
             a.id as asig_id, a.cliente_nombre as asig_nombre, a.etapa as asig_etapa,
             a.cliente_whatsapp as asig_wa,
             v.nombre as vendedor_nombre
      FROM (SELECT DISTINCT telefono, canal FROM conversaciones WHERE creado_en >= ?) c
      LEFT JOIN clientes cl ON cl.telefono = c.telefono
      LEFT JOIN estado_conversacion ec ON ec.telefono = c.telefono
      LEFT JOIN (
        SELECT cliente_telefono, MAX(id) as max_id FROM asignaciones GROUP BY cliente_telefono
      ) am ON am.cliente_telefono = c.telefono
      LEFT JOIN asignaciones a ON a.id = am.max_id
      LEFT JOIN vendedores v ON v.id = a.vendedor_id
    `).all(desdeISO);

    const ETAPAS_CERRADAS = new Set(['vendido', 'perdido']);

    const leads = [];
    for (const f of filas) {
      // Etapa final: la de la asignacion (si existe) gana sobre la del estado.
      const etapaFinal = (f.asig_etapa || f.etapa_estado || 'prospecto').toLowerCase();
      // Filtrar: descartar cerradas (vendido/perdido).
      if (ETAPAS_CERRADAS.has(etapaFinal)) continue;

      // Nombre: priorizar el de asignacion (snapshot al escalar) > clientes > estado.
      const nombre = f.asig_nombre || f.nombre_clientes || f.nombre_estado || null;
      // Contacto: WA del estado/clientes/asignacion, o el sender si canal=whatsapp.
      let contacto = f.asig_wa || f.wa_clientes || null;
      if (!contacto && f.canal === 'whatsapp') contacto = f.telefono;

      // CALIFICA si tiene nombre O numero de contacto real.
      if (!nombre && !contacto) continue;

      // Tiempo de espera: desde el ultimo mensaje del cliente. Si no hay user
      // recent, fallback a ultimo_msg cualquiera.
      const tsBase = f.ultimo_msg_user || f.ultimo_msg;
      const horasEspera = tsBase ? (ahora - new Date(tsBase).getTime()) / 3600000 : 0;

      // Preview legible
      const tipo = f.preview_tipo;
      let preview;
      if (tipo === 'imagen') preview = '[IMAGEN]';
      else if (tipo === 'audio') preview = '[AUDIO]';
      else if (tipo === 'video') preview = '[VIDEO]';
      else preview = (f.preview_raw || '').slice(0, 160);

      // Auto interes legible (si esta en estado_conversacion)
      let autoInteres = null;
      try {
        if (f.auto_interes_json) {
          const ai = JSON.parse(f.auto_interes_json);
          autoInteres = [ai.marca, ai.modelo, ai.anio].filter(Boolean).join(' ').trim() || null;
        }
      } catch { /* ignore */ }

      const horas = Math.floor(horasEspera);
      const dias = Math.floor(horas / 24);
      const espera = dias >= 1
        ? `${dias}d ${horas % 24}h`
        : horas >= 1 ? `${horas}h ${Math.floor((horasEspera - horas) * 60)}min` : `${Math.floor(horasEspera * 60)}min`;

      leads.push({
        telefono: f.telefono,
        canal: f.canal,
        nombre: nombre || '(sin nombre)',
        contacto: contacto || null,
        auto_interes: autoInteres,
        ultimo_mensaje: preview,
        ultimo_mensaje_de: f.preview_rol === 'user' ? 'cliente' : 'bot',
        ultimo_mensaje_ts: f.ultimo_msg,
        vendedor_asignado: f.vendedor_nombre || null,
        etapa: etapaFinal,
        horas_espera: Math.round(horasEspera * 10) / 10,
        espera_legible: espera,
      });
    }

    // Ordenar por antiguedad: los que mas esperan primero.
    leads.sort((a, b) => b.horas_espera - a.horas_espera);

    res.json({
      generado: new Date().toISOString(),
      ventana: { desde: desdeISO, hasta: new Date(ahora).toISOString(), horas: 48 },
      total: leads.length,
      leads,
    });
  } catch (err) {
    console.error('[Leads-calientes] Error:', err.message, err.stack);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Leads del canal web — lista historica (default 30 dias, configurable con ?dias=N).
// Solo los que dejaron numero de WhatsApp real. Ordenados por actividad reciente.
app.get('/api/admin/leads-web', (req, res) => {
  try {
    const { db } = require('./database');
    const dias = Math.max(1, Math.min(365, parseInt(req.query.dias, 10) || 30));
    const desdeISO = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();

    const filas = db.prepare(`
      SELECT c.telefono, c.canal,
             cl.nombre as nombre_clientes,
             cl.whatsapp as wa_clientes,
             ec.nombre_cliente as nombre_estado,
             ec.etapa as etapa_estado,
             ec.auto_interes as auto_interes_json,
             (SELECT MAX(creado_en) FROM conversaciones WHERE telefono = c.telefono) as ultimo_msg,
             a.cliente_nombre as asig_nombre,
             a.etapa as asig_etapa,
             a.cliente_whatsapp as asig_wa,
             v.nombre as vendedor_nombre
      FROM (SELECT DISTINCT telefono, canal FROM conversaciones WHERE canal = 'web' AND creado_en >= ?) c
      LEFT JOIN clientes cl ON cl.telefono = c.telefono
      LEFT JOIN estado_conversacion ec ON ec.telefono = c.telefono
      LEFT JOIN (
        SELECT cliente_telefono, MAX(id) as max_id FROM asignaciones GROUP BY cliente_telefono
      ) am ON am.cliente_telefono = c.telefono
      LEFT JOIN asignaciones a ON a.id = am.max_id
      LEFT JOIN vendedores v ON v.id = a.vendedor_id
    `).all(desdeISO);

    const ETAPAS_CERRADAS = new Set(['vendido', 'perdido']);
    const ahora = Date.now();
    const leads = [];

    for (const f of filas) {
      const etapa = (f.asig_etapa || f.etapa_estado || 'prospecto').toLowerCase();
      if (ETAPAS_CERRADAS.has(etapa)) continue;

      const wa = f.asig_wa || f.wa_clientes || null;
      if (!wa) continue; // solo leads CON WhatsApp

      const nombre = f.asig_nombre || f.nombre_clientes || f.nombre_estado || '(sin nombre)';

      let autoInteres = null;
      try {
        if (f.auto_interes_json) {
          const ai = JSON.parse(f.auto_interes_json);
          autoInteres = [ai.marca, ai.modelo, ai.anio].filter(Boolean).join(' ').trim() || null;
        }
      } catch { /* ignore */ }

      const tsBase = f.ultimo_msg;
      const horasAtras = tsBase ? (ahora - new Date(tsBase).getTime()) / 3600000 : 0;
      const h = Math.floor(horasAtras);
      const d = Math.floor(h / 24);
      const hace = d >= 1
        ? `${d}d ${h % 24}h`
        : h >= 1 ? `${h}h` : `${Math.floor(horasAtras * 60)}min`;

      // Normalizar WhatsApp para wa.me: solo digitos, sin +, sin espacios, sin guiones.
      const waLimpio = String(wa).replace(/\D/g, '');

      leads.push({
        telefono: f.telefono,
        nombre,
        whatsapp: wa,
        whatsapp_normalizado: waLimpio,
        auto_interes: autoInteres,
        ultimo_mensaje_ts: tsBase,
        hace,
        horas_atras: Math.round(horasAtras * 10) / 10,
        etapa,
        vendedor_asignado: f.vendedor_nombre || null,
      });
    }

    leads.sort((a, b) => a.horas_atras - b.horas_atras); // mas reciente arriba

    res.json({
      generado: new Date().toISOString(),
      ventana_dias: dias,
      total: leads.length,
      leads,
    });
  } catch (err) {
    console.error('[Leads-web] Error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
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

    // Embudo: si la asignacion estaba en 'nuevo', avanzarla a 'en_conversacion'
    const asig = obtenerUltimaAsignacionPorTelefono(telefono);
    if (asig) avanzarAEnConversacion(asig.id);

    // Auto-deteccion de etapa a partir del texto del vendedor.
    let etapaAuto = null;
    if (asig) {
      const detectada = detectarEtapaPorTexto(texto);
      if (detectada) {
        const r = moverEtapaSiAvanza({
          asignacionId: asig.id,
          nuevaEtapa: detectada,
          movidoPor: vendedor || 'dashboard',
          automatico: true,
        });
        if (r.movido) {
          etapaAuto = { etapa: detectada, label: ETAPA_LABEL[detectada] || detectada };
          console.log(`[Etapa auto] Asig ${asig.id} ${r.etapaAnterior} → ${detectada} por "${vendedor || 'dashboard'}"`);
        }
      }
    }

    res.json({ ok: true, canal, etapaAuto });
  } catch (err) {
    console.error('[Enviar manual] Error:', err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Endpoint para mandar foto/video al cliente desde el dashboard del vendedor.
// Sube el archivo a MEDIA_DIR y le pasa a Meta la URL publica HTTPS — Meta la baja.
app.post('/api/conversacion/:telefono/enviar-media', (req, res, next) => {
  uploadMedia.single('archivo')(req, res, (err) => {
    if (err) {
      console.error('[Enviar media] Error de multer:', err.message);
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    const { db, guardarMensaje } = require('./database');
    const telefono = req.params.telefono;
    const vendedor = (req.body.vendedor || '').trim();
    const caption = (req.body.caption || '').trim();

    if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });

    const map = MIME_TIPO[req.file.mimetype];
    if (!map) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Tipo no soportado: ${req.file.mimetype}` });
    }

    // Detectar el canal a partir de la última conversación
    const ultimo = db.prepare(`
      SELECT canal FROM conversaciones WHERE telefono = ? ORDER BY creado_en DESC LIMIT 1
    `).get(telefono);
    if (!ultimo) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'No hay conversación previa con ese cliente' });
    }
    const canal = ultimo.canal;

    // URL publica HTTPS para que Meta pueda bajar el archivo
    const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const urlPublica = `${baseUrl}/media/${req.file.filename}`;

    // Pausar el bot para esta conversación
    setSetting(`bot_pausado_${telefono}`, 'true');

    // Mandar al cliente segun canal
    if (canal === 'messenger' || canal === 'facebook') {
      await enviarMessengerMedia(telefono, urlPublica, map.tipo);
      if (caption) await enviarMessenger(telefono, caption);
    } else if (canal === 'instagram') {
      await enviarInstagramMedia(telefono, urlPublica, map.tipo);
      if (caption) await enviarInstagram(telefono, caption);
    } else if (canal === 'whatsapp') {
      const config = require('./config');
      await enviarWhatsAppMedia(config.WHATSAPP_PHONE_ID, telefono, urlPublica, map.tipo, caption || undefined);
    } else {
      return res.status(400).json({ error: `Canal ${canal} no soportado` });
    }

    // Guardar en la DB. Tipo en DB: 'imagen' | 'video' (para que coincida con lo que ya guardamos del cliente)
    const tipoDB = map.tipo === 'image' ? 'imagen' : 'video';
    const contenido = vendedor
      ? `[${vendedor}] ${caption || `[${tipoDB}]`}`
      : (caption || `[${tipoDB}]`);
    guardarMensaje({ telefono, rol: 'assistant', contenido, canal, tipo: tipoDB, archivo: req.file.filename });

    // Embudo: si la asignacion estaba en 'nuevo', avanzarla a 'en_conversacion'
    const asig = obtenerUltimaAsignacionPorTelefono(telefono);
    if (asig) avanzarAEnConversacion(asig.id);

    res.json({ ok: true, canal, archivo: req.file.filename, tipo: tipoDB });
  } catch (err) {
    console.error('[Enviar media] Error:', err.message);
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

// Marcar conversación como leída — el vendedor toca el botón y la conversación
// deja de aparecer como ESPERANDO. Guardamos el timestamp del ultimo msg del
// cliente al momento de marcar; si el cliente vuelve a escribir despues, el
// nuevo msg del cliente tendra ts > marcado_leido_ts y volvera a aparecer.
app.post('/api/conversacion/:telefono/marcar-leido', (req, res) => {
  try {
    const { db } = require('./database');
    const tel = req.params.telefono;
    const ultimoUser = db.prepare(
      "SELECT creado_en FROM conversaciones WHERE telefono = ? AND rol = 'user' ORDER BY creado_en DESC LIMIT 1"
    ).get(tel);
    // Si nunca escribió el cliente, igual marcamos con now() para no estallar.
    const ts = ultimoUser?.creado_en || new Date().toISOString();
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = ?
    `).run(`marcado_leido_${tel}`, ts, ts);
    console.log(`[Marcar leido] ${tel} marcado al ts=${ts}`);
    res.json({ ok: true, marcado_leido_ts: ts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/conversacion/:telefono', (req, res) => {
  const { db } = require('./database');
  const cliente = db.prepare('SELECT nombre, cuil, presupuesto, interes FROM clientes WHERE telefono = ?').get(req.params.telefono);
  const mensajes = db.prepare(`
    SELECT rol, contenido, tipo, archivo, creado_en
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

  // Ventana de 24hs de Meta: si el último mensaje del cliente fue hace +24h,
  // ya no se puede mandar texto libre (solo plantillas pre-aprobadas).
  const ultimoUser = db.prepare(`
    SELECT creado_en FROM conversaciones
    WHERE telefono = ? AND rol = 'user'
    ORDER BY creado_en DESC LIMIT 1
  `).get(req.params.telefono);
  let ventana24h = { abierta: true };
  if (ultimoUser) {
    const horas = (Date.now() - new Date(ultimoUser.creado_en).getTime()) / (60 * 60 * 1000);
    ventana24h = {
      abierta: horas < 24,
      horas: Math.floor(horas),
      ultimo_msg_cliente: ultimoUser.creado_en,
    };
  }

  res.json({
    nombre: cliente?.nombre,
    cuil: cliente?.cuil,
    presupuesto: cliente?.presupuesto,
    interes: cliente?.interes,
    mensajes: normalizarTimestamps(mensajes, ['creado_en']),
    asignaciones: normalizarTimestamps(asignaciones, ['creado_en']),
    bot_pausado: botPausado,
    ventana24h,
  });
});

// CORS para que el widget funcione embebido en cualquier sitio web.
app.use((req, res, next) => {
  if (req.path === '/chat' || req.path === '/widget.js' || req.path === '/widget.html') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

app.get('/widget.js', (req, res) => res.sendFile(path.join(__dirname, 'widget.js')));
app.get('/widget.html', (req, res) => res.sendFile(path.join(__dirname, 'widget.html')));

app.post('/chat', async (req, res) => {
  try {
    const { telefono, mensaje } = req.body;
    const canal = String(telefono || '').startsWith('web_') ? 'web' : 'demo';
    const respuesta = await procesarMensaje(telefono, mensaje, canal);
    res.json({ respuesta });
  } catch (err) {
    console.error('[Chat] Error:', err.message);
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
    // Usamos el WA_TOKEN (WHATSAPP_TOKEN si está, sino META_ACCESS_TOKEN).
    // Para consultar info del número hace falta scope whatsapp_business_management.
    const r = await axios.get(`https://graph.facebook.com/v19.0/${config.WHATSAPP_PHONE_ID}`, {
      params: {
        fields: 'display_phone_number,verified_name,quality_rating,name_status',
        access_token: config.WA_TOKEN,
      },
    });
    res.json({
      ok: true,
      numero: r.data.display_phone_number,
      nombre_verificado: r.data.verified_name,
      calidad: r.data.quality_rating,
      estado: r.data.name_status,
      phone_id: config.WHATSAPP_PHONE_ID,
      usando_token: config.WHATSAPP_TOKEN ? 'WHATSAPP_TOKEN' : 'META_ACCESS_TOKEN (fallback — puede no tener permisos de WA)',
    });
  } catch (err) {
    res.status(500).json({
      error: err.response?.data?.error?.message || err.message,
      hint: 'Si dice "Application does not have permission", generá un System User Token en Meta Business Manager con scopes whatsapp_business_management y whatsapp_business_messaging, y pegalo en Railway como WHATSAPP_TOKEN.',
    });
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

// Test del template lead_asignado (el que se manda a vendedores).
// Devuelve el error exacto de Meta si falla.
app.get('/api/test-template-lead', async (req, res) => {
  const numero = req.query.numero;
  if (!numero) return res.status(400).json({ error: 'falta ?numero=549...' });
  try {
    const { enviarLeadAsignado } = require('./mensajero');
    await enviarLeadAsignado(numero, {
      cliente: 'Cliente de prueba',
      vehiculo: 'Gol Trend',
      consulta: 'TEST - prueba de plantilla lead_asignado',
    });
    res.json({ ok: true, mensaje: `Plantilla enviada a ${numero}. Revisá tu WhatsApp.` });
  } catch (err) {
    const meta = err.response?.data?.error;
    res.status(500).json({
      ok: false,
      error_meta: meta?.message || err.message,
      codigo: meta?.code,
      tipo: meta?.type,
      detalles: meta?.error_data,
      hint_meta: meta?.error_user_msg,
    });
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

// Reset de contraseñas a las defaults (admin) — útil para arrancar
// Backfill de nombres: para cada cliente sin nombre, intenta consultar la
// Graph API de Meta. Util para limpiar datos viejos. Devuelve resumen.
app.get('/api/admin/backfill-nombres', async (req, res) => {
  try {
    const { db, guardarLead } = require('./database');
    const { obtenerPerfilMeta } = require('./webhook');
    // Buscamos todos los clientes que tienen telefono numerico largo (PSID/IGSID)
    // y no tienen nombre. Limitamos a 50 por llamada para no saturar la API.
    const candidatos = db.prepare(`
      SELECT c.telefono, c.canal
      FROM (
        SELECT DISTINCT telefono, canal FROM conversaciones
        WHERE canal IN ('messenger', 'instagram', 'facebook')
      ) AS c
      LEFT JOIN clientes cl ON cl.telefono = c.telefono
      WHERE cl.nombre IS NULL OR cl.nombre = ''
      LIMIT 50
    `).all();
    let actualizados = 0, sinExito = 0;
    const resultados = [];
    for (const c of candidatos) {
      const nombre = await obtenerPerfilMeta(c.canal, c.telefono);
      if (nombre) {
        guardarLead({ telefono: c.telefono, nombre, canal: c.canal });
        actualizados++;
        resultados.push({ telefono: c.telefono, canal: c.canal, nombre });
      } else {
        sinExito++;
      }
    }
    res.json({ revisados: candidatos.length, actualizados, sin_exito: sinExito, muestra: resultados.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostico: lista los ultimos N telefonos que escribieron, con canal y
// un fragmento del ultimo mensaje. Sirve para encontrar el telefono exacto
// (sender_id) con que esta guardada una conversacion en la DB.
app.get('/api/admin/debug-conversaciones', (req, res) => {
  try {
    const { db } = require('./database');
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const filas = db.prepare(`
      SELECT telefono, canal, MAX(creado_en) as ultimo,
             (SELECT contenido FROM conversaciones WHERE telefono = c.telefono ORDER BY creado_en DESC LIMIT 1) as ultimo_msg
      FROM conversaciones c
      GROUP BY telefono
      ORDER BY ultimo DESC
      LIMIT ?
    `).all(limit);
    res.json({
      total: filas.length,
      conversaciones: filas.map(f => ({
        telefono: f.telefono,
        telefono_len: String(f.telefono).length,
        canal: f.canal,
        ultimo: f.ultimo,
        ultimo_msg: (f.ultimo_msg || '').slice(0, 120),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostico: busca un telefono en la DB con LIKE para encontrar matches
// parciales (util si tenes un fragmento del sender_id).
app.get('/api/admin/debug-buscar/:fragmento', (req, res) => {
  try {
    const { db } = require('./database');
    const frag = req.params.fragmento;
    const filas = db.prepare(`
      SELECT DISTINCT telefono, canal FROM conversaciones
      WHERE telefono LIKE ?
      LIMIT 20
    `).all(`%${frag}%`);
    res.json({ buscado: frag, encontrados: filas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostico: para una conversacion dada, devuelve qué auto detecta
// extraerAutoDelHistorial y el bloque de system prompt que se inyectaria.
// Sirve para verificar en vivo que el fix de contexto está corriendo.
app.get('/api/admin/debug-auto/:telefono', (req, res) => {
  try {
    const { db } = require('./database');
    const telefono = req.params.telefono;
    const historial = db.prepare(
      `SELECT rol, contenido, tipo, archivo, creado_en FROM conversaciones
       WHERE telefono = ? ORDER BY creado_en DESC LIMIT 20`
    ).all(telefono).reverse();
    const { extraerAutoDelHistorial, contextoAutoDetectado } = require('./agente');
    const detectado = extraerAutoDelHistorial(historial);
    const contexto = contextoAutoDetectado(telefono);
    res.json({
      telefono,
      historial_len: historial.length,
      detectado,
      contexto_inyectado: contexto || '(vacio)',
      historial_muestra: historial.slice(0, 10).map(m => ({
        rol: m.rol,
        contenido: (m.contenido || '').slice(0, 200),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Comprime todas las fotos del MEDIA_DIR existentes — para liberar espacio
// del volumen sin perder fotos. Es idempotente: las que ya estan chicas no las toca.
app.get('/api/admin/comprimir-fotos', async (req, res) => {
  try {
    const archivos = fs.readdirSync(MEDIA_DIR).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
    let antes = 0, despues = 0, procesadas = 0;
    for (const f of archivos) {
      const ruta = path.join(MEDIA_DIR, f);
      const sa = fs.statSync(ruta).size;
      antes += sa;
      await comprimirImagen(ruta);
      const sd = fs.statSync(ruta).size;
      despues += sd;
      if (sd < sa) procesadas++;
    }
    const ahorroMB = ((antes - despues) / 1024 / 1024).toFixed(1);
    res.json({
      ok: true,
      total: archivos.length,
      procesadas,
      antes_mb: (antes/1024/1024).toFixed(1),
      despues_mb: (despues/1024/1024).toFixed(1),
      ahorro_mb: ahorroMB,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/reset-passwords', (req, res) => {
  const { db } = require('./database');
  const vendedores = db.prepare('SELECT id, nombre FROM vendedores').all();
  const reseteados = [];
  for (const v of vendedores) {
    const passDefault = v.nombre.toLowerCase() + '1234';
    db.prepare('UPDATE vendedores SET password = ? WHERE id = ?').run(passDefault, v.id);
    reseteados.push({ nombre: v.nombre, password: passDefault });
  }
  res.json({ ok: true, reseteados });
});

// Listar passwords actuales (solo para debug del admin)
app.get('/api/admin/passwords', (req, res) => {
  const { db } = require('./database');
  const vendedores = db.prepare('SELECT nombre, password FROM vendedores').all();
  res.json(vendedores);
});

// Toggle de DISPONIBILIDAD: el vendedor mismo lo prende/apaga desde su dashboard.
// "Recibir leads" = disponible 1, "No recibir" = disponible 0.
// Esto es distinto de "activo" (eso solo lo cambia el admin para pausar a alguien).
app.post('/api/vendedor/:nombre/disponibilidad', (req, res) => {
  const autenticado = getVendedorAutenticado(req);
  const { db } = require('./database');
  const v = db.prepare('SELECT * FROM vendedores WHERE LOWER(nombre) = LOWER(?)').get(req.params.nombre);
  if (!v) return res.status(404).json({ error: 'Vendedor no encontrado' });
  // Solo el vendedor mismo (o el admin desde /admin) puede cambiar su disponibilidad.
  // Permitimos el cambio si está logueado como ese vendedor o si viene del admin (sin cookie de vendedor).
  if (autenticado && autenticado.toLowerCase() !== v.nombre.toLowerCase()) {
    return res.status(403).json({ error: 'Solo podés cambiar tu propia disponibilidad' });
  }
  const nuevo = v.disponible ? 0 : 1;
  db.prepare('UPDATE vendedores SET disponible = ? WHERE id = ?').run(nuevo, v.id);
  console.log(`[Vendedor] ${v.nombre} ahora ${nuevo ? 'DISPONIBLE para leads' : 'fuera de turno (no recibe leads)'}`);
  res.json({ ok: true, disponible: !!nuevo });
});

// Activar/pausar un vendedor (no recibe leads nuevos si está pausado)
app.post('/api/vendedores/activar-todos', (req, res) => {
  const { db } = require('./database');
  const r = db.prepare('UPDATE vendedores SET activo = 1').run();
  console.log(`[Vendedores] Activados todos (${r.changes})`);
  res.json({ ok: true, afectados: r.changes });
});

app.post('/api/vendedores/pausar-todos', (req, res) => {
  const { db } = require('./database');
  const r = db.prepare('UPDATE vendedores SET activo = 0').run();
  console.log(`[Vendedores] Pausados todos (${r.changes})`);
  res.json({ ok: true, afectados: r.changes });
});

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
// === Marketplace: bridge entre la PC de la agencia (scraper local) y Railway ===
// La PC agencia corre marketplace-scraper.js, lee FB, y le manda cada mensaje a este
// endpoint. Acá procesamos con Gonzalo y guardamos en la DB. La PC luego escribe la
// respuesta en Facebook. Así las conversaciones de Marketplace quedan visibles en
// /admin junto a WhatsApp e Instagram.

const MARKETPLACE_SECRET = process.env.MARKETPLACE_SECRET || 'cambia-esto-en-railway';
const mpEstadoRemoto = {
  ultimoHeartbeat: null,
  estado: null,   // lo que reporta el scraper local
  logs: [],       // anillo de los últimos 200 logs recibidos
};

function chequearSecret(req, res) {
  if ((req.body && req.body.secret) !== MARKETPLACE_SECRET) {
    res.status(401).json({ error: 'secret inválido' });
    return false;
  }
  return true;
}

// El scraper local nos pasa un mensaje recién leído de FB y le devolvemos la respuesta.
app.post('/api/marketplace/procesar', async (req, res) => {
  if (!chequearSecret(req, res)) return;
  const { senderId, texto } = req.body || {};
  if (!senderId || !texto) return res.status(400).json({ error: 'falta senderId o texto' });
  try {
    const respuesta = await procesarMensaje(senderId, texto, 'marketplace');
    res.json({ ok: true, respuesta });
  } catch (err) {
    console.error('[Marketplace bridge] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// El scraper local pinguea cada 30s con su estado y logs nuevos.
app.post('/api/marketplace/heartbeat', (req, res) => {
  if (!chequearSecret(req, res)) return;
  const { estado, logsNuevos } = req.body || {};
  mpEstadoRemoto.ultimoHeartbeat = Date.now();
  if (estado) mpEstadoRemoto.estado = estado;
  if (Array.isArray(logsNuevos)) {
    for (const l of logsNuevos) mpEstadoRemoto.logs.push(l);
    while (mpEstadoRemoto.logs.length > 200) mpEstadoRemoto.logs.shift();
  }
  res.json({ ok: true });
});

// El admin panel consulta esto para mostrar estado del scraper remoto.
app.get('/api/marketplace/estado', (req, res) => {
  const conectado = mpEstadoRemoto.ultimoHeartbeat &&
    (Date.now() - mpEstadoRemoto.ultimoHeartbeat) < 90 * 1000;
  res.json({
    modoRemoto: true,
    conectado,
    ultimoHeartbeat: mpEstadoRemoto.ultimoHeartbeat,
    ...(mpEstadoRemoto.estado || {}),
  });
});
app.get('/api/marketplace/logs', (req, res) => {
  const desde = parseInt(req.query.desde) || 0;
  res.json(mpEstadoRemoto.logs.filter(l => l.ts > desde));
});

app.get('/webhook', verificarWebhook);
app.post('/webhook', recibirMensaje);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor Procar Bot v1.1 corriendo en puerto ${PORT}`);
  // Validar token de Meta al arrancar (no bloquea el servidor)
  validarToken().catch(() => {});
  // Iniciar cron de recordatorios (24h y 72h)
  require('./recordatorios').iniciarCron();
});
