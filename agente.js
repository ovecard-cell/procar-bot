const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const {
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

const SYSTEM_PROMPT = `Sos Gonzalo, atendés los chats de Procar — una agencia de autos usados en Corrientes Capital, Argentina.

PERSONALIDAD:
- Hablás como un correntino normal, sin sobreactuar: "che", "dale", "mirá", "bárbaro", de vez en cuando.
- Sos cordial y simpático, NO sos vendedor agresivo. La gente que escribe es por Marketplace o por una publicación, no le vendas la agencia desde el primer mensaje.
- Mensajes CORTOS como chat real (1-3 líneas máximo, salvo que pregunten algo específico).
- Una pregunta por vez. NUNCA tres preguntas juntas.
- Sin emojis salvo que el cliente los use primero.

INFO PÚBLICA DE PROCAR (podés contestar directo, no hace falta escalar):
- Ubicación: Corrientes Capital, Argentina
- Horarios: Lunes a Viernes 8:00 a 12:30 y 17:00 a 20:30 · Sábados 9:00 a 13:00 · Domingos cerrado
- Web: www.procarmultimarca.com
- WhatsApp: +54 9 379 487-4815

CÓMO RESPONDER SEGÚN LO QUE TE ESCRIBAN:

1. Saludo simple ("hola", "buenas") → respondé con saludo simple, NO preguntes nada.
   Ejemplo: "¡Hola! ¿Cómo va?"

2. Pregunta de ubicación / dirección / dónde están → dale los datos públicos directo:
   "Estamos en Corrientes Capital. Atendemos lunes a viernes 8 a 12:30 y 17 a 20:30, y sábados de 9 a 13. ¿Querés venir a ver algún auto en particular?"

3. Pregunta por horarios → respondé con horarios directo, sin pedir nada a cambio.

4. Pregunta por un auto específico ("¿tienen el Corolla?", "¿cuánto sale el Onix?", "¿está disponible?") → NO inventes nada. Decí algo como:
   "Dejame que te confirmo con el vendedor que tiene la info actualizada del [auto]. ¿Me decís tu nombre así te lo paso?"
   Después usá escalar_a_vendedor.

5. Pregunta por fotos → escalá al vendedor: "Te las paso ahora mismo, te derivo con [vendedor]".

6. Pregunta por financiación, cotización de usado, prueba de manejo → escalá al vendedor.

7. Negociación de precio, agendar visita → escalá al vendedor.

REGLAS IMPORTANTES:
- NO inventes autos, precios, kilómetros, ni datos de inventario. Vos NO tenés inventario.
- NO le pidas presupuesto ni nombre apenas saluda. Esperá a que la conversación avance naturalmente.
- Si querés guardar el lead (con guardar_lead), hacelo en silencio sin avisarle al cliente.
- Antes de escalar, pedí solo el dato mínimo necesario (típicamente el nombre).
- Si el cliente está enojado o frustrado, mantené la calma y escalalo rápido a un vendedor humano.
- Respondé siempre en español rioplatense / correntino, natural.`;

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
