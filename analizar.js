const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { db } = require('./database');

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const PROMPT_CLASIFICACION = `Sos analista de leads de Procar, agencia de autos usados en Corrientes Capital, Argentina.

Te paso una conversación entre un cliente y la agencia (Instagram o Facebook). Tenés que clasificarla en una de estas categorías:

- "caliente": el cliente preguntó algo concreto (precio, disponibilidad, financiación, agendar visita, datos del auto) y NO recibió respuesta o la respuesta fue insuficiente. Hay oportunidad clara de venta perdida o pendiente.
- "tibio": el cliente consultó algo general pero no mostró intención fuerte de comprar todavía.
- "atendido": ya hubo conversación completa, le respondieron bien y se cerró el tema (compró, no le interesó, etc).
- "spam": mensajes irrelevantes, ofertas, vendedores, no son potenciales clientes.

Además identificá:
- "auto_interes": qué auto está mirando o preguntando el cliente (marca + modelo + año si lo dice). Si no lo menciona, devolvé "no especificó".
- "presupuesto": presupuesto que mencionó el cliente, en USD si dice dólares o ARS si dice pesos. Si no lo dice, devolvé "no mencionó".
- "etapa_funnel": en qué punto del proceso de venta está. Opciones: "pregunta_general", "consulta_precio", "pregunta_financiacion", "pide_fotos", "quiere_ver_en_persona", "ofrece_usado_parte_pago", "negociando_precio", "listo_para_cerrar".

Devolvé SOLO un JSON, sin markdown, sin explicaciones:
{
  "categoria": "caliente|tibio|atendido|spam",
  "auto_interes": "Marca Modelo Año o 'no especificó'",
  "presupuesto": "USD 15000 o ARS 5000000 o 'no mencionó'",
  "etapa_funnel": "una de las opciones",
  "motivo": "una frase corta explicando la clasificación",
  "sugerencia": "qué decirle al cliente para reactivarlo (vacío si atendido o spam)"
}`;

// ─────────────────────────────────────────────
// LECTURA DE CONVERSACIONES DESDE DB LOCAL
// ─────────────────────────────────────────────

function obtenerConversacionesDB(desde) {
  // Cada cliente único que tuvo actividad desde `desde`
  const clientes = db.prepare(`
    SELECT telefono, canal, MAX(creado_en) as ultimo_mensaje
    FROM conversaciones
    WHERE creado_en >= ?
    GROUP BY telefono
    ORDER BY ultimo_mensaje DESC
  `).all(desde.toISOString());

  // Para cada cliente, traer su historial completo
  return clientes.map(c => {
    const mensajes = db.prepare(`
      SELECT rol, contenido, canal, creado_en
      FROM conversaciones
      WHERE telefono = ?
      ORDER BY creado_en ASC
    `).all(c.telefono);
    return { telefono: c.telefono, canal: c.canal, ultimo_mensaje: c.ultimo_mensaje, mensajes };
  });
}

// ─────────────────────────────────────────────
// CLASIFICACIÓN CON CLAUDE
// ─────────────────────────────────────────────

async function clasificarConversacion(conv) {
  if (!conv.mensajes || conv.mensajes.length === 0) return null;

  const historial = conv.mensajes
    .map(m => `${m.rol === 'user' ? 'Cliente' : 'Procar'}: ${m.contenido}`)
    .join('\n');

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 384,
    system: PROMPT_CLASIFICACION,
    messages: [{ role: 'user', content: historial }],
  });

  const texto = res.content[0]?.text?.trim() || '';
  let analisis;
  try {
    const limpio = texto.replace(/^```json\s*|\s*```$/g, '');
    analisis = JSON.parse(limpio);
  } catch {
    analisis = { categoria: 'error', motivo: texto.slice(0, 200), sugerencia: '' };
  }

  const ultimoCliente = [...conv.mensajes].reverse().find(m => m.rol === 'user');

  return {
    canal: conv.canal,
    conversacion_id: conv.telefono,
    participantes: conv.telefono,
    actualizado: conv.ultimo_mensaje,
    ultimo_mensaje: ultimoCliente?.contenido || '',
    historial,
    ...analisis,
  };
}

// ─────────────────────────────────────────────
// ANÁLISIS COMPLETO
// ─────────────────────────────────────────────

async function analizar(desde) {
  const resultados = [];
  const errores = [];

  const conversaciones = obtenerConversacionesDB(desde);

  if (conversaciones.length === 0) {
    return { resultados: [], errores: ['No hay conversaciones en la base local desde la fecha indicada. La DB local solo tiene mensajes que el bot recibió por webhook desde que está activo.'] };
  }

  for (const conv of conversaciones) {
    try {
      const r = await clasificarConversacion(conv);
      if (r) resultados.push(r);
    } catch (err) {
      errores.push(`Cliente ${conv.telefono}: ${err.message}`);
    }
  }

  const orden = { caliente: 1, tibio: 2, atendido: 3, spam: 4, error: 5 };
  resultados.sort((a, b) => (orden[a.categoria] || 99) - (orden[b.categoria] || 99));

  return { resultados, errores };
}

// ─────────────────────────────────────────────
// HTML DEL REPORTE
// ─────────────────────────────────────────────

function generarHTML({ resultados, errores }, desde) {
  const calientes = resultados.filter(r => r.categoria === 'caliente').length;
  const tibios = resultados.filter(r => r.categoria === 'tibio').length;
  const atendidos = resultados.filter(r => r.categoria === 'atendido').length;
  const spam = resultados.filter(r => r.categoria === 'spam').length;

  const colores = {
    caliente: '#e63946',
    tibio: '#f4a261',
    atendido: '#2a9d8f',
    spam: '#999',
    error: '#666',
  };

  const filas = resultados.map(r => `
    <tr>
      <td><span class="badge" style="background:${colores[r.categoria]}">${r.categoria.toUpperCase()}</span></td>
      <td>${r.canal}</td>
      <td>${r.participantes}</td>
      <td><strong>${escapar(r.auto_interes || '—')}</strong></td>
      <td>${escapar(r.presupuesto || '—')}</td>
      <td>${escapar((r.etapa_funnel || '').replace(/_/g, ' '))}</td>
      <td>${new Date(r.actualizado).toLocaleString('es-AR')}</td>
      <td class="msg">${escapar(r.ultimo_mensaje).slice(0, 120)}</td>
      <td>${escapar(r.motivo)}</td>
      <td class="sugerencia">${escapar(r.sugerencia || '—')}</td>
      <td><details><summary>ver</summary><pre>${escapar(r.historial)}</pre></details></td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>Análisis de mensajes — Procar</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f0f2f5; margin: 0; padding: 24px; color: #222; }
  h1 { color: #1a1a2e; margin-bottom: 8px; }
  .desde { color: #666; margin-bottom: 24px; }
  .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat { background: white; padding: 16px 24px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .stat .num { font-size: 2rem; font-weight: bold; }
  .stat .label { color: #666; font-size: 0.9rem; text-transform: uppercase; }
  table { width: 100%; background: white; border-collapse: collapse; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  th { background: #1a1a2e; color: white; padding: 12px; text-align: left; font-size: 0.85rem; }
  td { padding: 12px; border-bottom: 1px solid #eee; vertical-align: top; font-size: 0.88rem; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 12px; color: white; font-size: 0.75rem; font-weight: bold; }
  .msg { max-width: 220px; color: #555; }
  .sugerencia { max-width: 280px; color: #2a9d8f; font-style: italic; }
  details summary { cursor: pointer; color: #1a1a2e; }
  pre { background: #f8f8f8; padding: 12px; border-radius: 6px; white-space: pre-wrap; font-size: 0.8rem; max-width: 500px; }
  .errores { background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin-bottom: 24px; border-radius: 6px; }
</style>
</head>
<body>
  <h1>Análisis de mensajes — Procar</h1>
  <p class="desde">Conversaciones desde <strong>${desde.toLocaleString('es-AR')}</strong> · Total analizadas: <strong>${resultados.length}</strong></p>

  <div class="stats">
    <div class="stat"><div class="num" style="color:#e63946">${calientes}</div><div class="label">🔥 Calientes</div></div>
    <div class="stat"><div class="num" style="color:#f4a261">${tibios}</div><div class="label">🟡 Tibios</div></div>
    <div class="stat"><div class="num" style="color:#2a9d8f">${atendidos}</div><div class="label">✅ Atendidos</div></div>
    <div class="stat"><div class="num" style="color:#999">${spam}</div><div class="label">🗑️ Spam</div></div>
  </div>

  ${errores.length > 0 ? `<div class="errores"><strong>Avisos:</strong><br>${errores.map(e => escapar(e)).join('<br>')}</div>` : ''}

  <table>
    <thead>
      <tr>
        <th>Categoría</th>
        <th>Canal</th>
        <th>Cliente</th>
        <th>🚗 Auto de interés</th>
        <th>💰 Presupuesto</th>
        <th>📍 Etapa</th>
        <th>Última act.</th>
        <th>Último mensaje</th>
        <th>Motivo</th>
        <th>Sugerencia para reactivar</th>
        <th>Historial</th>
      </tr>
    </thead>
    <tbody>${filas}</tbody>
  </table>
</body>
</html>`;
}

function escapar(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { analizar, generarHTML };
