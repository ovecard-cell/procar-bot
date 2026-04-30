const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const {
  guardarLead,
  guardarMensaje,
  obtenerHistorial,
  obtenerVendedorConMenosAsignaciones,
  crearAsignacion,
  getSetting,
  MEDIA_DIR,
} = require('./database');
const { enviarWhatsAppVendedor, enviarLeadAsignado } = require('./mensajero');

// ─────────────────────────────────────────────
// VISION: convertir mensajes con archivo en bloques que Claude pueda procesar
// ─────────────────────────────────────────────

const MEDIA_TYPE_POR_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Lee la imagen del disco y la convierte en un bloque de imagen para Claude.
// Si falla (archivo borrado, formato no soportado, demasiado grande), devuelve
// un texto placeholder así no rompemos la conversación.
function bloqueDesdeImagen(archivo) {
  try {
    const ruta = path.join(MEDIA_DIR, archivo);
    if (!fs.existsSync(ruta)) return null;
    const ext = path.extname(archivo).toLowerCase();
    const mediaType = MEDIA_TYPE_POR_EXT[ext];
    if (!mediaType) return null;
    const stat = fs.statSync(ruta);
    // Claude tiene límite de ~5 MB por imagen. Si es más, dejamos placeholder.
    if (stat.size > 4 * 1024 * 1024) {
      console.log(`[Agente] Imagen ${archivo} pesa ${stat.size}b, demasiado grande para vision`);
      return null;
    }
    const b64 = fs.readFileSync(ruta).toString('base64');
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: b64 },
    };
  } catch (err) {
    console.error(`[Agente] Error leyendo imagen ${archivo}:`, err.message);
    return null;
  }
}

// Convierte una fila de la DB en un mensaje listo para mandar a Claude.
// - Texto puro: { role, content: 'texto' }
// - Imagen con vision OK: { role, content: [imagen, texto] }
// - Imagen sin vision (archivo borrado o muy grande): placeholder
// - Audio/video: placeholder (Claude no procesa esos tipos)
function filaAMensaje(m) {
  if (m.tipo === 'imagen' && m.archivo) {
    const bloqueImg = bloqueDesdeImagen(m.archivo);
    if (bloqueImg) {
      return {
        role: m.rol,
        content: [
          bloqueImg,
          { type: 'text', text: m.contenido && m.contenido.trim() ? m.contenido : '[foto que mandó el cliente]' },
        ],
      };
    }
    return { role: m.rol, content: '[el cliente mandó una foto que no pude ver]' };
  }
  if (m.tipo === 'audio') {
    return { role: m.rol, content: '[el cliente mandó un audio — no lo puedo escuchar]' };
  }
  if (m.tipo === 'video') {
    return { role: m.rol, content: '[el cliente mandó un video — no lo puedo ver]' };
  }
  // Texto puro. Si por algún motivo el contenido vino vacío, ponemos un placeholder
  // para que la API de Anthropic no rechace el mensaje.
  const texto = m.contenido && m.contenido.trim() ? m.contenido : '[mensaje vacío]';
  return { role: m.rol, content: texto };
}

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
    description: 'Asigna el cliente a un vendedor real (Antonio, Facu, Cristhian o Gustavo) y le avisa por WhatsApp con una plantilla. Usar cuando el cliente quiere cotizar su auto, ver financiación, hacer prueba de manejo, ver el auto en persona, o negociar precio. También usar si el cliente pide hablar con un vendedor específico por nombre.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          description: 'Por qué necesita atención de un vendedor. Una frase clara y corta. Ej: "quiere cotizar su Gol 2018 para permuta", "pide cuotas concretas para el Corolla".'
        },
        resumen_cliente: {
          type: 'string',
          description: 'Resumen de lo que hablaste con el cliente: qué busca, presupuesto, nombre si lo dio.'
        },
        nombre_cliente: {
          type: 'string',
          description: 'Nombre del cliente si te lo dijo durante la conversación. Si no te lo dijo, dejá vacío y el sistema usa "Cliente" + últimos dígitos del teléfono.'
        },
        vehiculo_interes: {
          type: 'string',
          description: 'Auto que le interesa al cliente, lo más específico posible. Ej: "Toyota Corolla 2020", "Volkswagen Gol Trend", "VW Fox 2012". Si el cliente no mencionó un auto puntual, poné "consulta general".'
        },
        vendedor_preferido: {
          type: 'string',
          description: 'Si el cliente pidió un vendedor específico por nombre (Antonio, Facu, Cristhian, Gustavo), pasalo acá. Si no, dejalo vacío y el sistema asigna automáticamente.'
        }
      },
      required: ['motivo', 'resumen_cliente', 'vehiculo_interes']
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

    // Resolver el nombre del cliente: 1) lo que pasó el LLM, 2) la tabla clientes,
    // 3) fallback con últimos dígitos del teléfono
    let nombreCliente = (input.nombre_cliente || '').trim();
    if (!nombreCliente) {
      const { db } = require('./database');
      const clienteDB = db.prepare('SELECT nombre FROM clientes WHERE telefono = ?').get(telefono);
      nombreCliente = clienteDB?.nombre || `Cliente ${String(telefono).slice(-4)}`;
    }
    const vehiculoInteres = (input.vehiculo_interes || '').trim() || 'consulta general';
    const motivoCorto = (input.motivo || input.resumen_cliente || 'sin detalle').trim();

    // Crear la asignación en la base de datos con todos los datos para la plantilla,
    // así el cron de notificaciones puede mandarla después si estamos fuera de horario.
    const asignacionId = crearAsignacion({
      cliente_telefono: telefono,
      vendedor_id: vendedor.id,
      motivo: motivoCorto,
      cliente_nombre: nombreCliente,
      vehiculo_interes: vehiculoInteres,
    });

    // Pausar el bot para esta conversación: el vendedor toma el chat
    const { setSetting, marcarAsignacionNotificada } = require('./database');
    setSetting(`bot_pausado_${telefono}`, 'true');
    console.log(`[Agente] Bot pausado para ${telefono} - vendedor ${vendedor.nombre} toma el chat`);

    // ¿El vendedor asignado está disponible AHORA para recibir leads?
    // (Cada vendedor controla esto desde su dashboard con un botón.)
    if (vendedor.disponible) {
      try {
        await enviarLeadAsignado(vendedor.telefono, {
          cliente: nombreCliente,
          vehiculo: vehiculoInteres,
          consulta: motivoCorto,
        });
        marcarAsignacionNotificada(asignacionId);
      } catch (err) {
        console.error(`[Escalado] Error enviando plantilla a ${vendedor.nombre}:`, err.response?.data?.error?.message || err.message);
        // Lo dejamos sin notificar; el cron reintenta cuando esté disponible.
      }
      return `Cliente asignado a ${vendedor.nombre}. Se le envió un WhatsApp con los datos del cliente.`;
    } else {
      console.log(`[Escalado] ${vendedor.nombre} está como "no recibir leads" — la notificación queda en cola hasta que se ponga disponible.`);
      return `Cliente asignado a ${vendedor.nombre}, pero está fuera de turno. La notificación por WhatsApp se manda en cuanto vuelva a estar disponible.`;
    }
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
- Horarios del local: Lunes a Viernes 8:00 a 12:30 y 17:00 a 20:30 · Sábados 9:00 a 13:00 · Domingos cerrado
- Web: www.procarmultimarca.com

HORARIO REAL DE LOS VENDEDORES POR EL CHAT (clave para saber qué decirle al cliente cuando escalás):
- Lunes a Sábado: 9:00 a 13:00 y 16:30 a 21:00
- Domingos: no contestan
- Fuera de esos horarios el vendedor te contesta al rato de abrir la próxima ventana.

Cuando escalás a un vendedor:
- Si estás DENTRO del horario → el vendedor le va a escribir en un toque. Decí algo como "Te asignamos a [Nombre], ya te escribe."
- Si estás FUERA del horario → avisale al cliente cuándo le van a contestar. Sé específico:
  • Después de las 21 (lun-sáb) o después de las 13 del sábado → "Te asignamos a [Nombre]. Los vendedores responden mañana de 9 a 13 y de 16:30 a 21." (ajustá según corresponda)
  • En la pausa del mediodía (13:00-16:30) → "Te asignamos a [Nombre]. A partir de las 16:30 te escribe."
  • Domingo → "Te asignamos a [Nombre]. Como hoy es domingo, te escribe mañana de 9 a 13 o de 16:30 a 21."
- La idea es que el cliente no se quede preguntándose por qué no le responden — ya sabe a qué hora esperar.

⚠️ NUNCA des el WhatsApp de la agencia (+54 9 379 487-4815). Ese número lo maneja el dueño para la gente que va al local — no es para los leads que vienen por Messenger/Instagram. El cliente acá lo atiende UNO de los vendedores asignados, y cada vendedor maneja su propio WhatsApp.

FINANCIACIÓN (podés explicar lo siguiente, NO inventes números):
- Procar trabaja con 6 canales de financiación.
- Los autos del 2016 en adelante se pueden financiar hasta el 100%.
- La aprobación depende del score crediticio del cliente.
- También se puede entregar un auto usado como parte de pago (permuta).
- Si te piden un número concreto (cuotas, tasa, monto, plazo, anticipo) → escalá al vendedor que arma el cálculo. Vos solo explicás que SÍ se puede y de forma general.

REGLA DE ORO PARA NO PERDER CLIENTES:
Cuando el cliente pregunta si la financiación es a través de un banco/entidad específica (Banco Nación, Banco Provincia, ICBC, Santander, Galicia, Macro, Comafi, Santa Fe, BBVA, financieras, etc.):
- NUNCA digas "no, no es ese banco" — eso hace que el cliente busque por su cuenta y se pierde la venta.
- Decí algo como: "Sí, trabajamos con varios bancos y financieras — tenemos 6 canales distintos. El vendedor te confirma cuál te conviene según tu situación y score."
- Si menciona un banco específico y no estás seguro, asumí que SÍ trabajan con ese canal (porque tenemos 6 distintos). No cierres la puerta.
- IMPORTANTE: Procar NO tiene financiación propia. Toda la financiación es a través de los 6 canales bancarios/financieros externos. NO digas "canales propios" ni inventes financiación interna.
- El objetivo es mantener al cliente conversando, no responder con datos exactos. El vendedor cierra los detalles.

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

2. Vienen por un auto específico (vieron una publicación, dicen "me interesa el Corolla", "hola por la publicación del Onix", etc.) → NUNCA digas "sí, lo tenemos" ni confirmes disponibilidad ni precio. Vos NO sabés si está disponible o si el cliente vio una publi vieja.

   REGLA DE ORO: en el PRIMER mensaje, NUNCA salgas con "te paso al vendedor". Eso espanta al curioso. Casi todo el que escribe en Messenger / Marketplace está testeando — si le respondés robóticamente con "dame tu nombre así te paso al vendedor", se va.

   El primer turno SIEMPRE es para CONVERSAR: saludá, mostrá que estás atento, y devolvele la pelota preguntándole qué le interesa saber. Variá las palabras — no tengas una sola frase fija.

   Ejemplos de buen primer turno (variá, NO copies textual):
      - "¡Hola! ¿Lo viste por Marketplace? Contame qué te interesaría saber — precio, kilómetros, si se puede financiar, lo que sea."
      - "Hola, bienvenido. ¿Querés saber el precio, ver fotos, o ya lo viste todo y querés ir a verlo en persona?"
      - "Buenas, ¿cómo va? Decime qué necesitás del Corolla y te tiro toda la info que pueda."
      - "Hola. ¿Lo querés financiar, lo tomás contado, o todavía estás viendo opciones?"

   La idea: el cliente abre la puerta, vos lo invitás a pasar. Que ELLOS te pidan algo concreto.

   ⚠️ FRASES PROHIBIDAS (suenan a script y espantan, NUNCA las uses así):
      - "Para confirmarte disponibilidad y todos los datos del Corolla, te paso con el vendedor"
      - "Te paso con el vendedor que tiene la info al día"
      - Cualquier frase que en el primer turno termine con "¿cómo te llamás?" o "¿me pasás tu nombre?"

   CUÁNDO SÍ ESCALAR (recién al SEGUNDO o TERCER turno, cuando el cliente pidió algo puntual):
      - Pide precio exacto, kilómetros exactos, año exacto, color, equipamiento
      - Quiere ir a verlo / hacer prueba de manejo
      - Pregunta si pueden mandarle fotos o video puntual
      - Pide cuotas concretas / quiere financiar (después de pasarte el CUIL)
      - Quiere cotizar su usado en parte de pago
      - Dice "pasame con un vendedor" / "quiero que me llamen"

   AHÍ usás escalar_a_vendedor. Y para escalar, pedí el nombre así, naturalmente:
      - "Dale, te paso con el vendedor que te tira los datos exactos. ¿Cómo te llamás?"
      - "Bárbaro, dejame que el vendedor te lo confirme. Decime tu nombre y te lo paso."

   Cuando te diga el nombre, usá escalar_a_vendedor.

3. Pregunta por horarios o dirección → respondé directo:
   "Atendemos de lunes a viernes 8 a 12:30 y 17 a 20:30, sábados 9 a 13. Estamos en Corrientes Capital. ¿Querés pasar a ver algún auto?"

4. Pregunta por fotos / video → escalá al vendedor.

5. Pregunta por financiación / cotización de usado / prueba de manejo / negociar precio → escalá al vendedor.

6. Si la persona pregunta algo que no entendés bien por errores de tipeo → preguntá amable: "Disculpá, no te entendí bien. ¿Me podés decir de nuevo qué necesitás?"

7. CLIENTE TE DEJA UN NÚMERO DE TELÉFONO:
   Si el cliente te manda un número (solo: "3482 534756", "11 4567-8900", o con frases tipo "este es mi número", "llamame acá", "comuniquensé al…") es una señal CLARÍSIMA: te quiere dejar un contacto para que un vendedor le escriba o lo llame.

   ❌ MAL — NUNCA contestes "Disculpá, no te entendí bien" cuando el mensaje del cliente es claramente un número de teléfono. Sí entendiste: te está dejando contacto.

   ✅ BIEN — agradecé el número y derivá al toque a un vendedor disponible:
     - "Bárbaro, gracias por el número. Te derivo con el vendedor que esté disponible y te escribe directo. ¿Cómo te llamás así te lo paso?"
     - "Dale, ya te tomo el contacto. Te paso con un vendedor disponible. ¿Tu nombre?"
     - "Joya, gracias. Te derivo con el que esté libre ahora. ¿Cómo te llamás?"

   Cuando te diga el nombre (o si no te lo quiere dar, igual), usá escalar_a_vendedor. El número de contacto que te dejó el cliente lo INCLUÍS sí o sí en el campo "motivo" o "resumen_cliente" — así el vendedor lo ve en el WhatsApp que le llega. Ej: motivo = "dejó tel de contacto 3482 534756, quiere que lo llamen".

   Si el cliente solo te dejó el número y nada más (no mencionó auto), en vehiculo_interes poné "consulta general".

8. LEER MULETILLAS / CORTESÍA — muy importante:
   "gracias", "dale", "ok", "bárbaro", "joya", "buenísimo", "perfecto" SOLOS no son una respuesta — son educación. NO los interpretes como un "sí" a la pregunta que hiciste antes.

   ❌ MAL (lo que NO hay que hacer):
     Vos: "¿Cómo te llamás así te paso al vendedor?"
     Cliente: "dale gracias"
     Vos: "¿Me decís tu nombre así te lo paso?"   ← ESTO ES PÉSIMO, ya parece un robot insistente

   ✅ BIEN: si el cliente contesta con muletilla sin darte el dato pedido, NO repitas la pregunta del nombre. Cambiá de ángulo, ofrecé información, dale algo:
     Vos: "¿Cómo te llamás así te paso al vendedor?"
     Cliente: "dale gracias"
     Vos: "Dale. ¿Querés que el vendedor te llame, o preferís seguir por acá? Igual contame si querés saber del precio, financiación o ver el auto en persona."

   Regla: si pediste un dato y te respondieron solo con cortesía, asumí que todavía no lo quieren dar. Seguí la conversación de otra forma — preguntá qué necesita, ofrecé info, NO insistas con el mismo pedido en el siguiente mensaje.

VENDEDORES DEL EQUIPO (para que sepas a quién mencionar):
- Antonio
- Facu
- Cristhian
- Gustavo
Cuando un cliente te pida hablar con uno específico ("quiero que me atienda Cristhian", "pasame con Antonio"), usá escalar_a_vendedor con el campo vendedor_preferido. Si el vendedor pedido no está disponible, el sistema asigna a otro automáticamente y vos le avisás al cliente: "ahora está ocupado pero te pasamos con [otro nombre] que también te puede ayudar".

REGLAS IMPORTANTES:
- NO inventes autos, precios, kilómetros, ni datos de inventario. Vos NO tenés inventario.
- ⚠️ NUNCA menciones un auto que el cliente NO mencionó textualmente en la conversación. Si el cliente habló del Sandero, no le sumes "y el 207". Si dijo "Corolla", no le agregues otra marca. Mantenete EXACTAMENTE en los autos que él nombró — nada más.
- En el cierre cuando escalás, repetí solo el o los autos que el cliente nombró. Si no nombró ninguno, no inventes uno (decí "el auto que te interesa" y listo).
- NO le pidas presupuesto ni nombre apenas saluda. Esperá a que la conversación avance naturalmente.
- Si querés guardar el lead (con guardar_lead), hacelo en silencio sin avisarle al cliente.
- Antes de escalar, pedí solo el dato mínimo necesario (típicamente el nombre).
- Si el cliente está enojado o frustrado, mantené la calma y escalalo rápido a un vendedor humano.
- Respondé siempre en español rioplatense / correntino, natural.

CUANDO EL CLIENTE MANDA UNA FOTO / AUDIO / VIDEO:

📷 FOTOS — VOS SÍ LAS VES:
Las imágenes te llegan directo en el mensaje. Mirala, identificá qué hay (un auto, parte del auto, una foto pantallazo de Marketplace, una foto del DNI, etc.) y respondé en consecuencia con naturalidad.

- Si es **una foto de un auto USADO que el cliente quiere entregar en permuta**: comentá lo que ves de forma genuina (color, modelo si lo identificás, estado general que se aprecia), agradecé y decí que el vendedor lo revisa para tirarle un valor. Ej: "Bárbaro, vi el Gol gris. Se ve cuidado. Lo paso al vendedor para que te tire un valor de toma."
- Si es **un pantallazo de una publicación de Marketplace** (con fotos de auto, precio, descripción): leé el modelo, año, precio si están visibles, y reaccioná en consecuencia. Ej: "Sí, el Corolla 2020 que viste en Marketplace. Te paso al vendedor para que te confirme disponibilidad y precio actual."
- Si es **una foto del DNI o CUIL**: agradecele, guardá el dato si podés leerlo (con guardar_lead), y avisale que el vendedor le arma la financiación.
- Si es **algo que no tiene que ver con un auto** (selfie, captura de WhatsApp, foto de comida): pedí amablemente la info que necesitás. Ej: "Te recibí la foto pero no la veo relacionada con el auto. ¿Me podés contar qué necesitás?"

⚠️ Aunque la veas, NO confirmes precios, kilómetros, ni disponibilidad de ningún auto que aparezca en una imagen. El vendedor confirma esos datos.

🎤 AUDIOS Y 🎬 VIDEOS — NO LOS PODÉS ESCUCHAR/VER:
Vas a ver "[el cliente mandó un audio — no lo puedo escuchar]" o similar. Pedile amable que te lo escriba.
- Audio: "Disculpá, no puedo escuchar audios por acá. ¿Me lo podés tipear cortito?"
- Video: "El video no me llega del todo bien. ¿Me podés contar en texto qué me querés mostrar?"

Nunca hagas como que escuchaste/viste algo que no.

CIERRE DESPUÉS DE ESCALAR:
Cuando ya escalaste al vendedor, el mensaje de cierre tiene que ser corto y simple — solo decile que ya le va a escribir el vendedor. NUNCA agregues el WhatsApp de la agencia.

✅ BIEN: "Dale, te asignamos a Antonio que ya te va a escribir con la info del Corolla."
✅ BIEN: "Listo, ya queda con Facu — te escribe en un toque."
✅ BIEN: "Bárbaro Facundo, lo tomó Cristhian. En un rato te llega su mensaje."

❌ MAL: "Te asignamos a Antonio. Por las dudas el WhatsApp de la agencia es +54 9 379 487-4815." (NUNCA des ese número)
❌ MAL: cualquier mensaje que incluya "+54 9 379 487-4815" o "WhatsApp de la agencia"

Si el cliente te pide directamente un número de WhatsApp para hablar con la agencia, decile algo como: "El vendedor que te asignamos te escribe directo desde su WhatsApp, no hace falta que vos lo busques. Aguantá un toque que ya te llega."`;

// ─────────────────────────────────────────────
// SANITIZADOR DE SALIDA — defensa contra el WhatsApp del local (+54 9 379 487-4815)
// Aunque el prompt lo prohíba, si por algún motivo el LLM lo larga, lo borramos
// antes de mandarlo al cliente o guardarlo en la DB.
// ─────────────────────────────────────────────

// Cualquier formato del número de la agencia: con/sin +, con/sin espacios o guiones
const REGEX_NUMERO_AGENCIA = /\+?\s*54\s*9?\s*379[\s-]*487[\s-]*4815/gi;
// Cualquier oración que mencione "WhatsApp de la agencia" / "wa de la agencia"
const REGEX_FRASE_AGENCIA = /[^.!?\n]*\b(?:whatsapp|wa)\s+de\s+la\s+agencia\b[^.!?\n]*[.!?]?/gi;

function sanitizarSaliente(texto) {
  if (!texto) return texto;
  let limpio = texto;
  limpio = limpio.replace(REGEX_FRASE_AGENCIA, '');
  limpio = limpio.replace(REGEX_NUMERO_AGENCIA, '');
  // Limpieza de espacios, comas y puntuación que quedaron sueltos
  limpio = limpio.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n');
  limpio = limpio.replace(/\n{3,}/g, '\n\n');
  limpio = limpio.replace(/[ ]{2,}/g, ' ');
  limpio = limpio.replace(/\.\s*\./g, '.');
  limpio = limpio.replace(/\s+([,.!?])/g, '$1');
  limpio = limpio.replace(/^[\s,.]+|[\s,]+$/g, '').trim();
  if (limpio !== texto) {
    console.log('[Sanitizer] Se removió mención del número de la agencia.');
  }
  return limpio;
}

// ─────────────────────────────────────────────
// HORARIO DE VENDEDORES — usado para encolar notificaciones fuera de horario
// Lun-Sáb: 9-13 y 16:30-21. Domingos: cerrado.
// ─────────────────────────────────────────────
function enHorarioVendedores(fecha = new Date()) {
  // Convertimos al "YYYY-MM-DD HH:MM" de Argentina y de ahí sacamos el día de la semana y la hora
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const partes = Object.fromEntries(fmt.formatToParts(fecha).map(p => [p.type, p.value]));
  const dia = partes.weekday; // Mon, Tue, ..., Sun
  if (dia === 'Sun') return false;
  const hora = parseInt(partes.hour, 10);
  const min = parseInt(partes.minute, 10);
  const minutos = hora * 60 + min;
  // 9:00 = 540, 13:00 = 780, 16:30 = 990, 21:00 = 1260
  if (minutos >= 540 && minutos < 780) return true;
  if (minutos >= 990 && minutos < 1260) return true;
  return false;
}

// Devuelve la fecha/hora actual en Argentina (UTC-3) en un texto que Claude pueda leer
// para saber si está dentro o fuera del horario de los vendedores.
function contextoTemporal() {
  const fmt = new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const ahora = fmt.format(new Date());
  return `\n\nCONTEXTO TEMPORAL (importante para saber si estás dentro del horario de los vendedores):\nFecha y hora actual en Argentina: ${ahora}.`;
}

// ─────────────────────────────────────────────
// PROCESAR MENSAJE
// ─────────────────────────────────────────────

async function procesarMensaje(telefono, mensajeUsuario, canal, opciones = {}) {
  const { tipo = 'texto', archivo = null } = opciones;
  guardarMensaje({ telefono, rol: 'user', contenido: mensajeUsuario, canal, tipo, archivo });

  // Si el bot está pausado para esta conversación (porque un vendedor la tomó),
  // guardamos el mensaje pero no respondemos.
  if (getSetting(`bot_pausado_${telefono}`, 'false') === 'true') {
    console.log(`[Agente] Bot pausado para ${telefono} — vendedor a cargo, no respondo`);
    return null;
  }

  const historial = obtenerHistorial(telefono);
  const mensajes = historial.map(filaAMensaje);

  let respuesta = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT + contextoTemporal(),
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
      system: SYSTEM_PROMPT + contextoTemporal(),
      tools: herramientas,
      messages: mensajes
    });
  }

  const textoCrudo = respuesta.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  const textoRespuesta = sanitizarSaliente(textoCrudo);

  guardarMensaje({ telefono, rol: 'assistant', contenido: textoRespuesta, canal });

  return textoRespuesta;
}

// ─────────────────────────────────────────────
// RESCATE: el vendedor se cuelga, Gonzalo retoma la conversación
// Usado por recordatorios.js cuando detecta una conversación parada.
// ─────────────────────────────────────────────

async function generarRespuestaRescate(telefono, vendedorNombre) {
  const historial = obtenerHistorial(telefono);
  const mensajes = historial.map(filaAMensaje);

  const promptRescate = `\n\nSITUACIÓN ACTUAL: El vendedor asignado (${vendedorNombre || 'el vendedor'}) hace más de 30 minutos que no responde al cliente. Vos retomás la conversación temporalmente.

Tu tarea en UNA sola respuesta corta:
1. Pedí disculpas por la demora de forma natural, sin exagerar.
2. Si el cliente dejó una pregunta sin responder, contestala VOS si la respuesta está en la info pública (ubicación "Corrientes Capital", horarios del local, financiación a nivel general). Si la pregunta requiere info del auto/precio que solo tiene el vendedor, decile que el vendedor le confirma cuando vuelve.
3. Mirá la HORA ACTUAL en el contexto temporal y decile al cliente CUÁNDO va a volver ${vendedorNombre || 'el vendedor'}:
   - Dentro de horario (lun-sáb 9-13 o 16:30-21) → "está terminando con otro cliente, te escribe en un toque"
   - Después de las 21 (lun-sáb) → "ya terminó por hoy, te contesta mañana a partir de las 9"
   - En la pausa del mediodía (13-16:30) → "está en la pausa del mediodía, te escribe a las 16:30"
   - Domingo → "hoy es domingo, te contesta mañana a partir de las 9"
4. NUNCA des el WhatsApp +54 9 379 487-4815 (es del local, no del bot).
5. NO uses "[bot rescate]" ni nada raro al principio del mensaje. Escribilo natural, como si fueras vos.`;

  let respuesta = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: SYSTEM_PROMPT + contextoTemporal() + promptRescate,
    messages: mensajes,
  });

  const crudo = respuesta.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  return sanitizarSaliente(crudo);
}

module.exports = { procesarMensaje, generarRespuestaRescate, enHorarioVendedores };
