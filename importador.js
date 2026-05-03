// ─────────────────────────────────────────────
// Importador de inventario desde Excel
//
// Formato esperado (columnas, no importa el orden — matcheamos por nombre):
//   ID (col A, opcional pero recomendado para sincronizar)
//   MARCA, MODELO, TIPO (carroceria), AÑO, COLOR, KM, Caja (transmisión),
//   Precio de lista, Estado, Link Marketplace
//
// Reglas:
// - "NO PASAR" en cualquier campo numerico → estado = 'vendido' para no ofrecerlo.
// - Fila sin MARCA o MODELO → ignorada.
// - Estado del Excel: "Disponible" → 'disponible', "Señado"/"Senado"/"Reservado" → 'senado',
//   "Vendido"/"Cerrado" → 'vendido'. Si esta vacio, default 'disponible'.
// ─────────────────────────────────────────────
const XLSX = require('xlsx');
const { obtenerAutoPorIdExterno, listarInventario } = require('./database');

// Normaliza el nombre de una columna: minúsculas, sin acentos, sin espacios extras.
function normCol(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Mapeo de aliases a la clave canonica
const ALIASES = {
  id: ['id', 'idinterno', 'codigo', 'cod', 'numero'],
  marca: ['marca'],
  modelo: ['modelo'],
  carroceria: ['tipo', 'carroceria', 'segmento'],
  anio: ['anio', 'ano', 'year'],
  color: ['color'],
  km: ['km', 'kilometros', 'kilometraje'],
  transmision: ['caja', 'transmision', 'transmision'],
  precio: ['preciodelista', 'precio', 'preciolista'],
  estado: ['estado', 'situacion'],
  link: ['linkmarketplace', 'link', 'url', 'enlace', 'publi'],
};

function detectarColumnas(headerRow) {
  const map = {};
  for (let i = 0; i < headerRow.length; i++) {
    const h = normCol(headerRow[i]);
    if (!h) continue;
    for (const [canon, alias] of Object.entries(ALIASES)) {
      if (alias.some(a => h.includes(a))) {
        if (!(canon in map)) map[canon] = i;
      }
    }
  }
  return map;
}

function tieneNoPasar(...vals) {
  return vals.some(v => typeof v === 'string' && /no\s*pasar/i.test(v));
}

function normalizarEstado(raw) {
  const t = normCol(raw);
  if (!t || t === 'disponible') return 'disponible';
  if (t.includes('senad') || t.includes('reserv')) return 'senado';
  if (t.includes('vendid') || t.includes('cerrad')) return 'vendido';
  return 'disponible';
}

function aNumero(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    // Si tiene "no pasar" u otro texto, devolvemos 0
    if (!/^[\d.,\s$-]+$/.test(v)) return 0;
    return parseInt(v.replace(/[^\d-]/g, ''), 10) || 0;
  }
  return 0;
}

// Parsea el Excel y devuelve la lista de items normalizados.
function parsearExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('El Excel no tiene ninguna hoja');

  const filas = XLSX.utils.sheet_to_json(ws, { defval: null, header: 1 });

  // Buscamos la fila de header: la primera que tenga "MARCA" y "MODELO"
  let headerIdx = -1;
  for (let i = 0; i < filas.length; i++) {
    const f = filas[i] || [];
    const norm = f.map(normCol);
    if (norm.includes('marca') && norm.includes('modelo')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new Error('No encontré la fila con columnas MARCA y MODELO');

  const colMap = detectarColumnas(filas[headerIdx]);
  if (colMap.marca == null || colMap.modelo == null) {
    throw new Error('Faltan columnas MARCA o MODELO');
  }

  const items = [];
  for (let i = headerIdx + 1; i < filas.length; i++) {
    const f = filas[i] || [];
    const get = (col) => col != null ? f[col] : null;
    const marca = (get(colMap.marca) || '').toString().trim();
    const modelo = (get(colMap.modelo) || '').toString().trim();
    if (!marca || !modelo) continue;

    const id = get(colMap.id);
    const km = get(colMap.km);
    const precio = get(colMap.precio);
    // "NO PASAR" en un campo (ej KM) significa que NO compartimos ese dato,
    // pero el auto sigue disponible. Lo guardamos en una nota para que el
    // vendedor lo vea y para que mas adelante Gonzalo lo respete.
    const kmNoCompartir = typeof km === 'string' && /no\s*pasar/i.test(km);
    const precioNoCompartir = typeof precio === 'string' && /no\s*pasar/i.test(precio);

    const estado = normalizarEstado(get(colMap.estado));

    let descripcion = null;
    const notas = [];
    if (kmNoCompartir) notas.push('No compartir km con cliente');
    if (precioNoCompartir) notas.push('No compartir precio con cliente');
    if (notas.length) descripcion = '⚠️ ' + notas.join(' · ');

    items.push({
      id_externo: id != null ? String(id).trim() : null,
      marca,
      modelo,
      carroceria: (get(colMap.carroceria) || '').toString().trim() || null,
      anio: parseInt(get(colMap.anio), 10) || null,
      color: (get(colMap.color) || '').toString().trim() || null,
      km: aNumero(km),
      transmision: (get(colMap.transmision) || '').toString().trim() || null,
      precio: aNumero(precio),
      estado,
      link_publi: (get(colMap.link) || '').toString().trim() || null,
      descripcion,
    });
  }

  return items;
}

// Compara los items del Excel contra el inventario actual de la DB
// y categoriza en nuevos / actualizados / sin cambios.
function categorizar(items) {
  const nuevos = [];
  const actualizados = []; // { id, antes, despues, cambios: [campo, antes, despues] }
  const sinCambios = [];

  for (const item of items) {
    const existente = item.id_externo
      ? obtenerAutoPorIdExterno(item.id_externo)
      : null;

    if (!existente) {
      nuevos.push(item);
      continue;
    }

    // Comparamos campos relevantes
    const cambios = [];
    const compararCampo = (campo, valExcel, valDB) => {
      const a = (valExcel == null ? '' : String(valExcel).trim());
      const b = (valDB == null ? '' : String(valDB).trim());
      if (a !== b) cambios.push({ campo, antes: valDB, despues: valExcel });
    };
    compararCampo('marca', item.marca, existente.marca);
    compararCampo('modelo', item.modelo, existente.modelo);
    compararCampo('carroceria', item.carroceria, existente.carroceria);
    compararCampo('anio', item.anio, existente.anio);
    compararCampo('color', item.color, existente.color);
    compararCampo('km', item.km, existente.km);
    compararCampo('transmision', item.transmision, existente.transmision);
    compararCampo('precio', item.precio, existente.precio);
    compararCampo('estado', item.estado, existente.estado);
    compararCampo('link_publi', item.link_publi, existente.link_publi);

    if (cambios.length === 0) sinCambios.push({ id: existente.id, item });
    else actualizados.push({ id: existente.id, item, cambios });
  }

  return { nuevos, actualizados, sinCambios };
}

// Detecta autos que estaban en la DB con id_externo pero NO vinieron en el Excel.
// Estos podrian estar vendidos / faltantes — devolvemos para que el usuario decida.
function detectarFaltantes(items) {
  const idsExcel = new Set(items.map(i => i.id_externo).filter(Boolean));
  const enDB = listarInventario({}); // todos
  return enDB.filter(a => a.id_externo && !idsExcel.has(a.id_externo) && a.estado !== 'vendido');
}

module.exports = {
  parsearExcel,
  categorizar,
  detectarFaltantes,
};
