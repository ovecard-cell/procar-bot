const { analizar } = require('./analizar');
const { obtenerVendedorConMenosAsignaciones, crearAsignacion } = require('./database');
const { enviarWhatsAppVendedor } = require('./mensajero');

function formatearMensajeVendedor(lead) {
  const fecha = new Date(lead.actualizado).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });

  return `🔥 *LEAD RECUPERADO — ${lead.canal.toUpperCase()}*\n\n` +
    `👤 *Cliente:* ${lead.participantes}\n` +
    `🚗 *Auto de interés:* ${lead.auto_interes || 'no especificó'}\n` +
    `💰 *Presupuesto:* ${lead.presupuesto || 'no mencionó'}\n` +
    `📍 *Etapa:* ${(lead.etapa_funnel || '').replace(/_/g, ' ')}\n` +
    `📅 *Último contacto:* ${fecha}\n\n` +
    `📝 *Último mensaje del cliente:*\n_"${(lead.ultimo_mensaje || '').slice(0, 200)}"_\n\n` +
    `💡 *Sugerencia para reactivarlo:*\n${lead.sugerencia || '—'}\n\n` +
    `Contactalo lo antes posible. Disculpate por la demora y retomá la conversación desde donde quedó.`;
}

async function distribuirLeads(desde) {
  const { resultados } = await analizar(desde);
  const calientes = resultados.filter(r => r.categoria === 'caliente');
  const reporte = [];

  for (const lead of calientes) {
    const vendedor = obtenerVendedorConMenosAsignaciones(lead.canal);
    if (!vendedor) {
      reporte.push({ cliente: lead.participantes, auto: lead.auto_interes, error: 'No hay vendedores activos' });
      continue;
    }

    const mensaje = formatearMensajeVendedor(lead);

    try {
      await enviarWhatsAppVendedor(vendedor.telefono, mensaje);
      crearAsignacion({
        cliente_telefono: lead.conversacion_id,
        vendedor_id: vendedor.id,
        motivo: `Lead recuperado de ${lead.canal}: ${lead.auto_interes || 'sin especificar'}`,
      });
      reporte.push({
        cliente: lead.participantes,
        auto: lead.auto_interes,
        vendedor: vendedor.nombre,
        canal: lead.canal,
        ok: true,
      });
    } catch (err) {
      reporte.push({
        cliente: lead.participantes,
        auto: lead.auto_interes,
        vendedor: vendedor.nombre,
        error: err.response?.data?.error?.message || err.message,
      });
    }
  }

  return { totalCalientes: calientes.length, reporte };
}

function generarHTMLReporte({ totalCalientes, reporte }) {
  const exitosos = reporte.filter(r => r.ok).length;
  const fallidos = reporte.filter(r => r.error).length;

  const filas = reporte.map(r => `
    <tr>
      <td>${r.ok ? '✅' : '❌'}</td>
      <td>${escapar(r.cliente)}</td>
      <td>${escapar(r.auto || '—')}</td>
      <td>${escapar(r.canal || '—')}</td>
      <td>${escapar(r.vendedor || '—')}</td>
      <td>${escapar(r.error || 'Enviado por WhatsApp')}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>Distribución de leads — Procar</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f0f2f5; padding: 24px; }
  h1 { color: #1a1a2e; }
  .stats { display: flex; gap: 16px; margin-bottom: 24px; }
  .stat { background: white; padding: 16px 24px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .stat .num { font-size: 2rem; font-weight: bold; }
  .stat .label { color: #666; font-size: 0.9rem; text-transform: uppercase; }
  table { width: 100%; background: white; border-collapse: collapse; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  th { background: #1a1a2e; color: white; padding: 12px; text-align: left; }
  td { padding: 12px; border-bottom: 1px solid #eee; font-size: 0.9rem; }
  .nav { margin-bottom: 16px; }
  .nav a { background: #1a1a2e; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; margin-right: 8px; }
</style>
</head>
<body>
  <div class="nav">
    <a href="/analizar">← Ver análisis</a>
    <a href="/agente/estado">Estado del agente</a>
  </div>
  <h1>Distribución de leads a vendedores</h1>
  <div class="stats">
    <div class="stat"><div class="num">${totalCalientes}</div><div class="label">🔥 Calientes detectados</div></div>
    <div class="stat"><div class="num" style="color:#2a9d8f">${exitosos}</div><div class="label">✅ Enviados OK</div></div>
    <div class="stat"><div class="num" style="color:#e63946">${fallidos}</div><div class="label">❌ Fallaron</div></div>
  </div>
  <table>
    <thead>
      <tr><th></th><th>Cliente</th><th>Auto</th><th>Canal</th><th>Vendedor asignado</th><th>Resultado</th></tr>
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

module.exports = { distribuirLeads, generarHTMLReporte };
