const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'procar.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error al abrir la base de datos:', err.message);
  } else {
    console.log('Base de datos conectada: procar.db');
  }
});

// Crear todas las tablas si no existen
function inicializarDB() {
  db.serialize(() => {

    // Tabla de autos (inventario)
    db.run(`
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

    // Tabla de clientes / leads
    db.run(`
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

    // Tabla de conversaciones (memoria del agente)
    db.run(`
      CREATE TABLE IF NOT EXISTS conversaciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telefono TEXT NOT NULL,
        rol TEXT NOT NULL,
        contenido TEXT NOT NULL,
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Tablas verificadas correctamente.');
  });
}

// ─────────────────────────────────────────────
// HERRAMIENTAS DEL AGENTE
// ─────────────────────────────────────────────

// Buscar autos con filtros opcionales
function buscarAutos({ presupuesto_max, combustible, transmision } = {}) {
  return new Promise((resolve, reject) => {
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

    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Guardar o actualizar un lead (cliente interesado)
function guardarLead({ telefono, nombre, presupuesto, interes }) {
  return new Promise((resolve, reject) => {
    db.run(`
      INSERT INTO clientes (telefono, nombre, presupuesto, interes)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(telefono) DO UPDATE SET
        nombre = COALESCE(?, nombre),
        presupuesto = COALESCE(?, presupuesto),
        interes = COALESCE(?, interes),
        actualizado_en = CURRENT_TIMESTAMP
    `, [telefono, nombre, presupuesto, interes, nombre, presupuesto, interes],
    (err) => {
      if (err) reject(err);
      else resolve({ ok: true, mensaje: 'Lead guardado correctamente.' });
    });
  });
}

// Guardar un mensaje en el historial de la conversación
function guardarMensaje({ telefono, rol, contenido }) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO conversaciones (telefono, rol, contenido) VALUES (?, ?, ?)',
      [telefono, rol, contenido],
      (err) => {
        if (err) reject(err);
        else resolve(true);
      }
    );
  });
}

// Obtener el historial de conversación de un cliente (últimos 20 mensajes)
function obtenerHistorial(telefono) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT rol, contenido FROM conversaciones
       WHERE telefono = ?
       ORDER BY creado_en DESC LIMIT 20`,
      [telefono],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows.reverse());
      }
    );
  });
}

// ─────────────────────────────────────────────
// DATOS DE EJEMPLO (se cargan solo si la tabla está vacía)
// ─────────────────────────────────────────────

function cargarAutosEjemplo() {
  db.get('SELECT COUNT(*) as total FROM autos', (err, row) => {
    if (err || row.total > 0) return;

    const autos = [
      ['Toyota', 'Corolla', 2020, 18000, 45000, 'Nafta', 'Automático', 'Blanco', 'Excelente estado, único dueño, service al día.'],
      ['Volkswagen', 'Gol Trend', 2019, 11000, 62000, 'Nafta', 'Manual', 'Gris', 'Full equipo, airbags, ABS. Muy económico.'],
      ['Ford', 'Ecosport', 2021, 22000, 30000, 'Nafta', 'Automático', 'Negro', 'SUV compacta ideal para ciudad y ruta.'],
      ['Chevrolet', 'Onix', 2022, 15000, 18000, 'Nafta', 'Manual', 'Rojo', 'Casi 0km, garantía de fábrica vigente.'],
      ['Renault', 'Kangoo', 2018, 9500, 88000, 'GNC', 'Manual', 'Blanco', 'Doble combustible, ideal para trabajo. Muy bajo costo operativo.'],
      ['Honda', 'HR-V', 2020, 25000, 40000, 'Nafta', 'Automático', 'Plata', 'SUV mediana, asientos de cuero, pantalla táctil.'],
    ];

    const stmt = db.prepare(`
      INSERT INTO autos (marca, modelo, anio, precio, km, combustible, transmision, color, descripcion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    autos.forEach(auto => stmt.run(auto));
    stmt.finalize();

    console.log('Inventario de ejemplo cargado: 6 autos.');
  });
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
