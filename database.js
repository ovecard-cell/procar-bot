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
      canales TEXT DEFAULT 'todos',
      password TEXT
    )
  `);

  // Migración: agregar columnas si la tabla ya existía
  try { db.exec("ALTER TABLE vendedores ADD COLUMN canales TEXT DEFAULT 'todos'"); } catch (e) { /* ya existe */ }
  try { db.exec("ALTER TABLE vendedores ADD COLUMN password TEXT"); } catch (e) { /* ya existe */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS asignaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_telefono TEXT NOT NULL,
      vendedor_id INTEGER NOT NULL,
      motivo TEXT,
      estado TEXT DEFAULT 'pendiente',
      seguimiento_enviado INTEGER DEFAULT 0,
      resultado TEXT,
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendedor_id) REFERENCES vendedores(id)
    )
  `);

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
  // Elegir el vendedor activo con menos asignaciones pendientes,
  // que además maneje el canal del lead (canales = 'todos' o contiene el canal).
  // canal puede ser: 'messenger', 'facebook', 'instagram', 'whatsapp', 'demo'
  // Tratamos messenger y facebook como equivalentes para routing.
  const canalNormalizado = (canal === 'messenger' || canal === 'facebook') ? 'facebook' : (canal || '');
  const filtros = [
    `canales = 'todos'`,
    `canales LIKE '%${canalNormalizado}%'`,
  ];
  // Permitir el shortcut "redes" o "social" para FB + IG
  if (canalNormalizado === 'facebook' || canalNormalizado === 'instagram') {
    filtros.push(`canales LIKE '%redes%'`);
    filtros.push(`canales LIKE '%social%'`);
  }
  const where = filtros.map(f => `(${f})`).join(' OR ');

  const vendedor = db.prepare(`
    SELECT v.*, COUNT(a.id) as asignaciones_pendientes
    FROM vendedores v
    LEFT JOIN asignaciones a ON v.id = a.vendedor_id AND a.estado = 'pendiente'
    WHERE v.activo = 1 AND (${where})
    GROUP BY v.id
    ORDER BY asignaciones_pendientes ASC
    LIMIT 1
  `).get();

  // Fallback: si nadie maneja ese canal específico, traer cualquier activo
  if (!vendedor) {
    return db.prepare(`
      SELECT v.*, COUNT(a.id) as asignaciones_pendientes
      FROM vendedores v
      LEFT JOIN asignaciones a ON v.id = a.vendedor_id AND a.estado = 'pendiente'
      WHERE v.activo = 1
      GROUP BY v.id
      ORDER BY asignaciones_pendientes ASC
      LIMIT 1
    `).get();
  }
  return vendedor;
}

// ─────────────────────────────────────────────
// ASIGNACIONES
// ─────────────────────────────────────────────

function crearAsignacion({ cliente_telefono, vendedor_id, motivo }) {
  const result = db.prepare(`
    INSERT INTO asignaciones (cliente_telefono, vendedor_id, motivo)
    VALUES (?, ?, ?)
  `).run(cliente_telefono, vendedor_id, motivo);
  return result.lastInsertRowid;
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
  obtenerAsignacionesPendientes,
  actualizarAsignacion,
  marcarSeguimientoEnviado,
  getSetting,
  setSetting,
  autenticarVendedor,
  cambiarPassword,
};
