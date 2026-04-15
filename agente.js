const Anthropic = require('@anthropic-ai/sdk');
const { buscarAutos, guardarLead, guardarMensaje, obtenerHistorial } = require('./database');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────
// DEFINICIÓN DE HERRAMIENTAS (lo que el agente puede hacer)
// ─────────────────────────────────────────────

const herramientas = [
  {
    name: 'buscar_autos',
    description: 'Busca autos disponibles en el inventario de Procar. Puede filtrar por presupuesto máximo, tipo de combustible y transmisión.',
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
          description: 'Número de teléfono del cliente.'
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
    name: 'escalar_a_humano',
    description: 'Avisa que el cliente necesita atención de una persona real. Usar cuando el cliente quiere hacer una prueba de manejo, negociar precio, o tiene una consulta compleja.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          description: 'Por qué necesita atención humana.'
        }
      },
      required: ['motivo']
    }
  }
];

// ─────────────────────────────────────────────
// EJECUTAR LA HERRAMIENTA QUE CLAUDE ELIGIÓ
// ─────────────────────────────────────────────

async function ejecutarHerramienta(nombre, input, telefono) {
  console.log(`[Agente] Usando herramienta: ${nombre}`, input);

  if (nombre === 'buscar_autos') {
    const autos = await buscarAutos(input);
    if (autos.length === 0) {
      return 'No encontré autos disponibles con esos criterios en este momento.';
    }
    return autos.map(a =>
      `• ${a.marca} ${a.modelo} ${a.anio} — $${a.precio.toLocaleString()} | ${a.km.toLocaleString()} km | ${a.combustible} | ${a.transmision} | ${a.color}. ${a.descripcion}`
    ).join('\n');
  }

  if (nombre === 'guardar_lead') {
    const resultado = await guardarLead({ ...input, telefono });
    return resultado.mensaje;
  }

  if (nombre === 'escalar_a_humano') {
    return `ESCALAR: ${input.motivo} — Teléfono del cliente: ${telefono}`;
  }

  return 'Herramienta no reconocida.';
}

// ─────────────────────────────────────────────
// FUNCIÓN PRINCIPAL: PROCESAR MENSAJE DEL CLIENTE
// ─────────────────────────────────────────────

async function procesarMensaje(telefono, mensajeUsuario) {
  // Guardar el mensaje del cliente en la base de datos
  await guardarMensaje({ telefono, rol: 'user', contenido: mensajeUsuario });

  // Obtener historial de la conversación
  const historial = await obtenerHistorial(telefono);

  // Construir los mensajes para Claude
  const mensajes = historial.map(m => ({
    role: m.rol,
    content: m.contenido
  }));

  // Llamar a Claude con las herramientas disponibles
  let respuesta = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: `Sos Tito, vendedor de Procar, una agencia de autos usados en Corrientes Capital, Argentina.
Hablás como un correntino: usás "vos", "che", "dale", "bárbaro", "mirá". Sos amable y directo, pero no exagerás ni usás muchos emojis. No te ponés muy efusivo desde el arranque — primero escuchás al cliente, después te vas soltando según cómo fluye la charla.
Sos honesto y conocés bien el inventario. Destacás lo importante de cada auto sin inflar.
Si el cliente menciona su presupuesto o lo que busca, usá la herramienta buscar_autos.
Si el cliente da su nombre o datos personales, usá guardar_lead.
Si el cliente quiere hacer una prueba de manejo, ver el auto o negociar el precio, usá escalar_a_humano.
Respondé siempre en español, de forma natural y sin exagerar la personalidad correntina.`,
    tools: herramientas,
    messages: mensajes
  });

  // Bucle: si Claude quiere usar una herramienta, ejecutarla y continuar
  while (respuesta.stop_reason === 'tool_use') {
    const usoHerramienta = respuesta.content.find(b => b.type === 'tool_use');
    const resultadoHerramienta = await ejecutarHerramienta(
      usoHerramienta.name,
      usoHerramienta.input,
      telefono
    );

    // Continuar la conversación con el resultado de la herramienta
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
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: `Sos Tito, vendedor de Procar, una agencia de autos usados en Corrientes Capital, Argentina.
Hablás como un correntino: usás "vos", "che", "dale", "bárbaro", "mirá". Sos amable y directo, pero no exagerás ni usás muchos emojis. No te ponés muy efusivo desde el arranque — primero escuchás al cliente, después te vas soltando según cómo fluye la charla.
Sos honesto y conocés bien el inventario. Destacás lo importante de cada auto sin inflar.
Si el cliente menciona su presupuesto o lo que busca, usá la herramienta buscar_autos.
Si el cliente da su nombre o datos personales, usá guardar_lead.
Si el cliente quiere hacer una prueba de manejo, ver el auto o negociar el precio, usá escalar_a_humano.
Respondé siempre en español, de forma natural y sin exagerar la personalidad correntina.`,
      tools: herramientas,
      messages: mensajes
    });
  }

  // Extraer el texto final de la respuesta
  const textoRespuesta = respuesta.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Guardar la respuesta del agente en la base de datos
  await guardarMensaje({ telefono, rol: 'assistant', contenido: textoRespuesta });

  return textoRespuesta;
}

module.exports = { procesarMensaje };
