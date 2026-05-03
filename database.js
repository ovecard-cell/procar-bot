const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// La DB tiene que vivir en un volumen persistente cuando estamos en Railway,
// sino cada deploy borra todo. Prioridad:
//   1. DB_PATH explícito (ej. /data/procar.db si montaste un volumen)
//   2. RAILWAY_VOLUME_MOUNT_PATH (Railway lo expone solo si configuraste un volumen)
//   3. fallback: archivo local en el repo (modo desarrollo)
function resolverDBPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'procar.db');
  }
  return path.join(__dirname, 'procar.db');
}

const DB_PATH = resolverDBPath();
const dirDestino = path.dirname(DB_PATH);
if (!fs.existsSync(dirDestino)) {
  fs.mkdirSync(dirDestino, { recursive: true });
  console.log(`Creada carpeta para la DB: ${dirDestino}`);
}

// Carpeta de media: convive con la DB en el mismo volumen persistente
const MEDIA_DIR = path.join(dirDestino, 'media');
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  console.log(`Creada carpeta para media: ${MEDIA_DIR}`);
}

const db = new Database(DB_PATH);
console.log(`Base de datos conectada: ${DB_PATH}`);

// Crear todas las tablas si no existen
function inicializarDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS autos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marca TEXT NOT NULL,
      modelo TEXT NOT NULL,
      anio INTEGER NOT NULL,
      precio INTEGER NOT NULL,
      km INTEGER NOT NULL,
      combustible TEXT NOT NULL,
      transmision TEXT NOT NULL,
      color TEXT,
      descripcion TEXT,
      fotos TEXT,
      disponible INTEGER DEFAULT 1,
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telefono TEXT UNIQUE NOT NULL,
      nombre TEXT,
      cuil TEXT,
      presupuesto INTEGER,
      interes TEXT,
      canal TEXT DEFAULT 'whatsapp',
      estado TEXT DEFAULT 'nuevo',
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migración: agregar cuil si la tabla ya existía sin esa columna
  try {
    db.exec('ALTER TABLE clientes ADD COLUMN cuil TEXT');
  } catch (e) { /* ya existe */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telefono TEXT NOT NULL,
      rol TEXT NOT NULL,
      contenido TEXT NOT NULL,
      tipo TEXT DEFAULT 'texto',
      archivo TEXT,
      canal TEXT DEFAULT 'whatsapp',
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migración: agregar tipo y archivo si la tabla ya existía
  try { db.exec("ALTER TABLE conversaciones ADD COLUMN tipo TEXT DEFAULT 'texto'"); } catch (e) { /* ya existe */ }
  try { db.exec("ALTER TABLE conversaciones ADD COLUMN archivo TEXT"); } catch (e) { /* ya existe */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS vendedores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      telefono TEXT UNIQUE NOT NULL,
      activo INTEGER DEFAULT 1,
      disponible INTEGER DEFAULT 1,
      canales TEXT DEFAULT 'todos',
      password TEXT
    )
  `);

  // Migración: agregar columnas si la tabla ya existía
  try { db.exec("ALTER TABLE vendedores ADD COLUMN canales TEXT DEFAULT 'todos'"); } catch (e) { /* ya existe */ }
  try { db.exec("ALTER TABLE vendedores ADD COLUMN password TEXT"); } catch (e) { /* ya existe */ }
  try { db.exec("ALTER TABLE vendedores ADD COLUMN disponible INTEGER DEFAULT 1"); } catch (e) { /* ya existe */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS asignaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_telefono TEXT NOT NULL,
      vendedor_id INTEGER NOT NULL,
      motivo TEXT,
      estado TEXT DEFAULT 'pendiente',
      seguimiento_enviado INTEGER DEFAULT 0,
      resultado TEXT,
      cliente_nombre TEXT,
      vehiculo_interes TEXT,
      notificado_en DATETIME,
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendedor_id) REFERENCES vendedores(id)
    )
  `);

  // Migración: campos para encolar notificaciones a vendedores fuera de horario
  try { db.exec('ALTER TABLE asignaciones ADD COLUMN cliente_nombre TEXT'); } catch (e) { /* ya existe */ }
  try { db.exec('ALTER TABLE asignaciones ADD COLUMN vehiculo_interes TEXT'); } catch (e) { /* ya existe */ }
  try { db.exec('ALTER TABLE asignaciones ADD COLUMN notificado_en DATETIME'); } catch (e) { /* ya existe */ }
  // Migración: embudo de etapas. nuevo → en_conversacion → cotizado → visita_acordada → vendido | perdido
  try { db.exec("ALTER TABLE asignaciones ADD COLUMN etapa TEXT DEFAULT 'nuevo'"); } catch (e) { /* ya existe */ }
  try { db.exec('ALTER TABLE asignaciones ADD COLUMN motivo_perdido TEXT'); } catch (e) { /* ya existe */ }
  // Backfill: cualquier asignacion vieja sin etapa la dejamos como 'nuevo'
  try { db.exec("UPDATE asignaciones SET etapa = 'nuevo' WHERE etapa IS NULL OR etapa = ''"); } catch (e) { /* ignore */ }

  // Migración: inventario con tipo (auto/moto) y link a la publi de Marketplace.
  try { db.exec("ALTER TABLE autos ADD COLUMN tipo TEXT DEFAULT 'auto'"); } catch (e) { /* ya existe */ }
  try { db.exec('ALTER TABLE autos ADD COLUMN link_publi TEXT'); } catch (e) { /* ya existe */ }
  try { db.exec("UPDATE autos SET tipo = 'auto' WHERE tipo IS NULL OR tipo = ''"); } catch (e) { /* ignore */ }
  // Migración: id_externo (ID del Excel del concesionario) y carrocería (Sedán, SUV, Pick-up, etc).
  // Tambien estado con 3 valores: 'disponible' | 'senado' | 'vendido' — reemplaza al booleano disponible
  // (que dejamos sincronizado por compatibilidad: disponible=1 si estado in ('disponible','senado')).
  try { db.exec('ALTER TABLE autos ADD COLUMN id_externo TEXT'); } catch (e) { /* ya existe */ }
  try { db.exec('ALTER TABLE autos ADD COLUMN carroceria TEXT'); } catch (e) { /* ya existe */ }
  try { db.exec("ALTER TABLE autos ADD COLUMN estado TEXT DEFAULT 'disponible'"); } catch (e) { /* ya existe */ }
  // Backfill: si estado esta null, lo derivamos del booleano disponible
  try { db.exec("UPDATE autos SET estado = CASE WHEN disponible = 1 THEN 'disponible' ELSE 'vendido' END WHERE estado IS NULL OR estado = ''"); } catch (e) { /* ignore */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  console.log('Tablas verificadas correctamente.');
}

// ─────────────────────────────────────────────
// SETTINGS GLOBALES
// ─────────────────────────────────────────────

function getSetting(key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = ?
  `).run(key, String(value), String(value));
}

// ─────────────────────────────────────────────
// INVENTARIO
// ─────────────────────────────────────────────

function buscarAutos({ presupuesto_max, combustible, transmision, marca, modelo } = {}) {
  let query = 'SELECT * FROM autos WHERE disponible = 1';
  const params = [];

  if (presupuesto_max) {
    query += ' AND precio <= ?';
    params.push(presupuesto_max);
  }
  if (combustible) {
    query += ' AND LOWER(combustible) = LOWER(?)';
    params.push(combustible);
  }
  if (transmision) {
    query += ' AND LOWER(transmision) = LOWER(?)';
    params.push(transmision);
  }
  if (marca) {
    query += ' AND LOWER(marca) LIKE LOWER(?)';
    params.push(`%${marca}%`);
  }
  if (modelo) {
    query += ' AND LOWER(modelo) LIKE LOWER(?)';
    params.push(`%${modelo}%`);
  }

  query += ' ORDER BY precio ASC';
  return db.prepare(query).all(...params);
}

// ─────────────────────────────────────────────
// CLIENTES / LEADS
// ─────────────────────────────────────────────

function guardarLead({ telefono, nombre, cuil, presupuesto, interes, canal }) {
  db.prepare(`
    INSERT INTO clientes (telefono, nombre, cuil, presupuesto, interes, canal)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(telefono) DO UPDATE SET
      nombre = COALESCE(?, nombre),
      cuil = COALESCE(?, cuil),
      presupuesto = COALESCE(?, presupuesto),
      interes = COALESCE(?, interes),
      canal = COALESCE(?, canal),
      actualizado_en = CURRENT_TIMESTAMP
  `).run(telefono, nombre, cuil, presupuesto, interes, canal, nombre, cuil, presupuesto, interes, canal);
  return { ok: true, mensaje: 'Lead guardado correctamente.' };
}

// ─────────────────────────────────────────────
// CONVERSACIONES
// ─────────────────────────────────────────────

function guardarMensaje({ telefono, rol, contenido, canal, tipo, archivo }) {
  db.prepare(
    'INSERT INTO conversaciones (telefono, rol, contenido, tipo, archivo, canal) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(telefono, rol, contenido, tipo || 'texto', archivo || null, canal || 'whatsapp');
}

function obtenerHistorial(telefono) {
  // Devolvemos las filas crudas. El agente decide qué hacer con cada tipo
  // (las imágenes las pasa a Claude como bloques de imagen para vision).
  const rows = db.prepare(
    `SELECT rol, contenido, tipo, archivo FROM conversaciones
     WHERE telefono = ?
     ORDER BY creado_en DESC LIMIT 20`
  ).all(telefono);
  return rows.reverse();
}

// ─────────────────────────────────────────────
// VENDEDORES
// ─────────────────────────────────────────────

function obtenerVendedores() {
  return db.prepare('SELECT * FROM vendedores WHERE activo = 1').all();
}

function obtenerVendedorConMenosAsignaciones(canal) {
  // Elegir el vendedor con menos asignaciones pendientes.
  // Preferencia: 1) activo + disponible + maneja el canal,
  //              2) activo + disponible (cualquier canal),
  //              3) activo (aunque no esté disponible — la notificación queda en cola)
  const canalNormalizado = (canal === 'messenger' || canal === 'facebook') ? 'facebook' : (canal || '');
  const filtrosCanal = [
    `canales = 'todos'`,
    `canales LIKE '%${canalNormalizado}%'`,
  ];
  if (canalNormalizado === 'facebook' || canalNormalizado === 'instagram') {
    filtrosCanal.push(`canales LIKE '%redes%'`);
    filtrosCanal.push(`canales LIKE '%social%'`);
  }
  const whereCanal = filtrosCanal.map(f => `(${f})`).join(' OR ');

  const elegir = (whereExtra) => db.prepare(`
    SELECT v.*, COUNT(a.id) as asignaciones_pendientes
    FROM vendedores v
    LEFT JOIN asignaciones a ON v.id = a.vendedor_id AND a.estado = 'pendiente'
    WHERE v.activo = 1 ${whereExtra}
    GROUP BY v.id
    ORDER BY asignaciones_pendientes ASC
    LIMIT 1
  `).get();

  return elegir(`AND v.disponible = 1 AND (${whereCanal})`)
      || elegir(`AND v.disponible = 1`)
      || elegir('');
}

// ─────────────────────────────────────────────
// ASIGNACIONES
// ─────────────────────────────────────────────

function crearAsignacion({ cliente_telefono, vendedor_id, motivo, cliente_nombre, vehiculo_interes }) {
  const result = db.prepare(`
    INSERT INTO asignaciones (cliente_telefono, vendedor_id, motivo, cliente_nombre, vehiculo_interes)
    VALUES (?, ?, ?, ?, ?)
  `).run(cliente_telefono, vendedor_id, motivo, cliente_nombre || null, vehiculo_interes || null);
  return result.lastInsertRowid;
}

function marcarAsignacionNotificada(id) {
  db.prepare(`UPDATE asignaciones SET notificado_en = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
}

// Devuelve asignaciones que todavía no se notificaron al vendedor por WhatsApp.
// Trae también el teléfono del vendedor para poder mandarle el mensaje.
function asignacionesPendientesDeNotificar() {
  return db.prepare(`
    SELECT a.id, a.cliente_telefono, a.cliente_nombre, a.vehiculo_interes, a.motivo,
           v.id as vendedor_id, v.nombre as vendedor_nombre, v.telefono as vendedor_telefono,
           v.activo as vendedor_activo, v.disponible as vendedor_disponible
    FROM asignaciones a
    JOIN vendedores v ON v.id = a.vendedor_id
    WHERE a.notificado_en IS NULL
    ORDER BY a.creado_en ASC
  `).all();
}

function obtenerAsignacionesPendientes() {
  return db.prepare(`
    SELECT a.*, v.nombre as vendedor_nombre, v.telefono as vendedor_telefono
    FROM asignaciones a
    JOIN vendedores v ON a.vendedor_id = v.id
    WHERE a.estado = 'pendiente'
    ORDER BY a.creado_en ASC
  `).all();
}

function actualizarAsignacion(id, { estado, resultado }) {
  db.prepare(`
    UPDATE asignaciones SET estado = ?, resultado = ?, actualizado_en = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(estado, resultado, id);
}

function marcarSeguimientoEnviado(id) {
  db.prepare(`
    UPDATE asignaciones SET seguimiento_enviado = 1, actualizado_en = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}

// ─────────────────────────────────────────────
// INVENTARIO (autos + motos)
// La columna 'fotos' guarda un JSON array de filenames servidos por /media.
// La columna 'link_publi' guarda la URL de la publi de Marketplace.
// ─────────────────────────────────────────────

function listarInventario({ tipo, soloDisponibles } = {}) {
  let query = 'SELECT * FROM autos';
  const conds = [];
  const params = [];
  if (tipo) { conds.push('LOWER(tipo) = LOWER(?)'); params.push(tipo); }
  if (soloDisponibles) { conds.push('disponible = 1'); }
  if (conds.length) query += ' WHERE ' + conds.join(' AND ');
  query += ' ORDER BY disponible DESC, creado_en DESC';
  const filas = db.prepare(query).all(...params);
  return filas.map(parsearFotos);
}

function obtenerAuto(id) {
  const fila = db.prepare('SELECT * FROM autos WHERE id = ?').get(id);
  return fila ? parsearFotos(fila) : null;
}

function parsearFotos(fila) {
  let fotos = [];
  if (fila.fotos) {
    try { fotos = JSON.parse(fila.fotos); }
    catch (e) { fotos = String(fila.fotos).split(',').map(s => s.trim()).filter(Boolean); }
  }
  return { ...fila, fotos };
}

const ESTADOS_AUTO = ['disponible', 'senado', 'vendido'];

function estadoADisponible(estado) {
  // disponible y senado se consideran "todavia se ofrece"; vendido NO.
  return (estado === 'disponible' || estado === 'senado') ? 1 : 0;
}

function crearAuto(data) {
  const fotosJson = JSON.stringify(data.fotos || []);
  const estado = ESTADOS_AUTO.includes(data.estado) ? data.estado : (data.disponible === false ? 'vendido' : 'disponible');
  const r = db.prepare(`
    INSERT INTO autos (id_externo, tipo, carroceria, marca, modelo, anio, precio, km, combustible, transmision, color, descripcion, link_publi, fotos, estado, disponible)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.id_externo || null,
    data.tipo || 'auto',
    data.carroceria || null,
    data.marca,
    data.modelo,
    parseInt(data.anio, 10) || null,
    parseInt(data.precio, 10) || 0,
    parseInt(data.km, 10) || 0,
    data.combustible || '',
    data.transmision || '',
    data.color || null,
    data.descripcion || null,
    data.link_publi || null,
    fotosJson,
    estado,
    estadoADisponible(estado)
  );
  return r.lastInsertRowid;
}

function actualizarAuto(id, data) {
  const actual = obtenerAuto(id);
  if (!actual) throw new Error('Auto no encontrado');
  const fotos = data.fotos !== undefined ? data.fotos : actual.fotos;
  const estado = data.estado !== undefined
    ? (ESTADOS_AUTO.includes(data.estado) ? data.estado : actual.estado)
    : (data.disponible !== undefined ? (data.disponible ? 'disponible' : 'vendido') : actual.estado);
  db.prepare(`
    UPDATE autos
    SET id_externo = ?, tipo = ?, carroceria = ?, marca = ?, modelo = ?, anio = ?, precio = ?, km = ?,
        combustible = ?, transmision = ?, color = ?, descripcion = ?,
        link_publi = ?, fotos = ?, estado = ?, disponible = ?
    WHERE id = ?
  `).run(
    data.id_externo ?? actual.id_externo,
    data.tipo ?? actual.tipo,
    data.carroceria ?? actual.carroceria,
    data.marca ?? actual.marca,
    data.modelo ?? actual.modelo,
    data.anio !== undefined ? (parseInt(data.anio, 10) || null) : actual.anio,
    data.precio !== undefined ? (parseInt(data.precio, 10) || 0) : actual.precio,
    data.km !== undefined ? (parseInt(data.km, 10) || 0) : actual.km,
    data.combustible ?? actual.combustible,
    data.transmision ?? actual.transmision,
    data.color ?? actual.color,
    data.descripcion ?? actual.descripcion,
    data.link_publi ?? actual.link_publi,
    JSON.stringify(fotos),
    estado,
    estadoADisponible(estado),
    id
  );
}

function cambiarEstadoAuto(id, estado) {
  if (!ESTADOS_AUTO.includes(estado)) throw new Error('Estado invalido: ' + estado);
  db.prepare('UPDATE autos SET estado = ?, disponible = ? WHERE id = ?').run(estado, estadoADisponible(estado), id);
}

function obtenerAutoPorIdExterno(idExterno) {
  if (!idExterno) return null;
  const fila = db.prepare('SELECT * FROM autos WHERE id_externo = ?').get(String(idExterno));
  return fila ? parsearFotos(fila) : null;
}

function eliminarAuto(id) {
  db.prepare('DELETE FROM autos WHERE id = ?').run(id);
}

// ─────────────────────────────────────────────
// EMBUDO DE ETAPAS
// Etapas validas: nuevo → en_conversacion → cotizado → visita_acordada → vendido | perdido
// ─────────────────────────────────────────────

const ETAPAS_VALIDAS = ['nuevo', 'en_conversacion', 'cotizado', 'visita_acordada', 'vendido', 'perdido'];
const ETAPAS_CERRADAS = ['vendido', 'perdido'];

function actualizarEtapaAsignacion(id, etapa, motivoPerdido) {
  if (!ETAPAS_VALIDAS.includes(etapa)) {
    throw new Error(`Etapa invalida: ${etapa}. Validas: ${ETAPAS_VALIDAS.join(', ')}`);
  }
  // Si pasa a 'perdido' guardamos el motivo. Si pasa a otra etapa, lo limpiamos.
  // Tambien sincronizamos 'estado' para mantener compatibilidad con codigo viejo.
  const estadoLegacy = ETAPAS_CERRADAS.includes(etapa) ? 'cerrado' : 'pendiente';
  const motivo = etapa === 'perdido' ? (motivoPerdido || null) : null;
  db.prepare(`
    UPDATE asignaciones
    SET etapa = ?, motivo_perdido = ?, estado = ?, actualizado_en = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(etapa, motivo, estadoLegacy, id);
}

// Mueve a 'en_conversacion' solo si todavia esta en 'nuevo'.
// Asi no pisamos etapas mas avanzadas cuando el vendedor sigue mandando mensajes.
function avanzarAEnConversacion(asignacionId) {
  db.prepare(`
    UPDATE asignaciones
    SET etapa = 'en_conversacion', actualizado_en = CURRENT_TIMESTAMP
    WHERE id = ? AND etapa = 'nuevo'
  `).run(asignacionId);
}

// Busca la asignacion mas reciente del cliente — usado para mover etapa cuando
// el vendedor escribe desde el dashboard.
function obtenerUltimaAsignacionPorTelefono(telefono) {
  return db.prepare(`
    SELECT id, etapa, vendedor_id
    FROM asignaciones
    WHERE cliente_telefono = ?
    ORDER BY creado_en DESC
    LIMIT 1
  `).get(telefono);
}

// Devuelve todas las asignaciones agrupadas por etapa, con datos del vendedor
// y del cliente. Filtro opcional por nombre de vendedor (para /vendedor/:nombre/embudo).
function obtenerEmbudo({ vendedor } = {}) {
  let query = `
    SELECT a.id, a.cliente_telefono, a.cliente_nombre, a.vehiculo_interes, a.motivo,
           a.etapa, a.motivo_perdido, a.creado_en, a.actualizado_en,
           v.nombre as vendedor_nombre,
           cl.nombre as cliente_nombre_db,
           (SELECT MAX(creado_en) FROM conversaciones WHERE telefono = a.cliente_telefono) as ultimo_mensaje
    FROM asignaciones a
    JOIN vendedores v ON v.id = a.vendedor_id
    LEFT JOIN clientes cl ON cl.telefono = a.cliente_telefono
  `;
  const params = [];
  if (vendedor) {
    query += ` WHERE LOWER(v.nombre) = LOWER(?)`;
    params.push(vendedor);
  }
  query += ` ORDER BY a.actualizado_en DESC`;
  const filas = db.prepare(query).all(...params);
  // Resolver nombre del cliente: el de la asignacion o el de la tabla clientes
  return filas.map(f => ({
    id: f.id,
    cliente_telefono: f.cliente_telefono,
    cliente_nombre: f.cliente_nombre || f.cliente_nombre_db || `Cliente ${String(f.cliente_telefono).slice(-4)}`,
    vehiculo_interes: f.vehiculo_interes || 'consulta general',
    motivo: f.motivo,
    etapa: f.etapa || 'nuevo',
    motivo_perdido: f.motivo_perdido,
    vendedor: f.vendedor_nombre,
    creado_en: f.creado_en,
    actualizado_en: f.actualizado_en,
    ultimo_mensaje: f.ultimo_mensaje,
  }));
}

// ─────────────────────────────────────────────
// DATOS DE EJEMPLO
// ─────────────────────────────────────────────

function cargarAutosEjemplo() {
  const { total } = db.prepare('SELECT COUNT(*) as total FROM autos').get();
  if (total > 0) return;

  const insert = db.prepare(`
    INSERT INTO autos (marca, modelo, anio, precio, km, combustible, transmision, color, descripcion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const autos = [
    ['Toyota', 'Corolla', 2020, 18000, 45000, 'Nafta', 'Automático', 'Blanco', 'Excelente estado, único dueño, service al día.'],
    ['Volkswagen', 'Gol Trend', 2019, 11000, 62000, 'Nafta', 'Manual', 'Gris', 'Full equipo, airbags, ABS. Muy económico.'],
    ['Ford', 'Ecosport', 2021, 22000, 30000, 'Nafta', 'Automático', 'Negro', 'SUV compacta ideal para ciudad y ruta.'],
    ['Chevrolet', 'Onix', 2022, 15000, 18000, 'Nafta', 'Manual', 'Rojo', 'Casi 0km, garantía de fábrica vigente.'],
    ['Renault', 'Kangoo', 2018, 9500, 88000, 'GNC', 'Manual', 'Blanco', 'Doble combustible, ideal para trabajo. Muy bajo costo operativo.'],
    ['Honda', 'HR-V', 2020, 25000, 40000, 'Nafta', 'Automático', 'Plata', 'SUV mediana, asientos de cuero, pantalla táctil.'],
  ];

  const insertMany = db.transaction((autos) => {
    for (const auto of autos) insert.run(...auto);
  });
  insertMany(autos);

  console.log('Inventario de ejemplo cargado: 6 autos.');
}

function cargarVendedoresEjemplo() {
  const { total } = db.prepare('SELECT COUNT(*) as total FROM vendedores').get();
  if (total === 0) {
    const insert = db.prepare('INSERT INTO vendedores (nombre, telefono, password) VALUES (?, ?, ?)');
    const vendedores = [
      ['Antonio',   '5493794874815', 'antonio1234'],
      ['Cristhian', '5493794659140', 'cristhian1234'],
      ['Facu',      '5493794146435', 'facu1234'],
      ['Gustavo',   '5493794617070', 'gustavo1234'],
    ];
    for (const v of vendedores) insert.run(...v);
    console.log('Vendedores cargados con contraseñas iniciales.');
  }

  // Migración: renombrar Tiki → Cristhian si todavía existe
  const tiki = db.prepare("SELECT id FROM vendedores WHERE LOWER(nombre) = 'tiki'").get();
  if (tiki) {
    db.prepare("UPDATE vendedores SET nombre = 'Cristhian', password = 'cristhian1234' WHERE id = ?").run(tiki.id);
    console.log('[Migración] Tiki renombrado a Cristhian (password: cristhian1234)');
  }

  // Si algún vendedor existente no tiene password, le pongo una default
  const sinPass = db.prepare("SELECT id, nombre FROM vendedores WHERE password IS NULL OR password = ''").all();
  for (const v of sinPass) {
    const passDefault = v.nombre.toLowerCase() + '1234';
    db.prepare('UPDATE vendedores SET password = ? WHERE id = ?').run(passDefault, v.id);
    console.log(`[Auth] Password inicial seteada para ${v.nombre}: ${passDefault}`);
  }
}

function autenticarVendedor(nombre, password) {
  const v = db.prepare('SELECT * FROM vendedores WHERE LOWER(nombre) = LOWER(?)').get(nombre);
  if (!v) return null;
  if (v.password !== password) return null;
  return v;
}

function cambiarPassword(nombre, nuevaPass) {
  const r = db.prepare('UPDATE vendedores SET password = ? WHERE LOWER(nombre) = LOWER(?)').run(nuevaPass, nombre);
  return r.changes > 0;
}

module.exports = {
  db,
  MEDIA_DIR,
  inicializarDB,
  cargarAutosEjemplo,
  cargarVendedoresEjemplo,
  buscarAutos,
  guardarLead,
  guardarMensaje,
  obtenerHistorial,
  obtenerVendedores,
  obtenerVendedorConMenosAsignaciones,
  crearAsignacion,
  marcarAsignacionNotificada,
  asignacionesPendientesDeNotificar,
  obtenerAsignacionesPendientes,
  actualizarAsignacion,
  marcarSeguimientoEnviado,
  actualizarEtapaAsignacion,
  avanzarAEnConversacion,
  obtenerUltimaAsignacionPorTelefono,
  obtenerEmbudo,
  ETAPAS_VALIDAS,
  ETAPAS_CERRADAS,
  listarInventario,
  obtenerAuto,
  obtenerAutoPorIdExterno,
  crearAuto,
  actualizarAuto,
  cambiarEstadoAuto,
  eliminarAuto,
  ESTADOS_AUTO,
  getSetting,
  setSetting,
  autenticarVendedor,
  cambiarPassword,
};
