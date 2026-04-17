const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'procar.db');
const db = new Database(DB_PATH);
console.log('Base de datos conectada: procar.db');

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
      presupuesto INTEGER,
      interes TEXT,
      canal TEXT DEFAULT 'whatsapp',
      estado TEXT DEFAULT 'nuevo',
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telefono TEXT NOT NULL,
      rol TEXT NOT NULL,
      contenido TEXT NOT NULL,
      canal TEXT DEFAULT 'whatsapp',
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS vendedores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      telefono TEXT UNIQUE NOT NULL,
      activo INTEGER DEFAULT 1
    )
  `);

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

  console.log('Tablas verificadas correctamente.');
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

function guardarLead({ telefono, nombre, presupuesto, interes, canal }) {
  db.prepare(`
    INSERT INTO clientes (telefono, nombre, presupuesto, interes, canal)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(telefono) DO UPDATE SET
      nombre = COALESCE(?, nombre),
      presupuesto = COALESCE(?, presupuesto),
      interes = COALESCE(?, interes),
      canal = COALESCE(?, canal),
      actualizado_en = CURRENT_TIMESTAMP
  `).run(telefono, nombre, presupuesto, interes, canal, nombre, presupuesto, interes, canal);
  return { ok: true, mensaje: 'Lead guardado correctamente.' };
}

// ─────────────────────────────────────────────
// CONVERSACIONES
// ─────────────────────────────────────────────

function guardarMensaje({ telefono, rol, contenido, canal }) {
  db.prepare(
    'INSERT INTO conversaciones (telefono, rol, contenido, canal) VALUES (?, ?, ?, ?)'
  ).run(telefono, rol, contenido, canal || 'whatsapp');
}

function obtenerHistorial(telefono) {
  const rows = db.prepare(
    `SELECT rol, contenido FROM conversaciones
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

function obtenerVendedorConMenosAsignaciones() {
  // Elegir el vendedor activo con menos asignaciones pendientes
  const vendedor = db.prepare(`
    SELECT v.*, COUNT(a.id) as asignaciones_pendientes
    FROM vendedores v
    LEFT JOIN asignaciones a ON v.id = a.vendedor_id AND a.estado = 'pendiente'
    WHERE v.activo = 1
    GROUP BY v.id
    ORDER BY asignaciones_pendientes ASC
    LIMIT 1
  `).get();
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
  if (total > 0) return;

  // TODO: Reemplazar con los teléfonos reales de Antonio, Facu y Tiki
  const insert = db.prepare('INSERT INTO vendedores (nombre, telefono) VALUES (?, ?)');
  const vendedores = [
    ['Antonio', '5493794874815'],
    ['Tiki', '5493794659140'],
    ['Facu', '5493794146435'],
    ['Gustavo', '5493794617070'],
  ];

  for (const v of vendedores) insert.run(...v);
  console.log('Vendedores de ejemplo cargados: Antonio, Facu, Tiki.');
}

module.exports = {
  db,
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
};
