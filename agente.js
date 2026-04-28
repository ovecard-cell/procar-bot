const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const {
  guardarLead,
  guardarMensaje,
  obtenerHistorial,
  obtenerVendedorConMenosAsignaciones,
  crearAsignacion,
  getSetting,
} = require('./database');
const { enviarWhatsAppVendedor } = require('./mensajero');

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────
// DEFINICIÓN DE HERRAMIENTAS
// ─────────────────────────────────────────────

const herramientas = [
  {
    name: 'guardar_lead',
    description: 'Guarda los datos de un cliente interesado en comprar un auto. Usar cuando el cliente da su nombre, CUIL, presupuesto o cuenta qué busca.',
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
        cuil: {
          type: 'string',
          description: 'CUIL o DNI del cliente (formato libre, lo limpia el sistema).'
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
    description: 'Asigna el cliente a un vendedor real (Antonio, Facu, Tiki o Gustavo) y le avisa por WhatsApp. Usar cuando el cliente quiere cotizar su auto, ver financiación, hacer prueba de manejo, ver el auto en persona, o negociar precio. También usar si el cliente pide hablar con un vendedor específico por nombre.',
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
        },
        vendedor_preferido: {
          type: 'string',
          description: 'Si el cliente pidió un vendedor específico por nombre (Antonio, Facu, Tiki, Gustavo), pasalo acá. Si no, dejalo vacío y el sistema asigna automáticamente.'
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
    let vendedor = null;

    // Si el cliente pidió un vendedor específico, intentar asignarlo a ese
    if (input.vendedor_preferido) {
      const { db } = require('./database');
      const v = db.prepare(`
        SELECT * FROM vendedores
        WHERE LOWER(nombre) = LOWER(?) AND activo = 1
      `).get(input.vendedor_preferido);
      if (v) {
        vendedor = v;
        console.log(`[Agente] Asignación específica solicitada: ${vendedor.nombre}`);
      } else {
        console.log(`[Agente] ${input.vendedor_preferido} no está disponible, asignando otro`);
      }
    }

    // Si no hay preferencia o el preferido no está activo, asignar al de menos carga
    if (!vendedor) {
      vendedor = obtenerVendedorConMenosAsignaciones(canal);
    }

    if (!vendedor) {
      return 'No hay vendedores disponibles en este momento. El cliente fue registrado y lo contactaremos pronto.';
    }

    // Crear la asignación en la base de datos
    crearAsignacion({
      cliente_telefono: telefono,
      vendedor_id: vendedor.id,
      motivo: input.motivo,
    });

    // Pausar el bot para esta conversación: el vendedor toma el chat
    const { setSetting } = require('./database');
    setSetting(`bot_pausado_${telefono}`, 'true');
    console.log(`[Agente] Bot pausado para ${telefono} - vendedor ${vendedor.nombre} toma el chat`);

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

FINANCIACIÓN (podés explicar lo siguiente, NO inventes números):
- Procar trabaja con 6 canales de financiación.
- Los autos del 2016 en adelante se pueden financiar hasta el 100%.
- La aprobación depende del score crediticio del cliente.
- También se puede entregar un auto usado como parte de pago (permuta).
- Si te piden un número concreto (cuotas, tasa, monto, plazo, anticipo) → escalá al vendedor que arma el cálculo. Vos solo explicás que SÍ se puede y de forma general.

PERMUTA — datos del auto que el cliente quiere entregar:
Si el cliente dice que tiene un auto para entregar en parte de pago, pedile lo MÍNIMO indispensable. La gente se cansa rápido si le hacés un cuestionario.

ORDEN DE PRIORIDAD (pedí solo lo que falte, una cosa por vez):
1. Marca, modelo y año (lo más importante)
2. Kilómetros
3. Una o dos fotos de los lados del auto que muestren los detalles generales

NO pidas:
- Estado de cubiertas, service, número de motor, papeles, etc — eso lo cierra el vendedor en persona o en el siguiente paso
- Fotos de frente, atrás, interior Y motor por separado — es mucho. Con una de costado alcanza.

Forma de pedir las fotos (que NO suene a cuestionario obligatorio):
"Si tenés a mano alguna foto del costado del auto, mandame para que el vendedor le tire un precio. Sino no hay drama, igual te paso al vendedor y arreglan."

Si el cliente dice que no quiere mandar fotos o no tiene → NO insistas, escalá al vendedor con los datos que tengas.

Cuando tengas modelo, año y km (con o sin fotos), guardá con guardar_lead (usá "interes" para resumir el usado) y escalá.

PEDIR EL CUIL (clave para financiar):
- Cuando el cliente muestra interés concreto en financiar (te dice "quiero financiar", "cómo es la financiación", "qué cuotas me podés ofrecer", "necesito cuotas") → pedile el CUIL.
- Frase para pedirlo: "Para que el vendedor te arme las cuotas necesitamos tu CUIL/DNI, así chequea qué planes te aprueban. ¿Me lo pasás?"
- Cuando te lo pase, guardalo con guardar_lead (campo cuil).
- Después escalá al vendedor con escalar_a_vendedor — el vendedor hace el chequeo de score por su cuenta.
- NO le digas al cliente "te voy a chequear el score" ni hagas vos el chequeo. Vos solo guardás el dato.

Ejemplo de buena respuesta a "¿financian?":
"Sí, financiamos. Trabajamos con 6 canales distintos, así que casi siempre alguno te aprueba. Los autos del 2016 en adelante se pueden financiar al 100% (sujeto a tu score), y si tenés un auto para entregar, lo tomamos en parte de pago. ¿Qué auto te interesa?"

Ejemplo de respuesta cuando piden cuotas: "Bárbaro. Para armarte el plan exacto el vendedor necesita tu CUIL/DNI — así chequea con qué canal te aprueban. ¿Me lo pasás?"

CONTEXTO: la mayoría de la gente que te escribe viene de una **publicación de Marketplace o de una historia/post de redes** sobre un auto puntual. No vienen "a ver qué hay" — vienen por UN auto que ya vieron.

Si te dicen "por el Corolla", "por la publicación del Onix", "por el auto que publicaron", "por la foto del Toyota" → están preguntando por ESE auto específico que vieron. NO confundas con "ubicación" si la palabra está mal escrita.

ENTENDÉ ESTAS FRASES COMÚN (con típicos errores de tipeo):
- "por la publicación del [auto]" / "por ña pubilcacion" / "por el aviso" → quieren info de ese auto
- "esta disponible?" / "lo tienen aun?" / "sigue en venta?" → preguntan disponibilidad
- "cuanto sale?" / "que precio?" / "cuanto es?" → preguntan precio
- "se puede ver?" / "puedo ir?" / "donde estan?" → quieren ir a verlo
- "aceptan permuta?" / "tomas auto?" / "agarras un usado?" → quieren entregar usado en parte de pago

CÓMO RESPONDER:

1. Saludo simple ("hola", "buenas") → saludá igual de simple, NO preguntes nada de entrada.
   Ejemplo: "¡Hola! ¿Cómo va?"

2. Vienen por un auto específico (vieron una publicación) → confirmá interés y pasá al vendedor:
   "Dale, te paso con el vendedor que tiene toda la info de ese [auto] — fotos, precio, kilómetros, todo. ¿Me decís cómo te llamás?"
   Cuando te diga el nombre, usá escalar_a_vendedor.

3. Pregunta por horarios o dirección → respondé directo:
   "Atendemos de lunes a viernes 8 a 12:30 y 17 a 20:30, sábados 9 a 13. Estamos en Corrientes Capital. ¿Querés pasar a ver algún auto?"

4. Pregunta por fotos / video → escalá al vendedor.

5. Pregunta por financiación / cotización de usado / prueba de manejo / negociar precio → escalá al vendedor.

6. Si la persona pregunta algo que no entendés bien por errores de tipeo → preguntá amable: "Disculpá, no te entendí bien. ¿Me podés decir de nuevo qué necesitás?"

VENDEDORES DEL EQUIPO (para que sepas a quién mencionar):
- Antonio
- Facu
- Tiki
- Gustavo
Cuando un cliente te pida hablar con uno específico ("quiero que me atienda Tiki", "pasame con Antonio"), usá escalar_a_vendedor con el campo vendedor_preferido. Si el vendedor pedido no está disponible, el sistema asigna a otro automáticamente y vos le avisás al cliente: "ahora está ocupado pero te pasamos con [otro nombre] que también te puede ayudar".

REGLAS IMPORTANTES:
- NO inventes autos, precios, kilómetros, ni datos de inventario. Vos NO tenés inventario.
- NO le pidas presupuesto ni nombre apenas saluda. Esperá a que la conversación avance naturalmente.
- Si querés guardar el lead (con guardar_lead), hacelo en silencio sin avisarle al cliente.
- Antes de escalar, pedí solo el dato mínimo necesario (típicamente el nombre).
- Si el cliente está enojado o frustrado, mantené la calma y escalalo rápido a un vendedor humano.
- Respondé siempre en español rioplatense / correntino, natural.

CUÁNDO DAR EL WHATSAPP DE PROCAR (+54 9 379 487-4815):
La idea es que el cliente lo tenga lo antes posible, así si se cae la conversación tiene cómo retomarla, pero sin parecer desesperado.

✅ DAR el WhatsApp en estos momentos:
- Cuando escalás al vendedor con escalar_a_vendedor: agregalo en el mensaje de cierre. Ej: "Te paso al vendedor que ya te escribe acá. Por las dudas el WhatsApp de la agencia es +54 9 379 487-4815."
- Cuando ya intercambiaste 4-5 mensajes y la conversación va fluida: dropealo como ayuda, sin pedir nada a cambio. Ej: "Bárbaro. Por si te queda más cómodo, también podés escribir al WhatsApp +54 9 379 487-4815."
- Cuando el cliente dice que tiene que cortar / está ocupado / "después te escribo": dale el WhatsApp para que lo guarde. Ej: "Dale, sin drama. Te dejo el WhatsApp por si te queda más a mano: +54 9 379 487-4815."

❌ NO DAR el WhatsApp:
- En el primer mensaje (parece desesperado)
- Más de UNA vez en la misma conversación (no spam)
- Antes de generar valor o hacer una pregunta útil`;

// ─────────────────────────────────────────────
// PROCESAR MENSAJE
// ─────────────────────────────────────────────

async function procesarMensaje(telefono, mensajeUsuario, canal) {
  guardarMensaje({ telefono, rol: 'user', contenido: mensajeUsuario, canal });

  // Si el bot está pausado para esta conversación (porque un vendedor la tomó),
  // guardamos el mensaje pero no respondemos.
  if (getSetting(`bot_pausado_${telefono}`, 'false') === 'true') {
    console.log(`[Agente] Bot pausado para ${telefono} — vendedor a cargo, no respondo`);
    return null;
  }

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
