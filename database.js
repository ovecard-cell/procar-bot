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
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('Tablas verificadas correctamente.');
}

// ─────────────────────────────────────────────
// HERRAMIENTAS DEL AGENTE
// ─────────────────────────────────────────────

function buscarAutos({ presupuesto_max, combustible, transmision } = {}) {
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

  query += ' ORDER BY precio ASC';
  return db.prepare(query).all(...params);
}

function guardarLead({ telefono, nombre, presupuesto, interes }) {
  db.prepare(`
    INSERT INTO clientes (telefono, nombre, presupuesto, interes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telefono) DO UPDATE SET
      nombre = COALESCE(?, nombre),
      presupuesto = COALESCE(?, presupuesto),
      interes = COALESCE(?, interes),
      actualizado_en = CURRENT_TIMESTAMP
  `).run(telefono, nombre, presupuesto, interes, nombre, presupuesto, interes);
  return { ok: true, mensaje: 'Lead guardado correctamente.' };
}

function guardarMensaje({ telefono, rol, contenido }) {
  db.prepare(
    'INSERT INTO conversaciones (telefono, rol, contenido) VALUES (?, ?, ?)'
  ).run(telefono, rol, contenido);
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

module.exports = {
  db,
  inicializarDB,
  cargarAutosEjemplo,
  buscarAutos,
  guardarLead,
  guardarMensaje,
  obtenerHistorial,
};
