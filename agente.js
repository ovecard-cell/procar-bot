const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const {
  buscarAutos,
  guardarLead,
  guardarMensaje,
  obtenerHistorial,
  obtenerVendedorConMenosAsignaciones,
  crearAsignacion,
} = require('./database');
const { enviarWhatsAppVendedor } = require('./mensajero');

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────
// DEFINICIÓN DE HERRAMIENTAS
// ─────────────────────────────────────────────

const herramientas = [
  {
    name: 'buscar_autos',
    description: 'Busca autos disponibles en el inventario de Procar. Puede filtrar por presupuesto máximo, tipo de combustible, transmisión, marca o modelo.',
    input_schema: {
      type: 'object',
      properties: {
        presupuesto_max: {
          type: 'number',
          description: 'Precio máximo en dólares que puede pagar el cliente.'
        },
        combustible: {
          type: 'string',
          description: 'Tipo de combustible: Nafta, Diesel, GNC.'
        },
        transmision: {
          type: 'string',
          description: 'Tipo de transmisión: Manual o Automático.'
        },
        marca: {
          type: 'string',
          description: 'Marca del auto (ej: Toyota, Ford, Chevrolet).'
        },
        modelo: {
          type: 'string',
          description: 'Modelo del auto (ej: Corolla, Ecosport, Onix).'
        }
      }
    }
  },
  {
    name: 'guardar_lead',
    description: 'Guarda los datos de un cliente interesado en comprar un auto. Usar cuando el cliente da su nombre, presupuesto o cuenta qué busca.',
    input_schema: {
      type: 'object',
      properties: {
        telefono: {
          type: 'string',
          description: 'Número de teléfono o ID del cliente.'
        },
        nombre: {
          type: 'string',
          description: 'Nombre del cliente.'
        },
        presupuesto: {
          type: 'number',
          description: 'Presupuesto del cliente en dólares.'
        },
        interes: {
          type: 'string',
          description: 'Descripción de lo que busca el cliente.'
        }
      },
      required: ['telefono']
    }
  },
  {
    name: 'escalar_a_vendedor',
    description: 'Asigna el cliente a un vendedor real (Antonio, Facu o Tiki) y le avisa por WhatsApp. Usar cuando el cliente quiere cotizar su auto, ver financiación, hacer prueba de manejo, ver el auto en persona, o negociar precio.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          description: 'Por qué necesita atención de un vendedor. Ej: quiere cotizar su auto, ver financiación, prueba de manejo.'
        },
        resumen_cliente: {
          type: 'string',
          description: 'Resumen de lo que hablaste con el cliente: qué busca, presupuesto, nombre si lo dio.'
        }
      },
      required: ['motivo', 'resumen_cliente']
    }
  }
];

// ─────────────────────────────────────────────
// EJECUTAR HERRAMIENTAS
// ─────────────────────────────────────────────

async function ejecutarHerramienta(nombre, input, telefono, canal) {
  console.log(`[Agente] Usando herramienta: ${nombre}`, input);

  if (nombre === 'buscar_autos') {
    const autos = buscarAutos(input);
    if (autos.length === 0) {
      return 'No encontré autos disponibles con esos criterios en este momento.';
    }
    return autos.map(a =>
      `• ${a.marca} ${a.modelo} ${a.anio} — USD $${a.precio.toLocaleString()} | ${a.km.toLocaleString()} km | ${a.combustible} | ${a.transmision} | ${a.color}. ${a.descripcion}`
    ).join('\n');
  }

  if (nombre === 'guardar_lead') {
    const resultado = guardarLead({ ...input, telefono, canal });
    return resultado.mensaje;
  }

  if (nombre === 'escalar_a_vendedor') {
    // Elegir al vendedor con menos asignaciones pendientes
    const vendedor = obtenerVendedorConMenosAsignaciones();

    if (!vendedor) {
      return 'No hay vendedores disponibles en este momento. El cliente fue registrado y lo contactaremos pronto.';
    }

    // Crear la asignación en la base de datos
    crearAsignacion({
      cliente_telefono: telefono,
      vendedor_id: vendedor.id,
      motivo: input.motivo,
    });

    // Enviar WhatsApp al vendedor
    const mensajeVendedor = `🚗 *Nuevo cliente asignado*\n\n` +
      `📋 *Motivo:* ${input.motivo}\n` +
      `📝 *Resumen:* ${input.resumen_cliente}\n` +
      `📱 *Cliente:* ${telefono}\n` +
      `📍 *Canal:* ${canal}\n\n` +
      `Contactalo lo antes posible. En 30-40 min te pregunto cómo te fue.`;

    try {
      await enviarWhatsAppVendedor(vendedor.telefono, mensajeVendedor);
    } catch (err) {
      console.error(`[Escalado] Error enviando WhatsApp a ${vendedor.nombre}:`, err.message);
    }

    return `Cliente asignado a ${vendedor.nombre}. Se le envió un WhatsApp con los datos del cliente.`;
  }

  return 'Herramienta no reconocida.';
}

// ─────────────────────────────────────────────
// PROMPT DEL SISTEMA
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `Sos Tito, vendedor de Procar, una agencia de autos usados en Corrientes Capital, Argentina.

PERSONALIDAD:
- Hablás como un correntino: usás "vos", "che", "dale", "bárbaro", "mirá".
- Sos amable y directo, pero no exagerás ni usás muchos emojis.
- No te ponés muy efusivo desde el arranque — primero escuchás al cliente, después te vas soltando.
- Sos honesto y conocés bien el inventario.

TU TRABAJO:
1. Atender al cliente que escribe por Instagram, Facebook Marketplace o WhatsApp.
2. Preguntar qué auto busca, qué presupuesto tiene, cómo lo quiere (nafta/diesel, manual/automático, etc).
3. Buscar en el inventario con la herramienta buscar_autos y mostrarle las opciones.
4. Si el cliente da su nombre o datos, guardar el lead con guardar_lead.
5. Cuando el cliente quiere: cotizar su auto para entregar, ver financiación, hacer prueba de manejo, ver el auto en persona, o negociar precio → usar escalar_a_vendedor para pasarlo a un vendedor real.
6. Si el cliente pregunta por fotos, decile que se las mandás enseguida y escalá al vendedor para que las envíe.

IMPORTANTE:
- No inventes autos que no están en el inventario. Solo ofrecé lo que te devuelve buscar_autos.
- No des precios de financiación ni cotización de usados — eso lo hace el vendedor.
- Respondé siempre en español, de forma natural.
- Sé conciso, no mandes párrafos largos.`;

// ─────────────────────────────────────────────
// PROCESAR MENSAJE
// ─────────────────────────────────────────────

async function procesarMensaje(telefono, mensajeUsuario, canal) {
  guardarMensaje({ telefono, rol: 'user', contenido: mensajeUsuario, canal });

  const historial = obtenerHistorial(telefono);
  const mensajes = historial.map(m => ({
    role: m.rol,
    content: m.contenido
  }));

  let respuesta = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: herramientas,
    messages: mensajes
  });

  // Bucle: si Claude quiere usar herramientas, ejecutarlas y continuar
  while (respuesta.stop_reason === 'tool_use') {
    const usoHerramienta = respuesta.content.find(b => b.type === 'tool_use');
    const resultadoHerramienta = await ejecutarHerramienta(
      usoHerramienta.name,
      usoHerramienta.input,
      telefono,
      canal
    );

    mensajes.push({ role: 'assistant', content: respuesta.content });
    mensajes.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: usoHerramienta.id,
        content: resultadoHerramienta
      }]
    });

    respuesta = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: herramientas,
      messages: mensajes
    });
  }

  const textoRespuesta = respuesta.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  guardarMensaje({ telefono, rol: 'assistant', contenido: textoRespuesta, canal });

  return textoRespuesta;
}

module.exports = { procesarMensaje };
