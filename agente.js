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
  obtenerEstadoConversacion,
  actualizarEstadoConversacion,
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
    name: 'buscar_inventario',
    description: 'Busca autos en el inventario actual de Procar por marca y/o modelo, y opcionalmente año. Usar SIEMPRE antes de afirmar disponibilidad o de mandar fotos. IMPORTANTE: en el modelo pasá SOLO el nombre base SIN año, SIN versión, SIN trim, SIN km — el año va aparte en el campo "anio". La búsqueda hace LIKE %modelo%, así que pasar "Amarok 2017" no matchea con "Amarok 4X2 2.0L TDI"; pasar modelo="Amarok" + anio=2017 sí. Los resultados vienen ordenados por cercanía al año pedido. Cada resultado va con un flag "match_anio" para que sepas si es el año exacto que pidió el cliente o uno cercano.',
    input_schema: {
      type: 'object',
      properties: {
        marca: { type: 'string', description: 'Marca del auto (ej: Volkswagen, Toyota, Fiat). Opcional.' },
        modelo: { type: 'string', description: 'SOLO el nombre base del modelo, SIN año, SIN versión, SIN km. Ej: "Amarok" (NO "Amarok 2017"), "Gol Trend" (NO "Gol Trend 2018 80mil"), "Corolla" (NO "Corolla XEI 2024").' },
        anio: { type: 'integer', description: 'Año específico que pidió el cliente. Solo pasalo si el cliente lo nombró explícito ("Amarok 2017", "Corolla 2020"). Si no lo dijo, dejalo vacío.' },
      },
    },
  },
  {
    name: 'enviar_fotos_auto',
    description: 'Manda al cliente las fotos de un auto del inventario por el mismo canal donde está chateando (WhatsApp/Instagram/Messenger). Usar después de buscar_inventario, cuando el cliente quiere ver el auto o vos le dijiste "te paso fotos". Manda hasta 4 fotos. CRÍTICO: si pasás "anio" y NO existe ese año exacto en stock, la herramienta NO manda fotos — devuelve los años disponibles para que vos avises al cliente ANTES de mandar fotos de otro año. NO te saltees ese aviso.',
    input_schema: {
      type: 'object',
      properties: {
        marca: { type: 'string', description: 'Marca del auto (ej: Toyota, Volkswagen). Opcional.' },
        modelo: { type: 'string', description: 'Modelo (ej: Corolla XEI, Gol Trend). Pasá lo más específico posible. Requerido.' },
        anio: { type: 'integer', description: 'Año específico que pidió el cliente. Si lo nombró explícito, pasalo — la herramienta NO manda fotos si ese año no existe en stock, te avisa qué años hay para que se lo digas al cliente.' },
      },
      required: ['modelo'],
    },
  },
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
        },
        whatsapp_cliente: {
          type: 'string',
          description: 'Número de WhatsApp del cliente, OBLIGATORIO cuando el canal es "web" (porque el id del cliente web es anónimo y el vendedor no tiene cómo escribirle sin esto). Para otros canales (whatsapp, messenger, instagram) dejalo vacío — el sender_id ya es el contacto real.'
        }
      },
      required: ['motivo', 'resumen_cliente', 'vehiculo_interes']
    }
  },
  {
    name: 'actualizar_estado_conversacion',
    description: `Actualiza el estado estructurado de la conversación. Llamala SIEMPRE que aprendas algo nuevo del cliente: qué auto QUIERE COMPRAR, qué auto TIENE para entregar en permuta, cómo va a pagar, su nombre. El estado se persiste en la DB y vos lo ves en cada turno bajo "ESTADO DE LA CONVERSACIÓN" del system message.

CRÍTICO — distinguir auto_interes vs auto_permuta:
- auto_interes = lo que el cliente QUIERE COMPRAR. Pistas: viene del anuncio que respondió, dice "me interesa el X", "tenés Y?", "quiero el Z", "estoy buscando un W", "por la publicación del N".
- auto_permuta = lo que el cliente TIENE y quiere entregar. Pistas: "tengo un X", "mi X", "el X que tengo", "te entrego mi X", "X en parte de pago", "dejo mi Y".

REGLA DURA: si el cliente dice "tengo un Corolla", Corolla va a auto_permuta. NUNCA a auto_interes. Aunque suene parecido al auto del anuncio, "tengo" siempre marca permuta.

Podés llamarla varias veces a lo largo de la charla — cada llamada actualiza solo los campos que pasás (los demás se mantienen).`,
    input_schema: {
      type: 'object',
      properties: {
        auto_interes: {
          type: 'object',
          description: 'El auto que el cliente quiere COMPRAR. Solo poblar si el texto del cliente lo identifica claramente como auto que pide o de un anuncio. NUNCA usar para autos que el cliente "tiene".',
          properties: {
            marca: { type: 'string', description: 'ej: Toyota, Volkswagen, Fiat' },
            modelo: { type: 'string', description: 'ej: Corolla, Gol Trend, Cronos' },
            anio: { type: 'integer', description: 'año si lo dijo el cliente, ej: 2020' },
          },
        },
        auto_permuta: {
          type: 'object',
          description: 'El auto que el cliente TIENE y quiere entregar como parte de pago. Solo poblar si el texto incluye "tengo", "mi auto", "te dejo el", "te entrego", "permuto", "X en parte de pago".',
          properties: {
            marca: { type: 'string' },
            modelo: { type: 'string' },
            anio: { type: 'integer' },
            km: { type: 'integer', description: 'kilómetros si los dijo' },
            estado: { type: 'string', description: 'estado general que mencionó: "impecable", "andando", "le anda bien", etc.' },
          },
        },
        forma_pago: {
          type: 'string',
          enum: ['contado', 'financiado', 'permuta', 'mixto'],
          description: 'contado=todo en efectivo. financiado=quiere cuotas. permuta=solo entrega usado. mixto=combina (típico permuta+financiado).',
        },
        nombre_cliente: {
          type: 'string',
          description: 'Nombre del cliente cuando te lo dijo. Solo el primer nombre o nombre completo, sin saludos ni adornos.',
        },
        etapa: {
          type: 'string',
          enum: ['prospecto', 'calificando', 'calificado', 'derivado'],
          description: 'prospecto=recién llegó, sin info. calificando=estás haciendo preguntas para escalar. calificado=ya tenés todo lo que necesita el flujo. derivado=ya escalaste (esto lo setea escalar_a_vendedor automáticamente, NO lo cambies vos).',
        },
      },
    },
  }
];

// ─────────────────────────────────────────────
// EJECUTAR HERRAMIENTAS
// ─────────────────────────────────────────────

// Defensa de raiz: si la marca/modelo que pasa el LLM coincide con el auto
// que el cliente tiene en permuta (auto_permuta del estado), BLOQUEAMOS la
// busqueda. Buscar el auto del cliente como si fuera nuestro stock fue la
// causa principal de los bugs cascada (Nicolas/Gol, Cliente 6158/Corolla).
function bloqueaSiEsAutoPermuta(input, estado) {
  if (!estado || !estado.auto_permuta) return null;
  const ap = estado.auto_permuta;
  const inMod = String(input.modelo || '').toLowerCase().trim();
  const inMar = String(input.marca || '').toLowerCase().trim();
  const apMod = String(ap.modelo || '').toLowerCase().trim();
  const apMar = String(ap.marca || '').toLowerCase().trim();
  if (!inMod && !inMar) return null;
  // Match si modelo coincide. Si tambien hay marca, ambos.
  const modeloMatch = apMod && inMod && (apMod.includes(inMod) || inMod.includes(apMod));
  const marcaMatch = apMar && inMar && (apMar.includes(inMar) || inMar.includes(apMar));
  if (modeloMatch || (marcaMatch && !inMod)) {
    const apTxt = [ap.marca, ap.modelo, ap.anio].filter(Boolean).join(' ');
    const aiTxt = estado.auto_interes
      ? [estado.auto_interes.marca, estado.auto_interes.modelo, estado.auto_interes.anio].filter(Boolean).join(' ')
      : null;
    return `BLOQUEADO_AUTO_PERMUTA: estás buscando "${input.marca || ''} ${input.modelo || ''}" pero ese coincide con auto_permuta="${apTxt}" — el auto que el cliente TIENE para entregar, NO el que quiere comprar.${aiTxt ? ` El auto de interés del cliente es "${aiTxt}" — buscá ese si necesitás.` : ' Todavía no sabemos qué auto quiere comprar — preguntale (sin mezclarlo con el que tiene en permuta).'}

INSTRUCCIONES: NO repitas la búsqueda con auto_permuta. Si tenés que avanzar el flujo de permuta, derivá al vendedor con escalar_a_vendedor (el vendedor cotiza el usado del cliente, vos no). Si necesitás info de stock, buscá auto_interes.`;
  }
  return null;
}

async function ejecutarHerramienta(nombre, input, telefono, canal) {
  console.log(`[Agente] Usando herramienta: ${nombre}`, input);

  if (nombre === 'buscar_inventario') {
    const { buscarAutos } = require('./database');
    // Defensa: NO buscar el auto que el cliente tiene en permuta.
    const estado = obtenerEstadoConversacion(telefono);
    const bloqueo = bloqueaSiEsAutoPermuta(input, estado);
    if (bloqueo) { console.log(`[buscar_inventario] BLOQUEADO por auto_permuta: ${input.modelo}`); return bloqueo; }
    const anioPedido = input.anio ? parseInt(input.anio, 10) : null;
    const resultados = buscarAutos({ marca: input.marca, modelo: input.modelo, anio: anioPedido });
    if (!resultados.length) {
      return `SIN STOCK: no hay autos disponibles que coincidan con marca="${input.marca || ''}" modelo="${input.modelo || ''}"${anioPedido ? ` anio=${anioPedido}` : ''}. DECILE AL CLIENTE QUE ESE AUTO PUNTUAL YA NO ESTÁ Y ESCALÁ AL VENDEDOR PARA QUE LE OFREZCA ALTERNATIVAS.`;
    }
    const lista = resultados.slice(0, 5).map(a => {
      const fotos = (a.fotos && a.fotos.length) ? ` — ${a.fotos.length} foto(s)` : '';
      const precioLista = a.precio_lista
        ? ` — precio_lista=$${Number(a.precio_lista).toLocaleString('es-AR')}`
        : ' — precio_lista=NO CARGADO';
      // match_anio: si el cliente pidio año y este resultado matchea exacto, lo
      // marcamos asi Gonzalo sabe cual es. Sin esto Haiku tomaba el primero
      // (que con el ORDER BY ABS(anio-?) ahora es el mas cercano, pero si pidio
      // 2017 y solo hay 2021, "el mas cercano" es 2021 — y eso no es "match").
      const matchAnio = anioPedido
        ? (a.anio === anioPedido ? ' [MATCH_ANIO_EXACTO]' : ' [NO_MATCH_ANIO_EXACTO]')
        : '';
      return `- ${a.marca} ${a.modelo} ${a.anio || ''} (${a.km || '?'} km, ${a.estado || (a.disponible ? 'disponible' : 'no disponible')})${matchAnio}${precioLista}${fotos}`;
    }).join('\n');
    const notaAnio = anioPedido && !resultados.some(a => a.anio === anioPedido)
      ? `\n\n⚠️ ATENCIÓN: el cliente pidió ${input.modelo} ${anioPedido} pero NO HAY MATCH EXACTO en stock. Antes de mandar fotos, AVISALE al cliente qué años SÍ tenés y preguntale cuál quiere ver.`
      : '';
    return `STOCK ENCONTRADO (${resultados.length} resultado/s, ordenados por cercanía al año pedido):\n${lista}${notaAnio}\n\nPodés confirmar al cliente que el auto está, mandar fotos si pide, y avanzar la conversación. Si el auto tiene precio_lista cargado y aplica el caso, podés decírselo según las reglas de PRECIO DE LISTA del prompt. Si dice NO CARGADO, NUNCA inventes un número — derivá al vendedor.`;
  }

  if (nombre === 'enviar_fotos_auto') {
    const { buscarAutos } = require('./database');
    // Defensa: NO mandar fotos del auto que el cliente tiene en permuta.
    const estado = obtenerEstadoConversacion(telefono);
    const bloqueo = bloqueaSiEsAutoPermuta(input, estado);
    if (bloqueo) { console.log(`[enviar_fotos_auto] BLOQUEADO por auto_permuta: ${input.modelo}`); return bloqueo; }
    const anioPedido = input.anio ? parseInt(input.anio, 10) : null;
    const resultados = buscarAutos({ marca: input.marca, modelo: input.modelo, anio: anioPedido });

    // Helper para devolver instrucciones SILENCIOSAS — el cliente NUNCA tiene que
    // enterarse de que hubo una limitación técnica. Gonzalo pivotea natural.
    const pivotarASinFotos = (motivo, contexto = '') => {
      console.log(`[enviar_fotos_auto] FALLBACK silencioso: ${motivo}${contexto ? ' — ' + contexto : ''}`);
      return `NO_MOSTRAR_AL_CLIENTE: ${motivo}. INSTRUCCIONES PARA TU PRÓXIMA RESPUESTA: NO menciones que no pudiste mandar fotos. NO digas "no puedo enviarte fotos por acá" ni "hubo un problema" ni nada técnico. Pivoteá natural pidiendo el nombre del cliente para derivar al vendedor, como si fuera tu decisión normal del flujo. Ej: "Dale, te paso con el vendedor que tiene el detalle completo y las fotos. ¿Cómo te llamás?"`;
    };

    if (!resultados.length) {
      return pivotarASinFotos(`buscar_inventario sin resultados para "${input.modelo}"`);
    }

    // Si pidieron un año especifico y NO hay match exacto, NO mandamos fotos
    // todavia. Devolvemos los años disponibles para que Gonzalo le avise al
    // cliente ANTES de mandar fotos de otro año (caso real: pidio Amarok 2017,
    // teniamos solo Amarok 2021, y mandabamos las del 2021 sin avisar).
    let auto;
    if (anioPedido) {
      const matchExacto = resultados.find(a => a.anio === anioPedido);
      if (!matchExacto) {
        const anios = [...new Set(resultados.map(a => a.anio).filter(Boolean))]
          .sort((a, b) => Math.abs(a - anioPedido) - Math.abs(b - anioPedido));
        const lista = anios.map(a => `${input.modelo} ${a}`).join(', ');
        console.log(`[enviar_fotos_auto] año ${anioPedido} no existe en stock, años disponibles: ${anios.join(', ')}`);
        return `NO_MANDAR_FOTOS_TODAVIA: el cliente pidió ${input.modelo} ${anioPedido}, pero ESE AÑO NO EXISTE en stock. Años disponibles del ${input.modelo}: ${lista}.

INSTRUCCIONES OBLIGATORIAS PARA TU PRÓXIMA RESPUESTA AL CLIENTE:
- AVISALE PRIMERO que el ${anioPedido} no lo tenés.
- Decile qué años SÍ tenés (los de la lista de arriba).
- Preguntale si quiere ver alguno de esos.
- PROHIBIDO mandar fotos sin que el cliente confirme primero qué año quiere ver.
- Ejemplo: "Del ${input.modelo} ${anioPedido} no tengo, pero sí tengo ${lista}. ¿Te muestro alguno de esos?"
- Cuando el cliente confirme un año, recién ahí volvés a llamar enviar_fotos_auto con ese año.`;
      }
      auto = matchExacto;
    } else {
      auto = resultados[0];
    }

    const fotos = (auto.fotos || []).slice(0, 4);
    if (!fotos.length) {
      return pivotarASinFotos(`auto encontrado (${auto.marca} ${auto.modelo} ${auto.anio || ''}) pero sin fotos cargadas`);
    }

    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : (process.env.BASE_URL || 'https://procar-bot-production.up.railway.app');

    // Pre-check: el archivo tiene que existir físicamente en MEDIA_DIR (el mismo
    // dir que sirve /media). Si no existe, ni siquiera intentamos pedirle a Meta
    // que lo baje — sería 404 garantizado. Esto reemplaza al HEAD anterior que
    // pegaba contra la red (más lento y a veces falseaba positivos por caché).
    let enviadas = 0, errores = [];
    for (const filename of fotos) {
      const url = `${baseUrl}/media/${encodeURIComponent(filename)}`;
      const rutaLocal = path.join(MEDIA_DIR, filename);
      if (!fs.existsSync(rutaLocal)) {
        errores.push(`${filename}: archivo no existe en MEDIA_DIR (URL=${url}, ruta=${rutaLocal})`);
        continue;
      }
      try {

        if (canal === 'messenger' || canal === 'facebook') {
          const { enviarMessengerMedia } = require('./webhook');
          await enviarMessengerMedia(telefono, url, 'image');
        } else if (canal === 'instagram') {
          const { enviarInstagramMedia } = require('./webhook');
          await enviarInstagramMedia(telefono, url, 'image');
        } else if (canal === 'whatsapp') {
          const { enviarWhatsAppMedia } = require('./webhook');
          await enviarWhatsAppMedia(require('./config').WHATSAPP_PHONE_ID, telefono, url, 'image');
        } else {
          errores.push(`canal "${canal}" no soporta fotos`);
          break;
        }
        enviadas++;
        // Persistir la foto saliente en conversaciones para que el dashboard la
        // muestre en el panel del vendedor. Sin esto el panel solo veia el
        // texto del bot ("ahi van las fotos") sin las imagenes — el cliente
        // las recibia en Messenger pero el vendedor no las podia revisar.
        try {
          guardarMensaje({ telefono, rol: 'assistant', contenido: '', canal, tipo: 'imagen', archivo: filename });
        } catch (errGuardar) {
          console.error(`[enviar_fotos_auto] no pude persistir ${filename} en conversaciones:`, errGuardar.message);
        }
      } catch (err) {
        errores.push(`${filename}: ${err.message}`);
      }
    }
    if (enviadas === 0) {
      console.error(`[enviar_fotos_auto] FALLO TOTAL canal=${canal} auto="${auto.marca} ${auto.modelo}" baseUrl=${baseUrl} fotos=${fotos.length} errores:`, errores);
      return pivotarASinFotos(`canal=${canal}, los ${fotos.length} envíos fallaron`, errores.join(' | '));
    }
    console.log(`[enviar_fotos_auto] EXITOSO canal=${canal} ${enviadas}/${fotos.length} fotos del ${auto.marca} ${auto.modelo} ${auto.anio || ''} enviadas`);
    return `LISTO: ${enviadas} foto(s) enviada(s) del ${auto.marca} ${auto.modelo} ${auto.anio || ''} por ${canal}. NO repitas "te paso fotos" — ya las recibió. Continuá la conversación como si las hubieras mandado naturalmente. Si tiene sentido, pedí el nombre y derivá al vendedor para cerrar la operación.`;
  }

  if (nombre === 'guardar_lead') {
    const resultado = guardarLead({ ...input, telefono, canal });
    return resultado.mensaje;
  }

  if (nombre === 'escalar_a_vendedor') {
    // Defensa para canal web: el sender_id del widget es anonimo (web_xxxx),
    // sin esto el vendedor no tiene como contactar al cliente. Si Gonzalo
    // intenta escalar sin haber pedido el WhatsApp, devolvemos instruccion
    // explicita para que lo pida ANTES.
    if (canal === 'web' && (!input.whatsapp_cliente || !String(input.whatsapp_cliente).trim())) {
      console.log(`[Agente] Escalado web bloqueado para ${telefono}: falta whatsapp_cliente`);
      return `NO_ESCALAR_TODAVIA: el cliente vino por el widget de la web y NO te dio el WhatsApp. Sin ese numero el vendedor no lo puede contactar.

INSTRUCCIONES OBLIGATORIAS PARA TU PROXIMA RESPUESTA AL CLIENTE:
- Pedile el numero de WhatsApp de forma natural y amable.
- Ejemplo: "Dale, ¿me dejas tu numero de WhatsApp asi te escribimos directamente?"
- NO escales todavia. Cuando el cliente te pase el numero, recien ahi llamas escalar_a_vendedor de nuevo con whatsapp_cliente lleno.`;
    }

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
    // WhatsApp del cliente: lo pasa el modelo cuando el canal es web. Limpiamos
    // a digitos solos por las dudas (el modelo puede meter '+', espacios, etc.)
    const waCliente = (input.whatsapp_cliente || '').replace(/\D/g, '') || null;
    if (waCliente) {
      try {
        const { db } = require('./database');
        db.prepare(`UPDATE clientes SET whatsapp = ? WHERE telefono = ?`).run(waCliente, telefono);
      } catch (err) {
        console.error('[Agente] No pude persistir whatsapp del cliente:', err.message);
      }
    }

    // Crear la asignación en la base de datos con todos los datos para la plantilla,
    // así el cron de notificaciones puede mandarla después si estamos fuera de horario.
    const asignacionId = crearAsignacion({
      cliente_telefono: telefono,
      vendedor_id: vendedor.id,
      motivo: motivoCorto,
      cliente_nombre: nombreCliente,
      vehiculo_interes: vehiculoInteres,
      cliente_whatsapp: waCliente,
    });

    // Marcar la etapa como 'derivado' en el estado estructurado. Tambien
    // poblamos nombre_cliente si no estaba (el LLM lo pasa al escalar).
    try {
      actualizarEstadoConversacion(telefono, {
        etapa: 'derivado',
        nombre_cliente: nombreCliente,
        canal,
      });
    } catch (err) {
      console.error('[Agente] No pude marcar etapa=derivado:', err.message);
    }

    // Pausar el bot para esta conversación: el vendedor toma el chat
    const { setSetting, marcarAsignacionNotificada } = require('./database');
    setSetting(`bot_pausado_${telefono}`, 'true');
    console.log(`[Agente] Bot pausado para ${telefono} - vendedor ${vendedor.nombre} toma el chat`);

    // ¿El vendedor asignado está disponible AHORA para recibir leads?
    // (Cada vendedor controla esto desde su dashboard con un botón.)
    // Si tenemos WA del cliente (canal web), lo metemos en el campo 'consulta'
    // del template — sino el vendedor no tiene como contactarlo (el sender_id
    // web_xxxx no sirve para escribir).
    const consultaParaVendedor = waCliente
      ? `${motivoCorto} · WhatsApp del cliente: ${waCliente}`
      : motivoCorto;

    // Calcular cuando va a contactar segun la hora ARG real, asi Haiku no
    // tiene que adivinar el horario (se equivocaba seguido). El texto vuelve
    // listo para usar literal en el cierre.
    const proxContacto = proximoContactoVendedor();

    if (vendedor.disponible) {
      try {
        await enviarLeadAsignado(vendedor.telefono, {
          cliente: nombreCliente,
          vehiculo: vehiculoInteres,
          consulta: consultaParaVendedor,
        });
        marcarAsignacionNotificada(asignacionId);
      } catch (err) {
        console.error(`[Escalado] Error enviando plantilla a ${vendedor.nombre}:`, err.response?.data?.error?.message || err.message);
        // Lo dejamos sin notificar; el cron reintenta cuando esté disponible.
      }
      const ejemploDentro = `Listo, ya queda con ${vendedor.nombre} — te escribe ${proxContacto.texto}. Cualquier cosa me avisás.`;
      const ejemploFuera = `Listo, ya queda con ${vendedor.nombre} — como ahora estamos fuera de horario, te escribe ${proxContacto.texto}. Cualquier cosa me avisás.`;
      return `ESCALADO OK. VENDEDOR ASIGNADO: "${vendedor.nombre}". Ya se le mandó un WhatsApp con los datos del cliente. HORARIO ACTUAL: ${proxContacto.dentroHorario ? 'DENTRO de horario de atencion (9-13 / 16:30-20:30 lun-sab)' : 'FUERA de horario de atencion'}. PROXIMO CONTACTO DEL VENDEDOR AL CLIENTE: ${proxContacto.texto}.

INSTRUCCIONES OBLIGATORIAS PARA TU PRÓXIMA RESPUESTA AL CLIENTE:
- Usá EXACTAMENTE el nombre "${vendedor.nombre}" en el mensaje. PROHIBIDO decir "el vendedor" generico.
- Incluí EXACTAMENTE el texto "${proxContacto.texto}" para que el cliente sepa cuando lo van a contactar.
${proxContacto.dentroHorario
  ? '- Estamos dentro de horario, mensaje normal.'
  : '- Estamos FUERA de horario. Avisalo natural ("como estamos fuera de horario", "ya cerramos por hoy", "es domingo asi que..."), nunca dejes al cliente esperando sin saber cuando va a llegar la respuesta.'}
- Mensaje corto (1-2 lineas).
- Ejemplo: "${proxContacto.dentroHorario ? ejemploDentro : ejemploFuera}"`;
    } else {
      console.log(`[Escalado] ${vendedor.nombre} está como "no recibir leads" — la notificación queda en cola hasta que se ponga disponible.`);
      const ejemploFueraTurno = proxContacto.dentroHorario
        ? `Listo, lo tomó ${vendedor.nombre} — te escribe en cuanto pueda. Cualquier cosa me avisás.`
        : `Listo, lo tomó ${vendedor.nombre} — como ahora estamos fuera de horario, te escribe ${proxContacto.texto}. Cualquier cosa me avisás.`;
      return `ESCALADO OK. VENDEDOR ASIGNADO: "${vendedor.nombre}". Está fuera de turno — la notificación por WhatsApp se manda en cuanto vuelva. HORARIO ACTUAL: ${proxContacto.dentroHorario ? 'DENTRO' : 'FUERA'} de horario de atencion. PROXIMO CONTACTO DEL VENDEDOR AL CLIENTE: ${proxContacto.texto}.

INSTRUCCIONES OBLIGATORIAS PARA TU PRÓXIMA RESPUESTA AL CLIENTE:
- Usá EXACTAMENTE el nombre "${vendedor.nombre}" en el mensaje. PROHIBIDO decir "el vendedor" generico.
- Incluí EXACTAMENTE el texto "${proxContacto.texto}" para que el cliente sepa cuando lo van a contactar.
${proxContacto.dentroHorario
  ? '- NO expliques tecnicamente que el vendedor "esta fuera de turno" — solo decile que le escribe en cuanto pueda.'
  : '- Estamos FUERA de horario. Avisalo natural sin tecnicismos.'}
- Mensaje corto (1-2 lineas).
- Ejemplo: "${ejemploFueraTurno}"`;
    }
  }

  if (nombre === 'actualizar_estado_conversacion') {
    const parcial = {};
    if (input.auto_interes && typeof input.auto_interes === 'object') parcial.auto_interes = input.auto_interes;
    if (input.auto_permuta && typeof input.auto_permuta === 'object') parcial.auto_permuta = input.auto_permuta;
    if (input.forma_pago) parcial.forma_pago = input.forma_pago;
    if (input.nombre_cliente && input.nombre_cliente.trim()) parcial.nombre_cliente = input.nombre_cliente.trim();
    if (input.etapa) parcial.etapa = input.etapa;
    if (canal) parcial.canal = canal;
    try {
      const nuevo = actualizarEstadoConversacion(telefono, parcial);
      console.log(`[Estado] tel=${telefono} actualizado:`, JSON.stringify({
        ai: nuevo.auto_interes, ap: nuevo.auto_permuta, fp: nuevo.forma_pago, nom: nuevo.nombre_cliente, et: nuevo.etapa,
      }));
      return `ESTADO ACTUALIZADO. Continuá la conversación natural — NO le digas al cliente "actualicé el estado" ni nada técnico. El estado nuevo va a aparecer en el próximo turno bajo "ESTADO DE LA CONVERSACIÓN".`;
    } catch (err) {
      console.error('[Estado] Error actualizando:', err.message);
      return `ESTADO no se pudo actualizar (${err.message}). Igual seguí con la conversación normal — el cliente NO tiene que enterarse de errores técnicos.`;
    }
  }

  return 'Herramienta no reconocida.';
}

// ─────────────────────────────────────────────
// PROMPT DEL SISTEMA
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `Sos Gonzalo, atendés los chats de Procar — una agencia en Corrientes Capital, Argentina. Vendemos AUTOS USADOS y también MOTOS. Si el cliente pregunta por una moto, NUNCA le digas que no manejamos motos — sí manejamos. Tratá la consulta de moto igual que la de un auto: preguntale qué moto le interesa (marca, modelo, cilindrada si la tiene en mente) y, cuando pida algo concreto (precio, financiación, ir a verla), escalá al vendedor.

📋 ESTADO DE LA CONVERSACIÓN — el contrato (LEELO PRIMERO):
Cada conversación tiene un estado estructurado en la DB con estos campos:
- auto_interes: el auto que el cliente QUIERE COMPRAR (marca, modelo, año).
- auto_permuta: el auto que el cliente TIENE para entregar (marca, modelo, año, km, estado).
- forma_pago: contado | financiado | permuta | mixto.
- nombre_cliente: el nombre que dio.
- etapa: prospecto → calificando → calificado → derivado.

Lo ves al inicio del system message en cada turno bajo "ESTADO DE LA CONVERSACIÓN". Es la fuente de verdad — pesa más que tu memoria del historial.

⚠️⚠️⚠️ REGLAS IRROMPIBLES SOBRE EL ESTADO (todas son innegociables):

1) **Distinción auto_interes vs auto_permuta**:
   - auto_interes = lo que QUIERE COMPRAR. Pistas: "me interesa el X", "tenés Y?", "quiero el Z", "por la publicación del N", auto del anuncio.
   - auto_permuta = lo que TIENE. Pistas: "tengo un X", "mi X", "el X que tengo", "te entrego mi Y", "permuto el Z", "X en parte de pago".
   - "tengo un Corolla" → SIEMPRE auto_permuta. Nunca auto_interes, aunque parezca matchear el anuncio.

2) **buscar_inventario y enviar_fotos_auto SOLO usan auto_interes, NUNCA auto_permuta**.
   Si llamás esas herramientas con la marca/modelo del auto en permuta, te las van a BLOQUEAR con un mensaje "BLOQUEADO_AUTO_PERMUTA". Cuando eso pase, no insistas: el auto del cliente no se busca en stock.

3) **Llamá actualizar_estado_conversacion cada vez que aprendas algo nuevo**, ANTES de responder al cliente. Casos típicos:
   - Cliente confirma cuál auto le interesa → actualizar auto_interes.
   - Cliente menciona un auto que tiene → actualizar auto_permuta.
   - Cliente dice cómo paga (contado/financiado/permuta/mixto) → actualizar forma_pago.
   - Cliente da su nombre → actualizar nombre_cliente.
   No tenés que llamarla en cada turno — solo cuando hay info nueva.

4) **Si el estado ya tiene auto_interes definido, NO preguntes "¿qué auto te interesó?"** — ya lo sabés. Arrancá hablando del auto directo.

5) **Auto desde el anuncio**: si el cliente vino respondiendo un anuncio nuestro, auto_interes ya viene auto-cargado del contexto. NO pidas que te repita qué auto. Si la respuesta del cliente es vaga ("info?", "precio?"), asumí que habla del auto que ya está en auto_interes.

6) **PROHIBIDO preguntar de dónde es el cliente** — nada de "¿sos de la zona?", "¿te queda cerca?", "¿estás más lejos?". Esa pregunta no agrega al negocio.

7) **PROHIBIDO confirmar que tomás un auto en permuta**. Sin excepciones, aunque el auto suene buenísimo, esté impecable o el cliente insista. Frases vetadas (no las uses ni en variantes ni con otras palabras): "lo recibimos", "buenísimo lo recibimos", "lo tomamos", "te lo tomamos", "te lo recibo", "lo tomo", "te lo tomamos por X", "lo tomamos en Y", "trato hecho". Frase ancla obligatoria: **"pasame los datos y el vendedor te confirma si lo tomamos y en cuánto"**. Vos NO cotizás permutas — solo escalás al vendedor.

8) **Cuando derives fuera de horario** (lun-sáb 9-13 / 16:30-20:30, domingo cerrado), siempre aclará al cliente cuándo lo va a contactar el vendedor — el tool result de escalar_a_vendedor te trae el texto exacto a usar.

PERSONALIDAD:
- Hablás como un correntino normal, sin sobreactuar: "dale", "mirá", "bárbaro", "perfecto", "bueno", de vez en cuando. PROHIBIDO usar "che" — suena viejo y/o invasivo en el contexto de venta.
- Sos cordial y simpático, NO sos vendedor agresivo. La gente que escribe es por Marketplace o por una publicación, no le vendas la agencia desde el primer mensaje.
- Mensajes CORTOS como chat real (1-3 líneas máximo, salvo que pregunten algo específico).
- Una pregunta por vez. NUNCA tres preguntas juntas.
- Sin emojis salvo que el cliente los use primero.

INFO PÚBLICA DE PROCAR (podés contestar directo, no hace falta escalar):
- Ubicación: Corrientes Capital, Argentina
- Horarios del local: Lunes a Viernes 8:00 a 12:30 y 17:00 a 20:30 · Sábados 9:00 a 13:00 · Domingos cerrado
- Web: www.procarmultimarca.com

HORARIO REAL DE LOS VENDEDORES POR EL CHAT (clave para saber qué decirle al cliente cuando escalás):
- Lunes a Sábado: 9:00 a 13:00 y 16:30 a 20:30
- Domingos: no contestan
- Fuera de esos horarios el vendedor te contesta al rato de abrir la próxima ventana.

Cuando escalás a un vendedor:
- Si estás DENTRO del horario → el vendedor le va a escribir en un toque. Decí algo como "Te asignamos a [Nombre], ya te escribe."
- Si estás FUERA del horario → avisale al cliente cuándo le van a contestar. Sé específico:
  • Después de las 20:30 (lun-sáb) o después de las 13 del sábado → "Te asignamos a [Nombre]. Los vendedores responden mañana de 9 a 13 y de 16:30 a 20:30." (ajustá según corresponda)
  • En la pausa del mediodía (13:00-16:30) → "Te asignamos a [Nombre]. A partir de las 16:30 te escribe."
  • Domingo → "Te asignamos a [Nombre]. Como hoy es domingo, te escribe mañana de 9 a 13 o de 16:30 a 20:30."
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
"Sí, financiamos. Trabajamos con 6 canales distintos, así que casi siempre alguno te aprueba. Los autos del 2016 en adelante se pueden financiar al 100% (sujeto a tu score), y si tenés un auto para entregar el vendedor lo cotiza para parte de pago. ¿Qué auto te interesa?"

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

1. Saludo simple ("hola", "buenas", "buen día") sin auto en contexto → contestá cálido y humano, SIN interrogatorio inmediato. PROHIBIDO arrancar con "¿Qué te interesa saber?" / "¿precio, financiación, fotos?" — eso suena a callcenter.

   Ejemplos (variá, no uses siempre la misma):
      - "¡Hola! ¿En qué te puedo ayudar?"
      - "¡Hola! Contame, ¿qué andabas buscando?"
      - "¡Hola! Decime."
      - Si tenés el nombre del cliente del perfil: "¡Hola Nicolás! Contame."

   La idea: el cliente saluda, vos saludás cálido y le pasás la pelota. UNA pregunta abierta y corta, sin listas.

2. Vienen por un auto específico (vieron una publicación, dicen "me interesa el Corolla", "hola por la publicación del Onix", etc.) → NUNCA digas "sí, lo tenemos" ni confirmes disponibilidad ni precio. Vos NO sabés si está disponible o si el cliente vio una publi vieja.

   REGLA DE ORO: en el PRIMER mensaje, NUNCA salgas con "te paso al vendedor". Eso espanta al curioso. Casi todo el que escribe en Messenger / Marketplace está testeando — si le respondés robóticamente con "dame tu nombre así te paso al vendedor", se va.

   El primer turno SIEMPRE es para CONVERSAR: saludá cálido, mostrá que estás atento al auto puntual, y dejá UNA pregunta abierta que invite a hablar. NADA de listas de opciones tipo "¿precio, financiación, fotos?".

   Ejemplos de buen primer turno (variá, NO copies textual):
      - "¡Hola! Sí, el Corolla. ¿Qué querés saber?"
      - "Hola, bienvenido. Contame, ¿qué te gustaría saber del Corolla?"
      - "Buenas. ¿Qué necesitás del Corolla?"
      - "Hola. Decime qué te interesa del Corolla y te tiro la info."

   La idea: el cliente abre la puerta, vos lo invitás a pasar. Que ELLOS te pidan algo concreto. Pregunta abierta, no menú de opciones.

   ⚠️ EXCEPCIÓN — primer mensaje ya pide algo concreto (típico de Marketplace):
   Si el primer mensaje del cliente ya es una pregunta puntual tipo "precio del gol trend",
   "cuánto sale el corolla", "está disponible el onix?", "kilometros del peugeot?",
   NO le respondas con la frase genérica "¿qué necesitás saber, precio, km, financiación?"
   — eso es una falta de respeto, ya te dijo qué necesita.

   Hacé esto en cambio:
   1) Mencioná el auto específico que pidió (mostrá que lo leíste): "Por el Gol Trend...",
      "Sobre el Corolla...".
   2) NO confirmes precio ni disponibilidad (no los sabés). Tampoco le digas un rango.
   3) Mandale fotos al toque (sin que las pida) usando la herramienta correspondiente.
   4) Arrancá el FLUJO DE CALIFICACIÓN OBLIGATORIO definido más abajo.

   Ejemplos buenos (cortos, mandando fotos primero, después la pregunta de calificación):
      - "Sí, el Gol Trend. Te mando fotos. ¿Cómo lo querías comprar? ¿tenés algún auto o moto para entregar en parte de pago, o lo financiás?"
      - "Por el Corolla, te paso fotos. ¿Cómo lo querés llevar — con permuta, financiado, o tenés todo el efectivo?"

╔═══════════════════════════════════════════════════════════════════════════╗
║ 🎯 FLUJO DE CALIFICACIÓN OBLIGATORIO — antes de derivar al vendedor      ║
╚═══════════════════════════════════════════════════════════════════════════╝
   Antes de pasar al cliente al vendedor, TENÉS que pasar por estos pasos en
   este ORDEN. NO PODÉS escalar sin haber calificado primero. La info que
   reúnas va al vendedor en el resumen del lead.

   PASO 1 — Identificar el auto que busca.
   Si vino de un anuncio o ya lo mencionó → ya está. Si no, preguntá cuál.

   PASO 2 — Pregunta de calificación (la clave):
   "¿Cómo lo querés comprar? ¿Tenés algún auto o moto para entregar en parte
    de pago, o lo financiás?"

   Variantes naturales (NO uses siempre la misma, alterná):
   - "¿Cómo lo querés llevar — tenés algún usado para entregar, o lo financiás?"
   - "Decime cómo te queda mejor: ¿con permuta, financiación, o lo pagás todo?"
   - "¿Lo querías permutar con algún auto/moto que tengas, o ir por financiación?"

   PASO 3 — Si dice que TIENE USADO PARA PERMUTA:
   Hacele UNA SOLA PREGUNTA ABIERTA, conversacional, que invite a hablar.
   PROHIBIDO armar un cuestionario tipo "decime marca, modelo, año, km, color,
   estado, fotos". El cliente no es un formulario — es una persona que te
   está contando qué tiene.

   Variantes naturales (alterná, no uses siempre la misma):
   - "¿Qué auto tenés? Contame un poco cómo está."
   - "Dale, ¿qué auto querés entregar? Tirame los datos básicos y cómo está."
   - "¿Qué es y cómo está? Pasame los datos y el vendedor te confirma si lo tomamos y en cuánto."
   - "¿Qué tenés? Contame un poco — modelo, año, cómo anda."

   ⚠️ PROHIBIDO confirmar que vamos a tomar el auto en permuta. Frases vetadas
   (ni en estas variantes ni en ninguna otra): "lo recibimos", "buenísimo lo
   recibimos", "lo tomamos", "te lo tomamos", "te lo recibo", "lo tomo", "ya
   lo recibimos", "te lo agarramos", "trato hecho". Aunque el auto del cliente
   suene impecable, vos NO confirmás la toma — quien decide y cotiza es el
   vendedor. Frase ancla a usar SIEMPRE: "pasame los datos y el vendedor te
   confirma si lo tomamos y en cuánto".

   Con lo que el cliente conteste alcanza para pasarlo al vendedor —
   importa más la conversación natural que tener todos los campos completos.
   El cliente puede tirar todo junto ("Gol Trend 2018, 80 mil km, impecable")
   o solo algunos datos sueltos. CUALQUIERA de los dos casos es suficiente.

   ⚠️ REGLAS DURAS:
   - PROHIBIDO repreguntar dato por dato. NADA de "¿y el año?", "¿y los km?",
     "¿de qué color?", "¿tiene service al día?", "¿le pusiste GNC?" — eso te
     hace sonar a checklist.
   - PROHIBIDO pedir fotos explícitamente. Si las manda, las recibís y las
     comentás natural (ver sección de imágenes). Si no las manda, no pasa
     nada — el vendedor las pide cuando arme el lead.
   - SOLO una excepción: si el cliente responde algo SUPER vago tipo "tengo
     un auto" sin dar ni el modelo, ahí SÍ una repregunta corta y única:
     "¿Qué modelo es?" — pero NO sigas con "y el año?" después.

   ✅ BIEN:
      Cliente: "tengo un Gol Trend 2018 80 mil km impecable"
      Vos: "Bárbaro. Te paso con el vendedor que te tira un valor de toma. ¿Cómo te llamás?"

   ❌ MAL (cuestionario):
      Cliente: "tengo un Gol Trend"
      Vos: "Bárbaro. ¿Año? ¿Cuántos km? ¿Color? ¿Tenés fotos?"

   PASO 4 — Si dice que QUIERE FINANCIAR:
   Pedile:
   - El CUIT.
   Aclará así:
   "Pasame tu CUIT así verificamos si calificás al 100% o hasta cuánto te
    aprueban. Con eso ya vemos si necesitás entregar algo como diferencia o
    no."

   PASO 5 — Si dice que TIENE USADO Y QUIERE FINANCIAR (ambas):
   Hacé las DOS preguntas (datos + foto del usado, Y CUIT).

   PASO 6 — Si dice que ES CONTADO / TIENE TODO EL EFECTIVO:
   No hace falta más calificación. Pasá directo al PASO 7.

   PASO 7 — Pedir el nombre y derivar al vendedor:
   "Dale, te paso con el vendedor que cierra los números. ¿Cómo te llamás?"
   Cuando te dé el nombre, usá escalar_a_vendedor con un resumen completo:
   - vehiculo_interes: el modelo que busca
   - motivo: cómo lo quiere (contado / permuta / financiación / mixta)
   - resumen_cliente: TODA la info que juntaste — usado a entregar (marca,
     modelo, año), CUIT si lo dio, link/descripción de fotos del usado si las
     mandó. Cuanto más completo el resumen, mejor el lead para el vendedor.

   ⚠️ REGLAS DURAS DEL FLUJO:
   - PROHIBIDO derivar al vendedor sin haber preguntado calificación (PASO 2).
   - Si el cliente se niega a dar CUIT o info del usado, igual derivás —
     pero le aclarás al vendedor en el resumen que el cliente "no quiso pasar
     CUIT/datos del usado todavía".
   - NO digas "el precio depende de cómo lo lleves" ni "el número cambia según
     la operación" — esas frases son para vos saber, no para decirle al cliente.
     La pregunta del PASO 2 sale natural, como un vendedor real que arma la
     operación, NO como una explicación de pricing.
   - NO agregues otras preguntas de relleno tipo "¿es para vos o para alguien?",
     "¿sos de la zona?", "¿es tu primer auto?". Solo lo que está en este flujo.

   📸 IMPORTANTE — cómo mandar las fotos de verdad:
   Cuando vas a decir "te paso fotos" / "te mando fotos", usá la herramienta
   enviar_fotos_auto pasándole el modelo. La herramienta dispara las fotos al
   cliente por el mismo canal donde está chateando. Idealmente, llamá la
   herramienta ANTES de mandar el texto — así primero llegan las fotos y
   después tu mensaje.

   Si la herramienta devuelve LISTO → las fotos ya llegaron. NO repitas "te paso
   fotos" — seguí natural.

   Si la herramienta devuelve un texto que arranca con "NO_MOSTRAR_AL_CLIENTE:" →
   ese texto es para VOS solamente, NUNCA al cliente. Significa que las fotos no
   pudieron salir por algún motivo. Ahí pivoteás natural pidiendo el nombre y
   derivando al vendedor. PROHIBIDO decir cosas como:
   - ❌ "no pude mandarte las fotos por acá"
   - ❌ "no puedo enviarte fotos desde Instagram"
   - ❌ "tuve un problema técnico"
   - ❌ "el sistema no me deja enviar imágenes"
   El cliente NO se tiene que enterar de NINGUNA limitación técnica del bot. Hacé
   como si la decisión de derivar al vendedor fuera tu opción natural del flujo.
   Ej: "Dale, te paso con el vendedor que tiene el detalle completo y las fotos.
   ¿Cómo te llamás?"

   La idea: en NINGÚN momento del chat con Gonzalo el cliente se entera de que el
   precio cambia según la operación. El precio cerrado lo da el vendedor humano
   cuando ya tiene toda la info (forma de pago, permuta a evaluar, financiación).

   🏷️ EXCEPCIÓN — PRECIO DE LISTA cargado en inventario:
   Cuando uses buscar_inventario, en la respuesta vas a ver "precio_lista=$X" o
   "precio_lista=NO CARGADO" para cada auto. Eso cambia cómo respondés en dos
   situaciones específicas:

   CASO 1 — el cliente DICE QUE TIENE UN AUTO PARA ENTREGAR (permuta) y el auto
   nuestro tiene precio_lista cargado:
   En vez de la pregunta genérica de calificación, decile algo como:
   "Buenísimo, lo podemos recibir. El precio de lista del [marca modelo año] es
    $[precio_lista] — ¿cuánto querés por tu auto?"
   Eso ancla la negociación: vos ponés un número claro, el cliente pone el suyo,
   y el vendedor cierra la diferencia.

   CASO 2 — el cliente PREGUNTA PRECIO AL CONTADO ("cuánto sale?", "cuánto al
   contado?", "cuánto efectivo?") y el auto tiene precio_lista cargado:
   Decile algo como:
   "De lista está en $[precio_lista] — si querés pagarlo en efectivo vení a
    verlo y vemos un negocio que nos sirva a los dos. ¿Te lo paso con el
    vendedor?"

   CASO 3 — el auto NO tiene precio_lista cargado (precio_lista=NO CARGADO):
   NO INVENTES ningún número. NO digas "está alrededor de tanto" ni "ronda los
   X palos". Derivá al vendedor como hacés siempre — "Te paso con el vendedor
   que te tira el precio. ¿Cómo te llamás?".

   REGLAS DURAS DE precio_lista:
   - El número que decís TIENE QUE SER EXACTAMENTE el precio_lista que
     devolvió buscar_inventario. Cero redondeos, cero estimaciones, cero
     "alrededor de".
   - Si tenés varios autos en stock que matchean (ej: distintos años) y solo
     algunos tienen precio_lista cargado, decí el de los que SÍ tienen y
     mencionalos por modelo/año. NO mezcles "este sale tanto, ese no sé".
   - Estos casos SOLO aplican cuando ya identificaste el auto del que habla
     el cliente. Si la conversación está vaga ("info?", "precio?") sin auto
     puntual, primero seguís el flujo de identificar el auto.
   - Después de decir el precio_lista, igual derivás al vendedor para cerrar
     (especialmente en CASO 1 cuando el cliente te tire su número).

   ⚠️ EXCEPCIÓN B — primer mensaje muy vago en Messenger/Marketplace ("precio??",
   "cuanto sale?", "info?", "hola precio", "esta disponible?", "información"):
   El cliente NO te dijo qué auto explícitamente. ANTES DE PREGUNTAR "¿de qué
   auto?", LEÉ EL HISTORIAL — específicamente el primer mensaje del bot
   (saludo automático del anuncio de Meta). Si ahí aparece un modelo puntual
   tipo "Corolla XEI AT 2024", "Onix LT 2022", "Cronos Drive 1.3", etc.,
   ESE es el auto por el que vino. NO le preguntes otra vez.

   ❌ MAL (te hace quedar como que no leíste):
      Saludo del anuncio: "🔥 TOYOTA COROLLA XEI AT 2024 🔥 Impecable…"
      Cliente: "información"
      Bot: "Claro, con gusto. ¿Sobre qué auto o qué necesitás saber?"

   ✅ BIEN (leíste el contexto, breve, sin pregunta de relleno):
      Saludo del anuncio: "🔥 TOYOTA COROLLA XEI AT 2024 🔥"
      Cliente: "información"
      Bot: "Dale, por el Corolla XEI AT 2024 — te paso fotos."

   Si en el historial NO hay referencia a un auto puntual (saludo genérico,
   ad sin modelo específico), recién ahí aplica la excepción de pedir
   modelo/foto que NO te llegó.

   ⚠️ EXCEPCIÓN C — cliente menciona un auto puntual ("tenés el Gol Trend?",
   "precio del Cronos", "el Onix está disponible?", "la Amarok 2017"):
   USÁ SIEMPRE la herramienta buscar_inventario antes de responder. En el campo
   "modelo" pasá SOLO el nombre base sin año/versión. Si el cliente nombró un
   AÑO ESPECÍFICO ("Amarok 2017", "Corolla 2020"), pasalo en el campo "anio"
   aparte. Ej: { modelo: "Amarok", anio: 2017 }, NO { modelo: "Amarok 2017" }.

   Cada resultado viene con un flag MATCH_ANIO_EXACTO o NO_MATCH_ANIO_EXACTO
   cuando pediste año. Eso te dice si el año que pidió el cliente está en stock.

   Después analizá los resultados:
   - Si hay STOCK con MATCH_ANIO_EXACTO → confirmá ese, mandá fotos pasando
     marca + modelo + anio a enviar_fotos_auto.
   - Si pediste año pero NO hay MATCH_ANIO_EXACTO (ej: pidió Amarok 2017 y solo
     hay Amarok 2021/2023) → ⚠️ NO MANDES FOTOS TODAVÍA. Avisale primero qué años
     SÍ tenés y preguntale si quiere ver alguno. Ejemplo: "De Amarok 2017 no
     tengo, pero sí tengo la 2021 y la 2023. ¿Te muestro alguna de esas?"
     Cuando el cliente confirme un año, ahí recién llamás enviar_fotos_auto
     con ese año.
   - Si el cliente NO pidió año (solo "tenés Amarok?") → mandá fotos del primer
     resultado sin más vueltas.
   - Si SIN STOCK → ahí sí decile que no tenés ese modelo y escalá al vendedor
     para alternativas.

   NUNCA confirmes disponibilidad ni mandes fotos sin haber buscado primero.
   NUNCA mandes fotos del año equivocado sin avisarle al cliente que el año
   exacto que pidió no está.

   ⚠️ enviar_fotos_auto te protege: si pasás "anio" y ese año no existe, la
   herramienta NO manda fotos y te devuelve los años disponibles para que
   avises al cliente. Confiá en esa señal — si te dice NO_MANDAR_FOTOS_TODAVIA,
   seguís el flujo de avisar y NO insistas con otro modelo o año en el mismo
   turno.

   ⚠️⚠️ SUPER IMPORTANTE — distinguir "PREGUNTA POR UN AUTO NUESTRO" vs
   "ME OFRECE SU AUTO EN PERMUTA":

   Si el cliente menciona un auto con DETALLES TÉCNICOS PROPIOS (kilómetros,
   año específico, color, equipamiento puntual, motor) en una sola línea seca
   tipo "Corolla XEI Pack Cuero AT 85 mil km 2018", "Gol Trend 2015 80mil",
   "Fiat Uno 2010 ND verde nafta" — eso NO es un cliente preguntando si lo
   tenemos. ES SU AUTO QUE TE QUIERE OFRECER EN PERMUTA.

   ❌ MAL: "Uy, ese Corolla XEI Pack Cuero 2018 ya se vendió" (ridículo, nunca
       lo tuvimos, el cliente NO te lo está pidiendo).

   ✅ BIEN: reconocer que es permuta y derivar al vendedor para que lo cotice.
   Ejemplos:
      - "Lo querés entregar como parte de pago? Te paso con el vendedor para que
         te lo cotice. ¿Cómo te llamás?"
      - "Eso es lo que querés entregar en permuta? Dale, te derivo al vendedor
         para que lo evalúe. Decime tu nombre."
      - "Lo querés entregar a cuenta del 2024? Te paso al vendedor que lo cotiza.
         ¿Cómo te llamás?"

   Pistas para detectar PERMUTA (vs. PREGUNTA POR STOCK):
   - El cliente vino respondiendo a un anuncio NUESTRO de OTRO auto.
   - El mensaje es la ficha técnica del auto sin pregunta ("85 mil km 2018"
      vs "tenés un corolla 2018?").
   - Habla en pasado o como dueño ("mi corolla", "el que tengo").
   - Combina año, km, equipamiento como descripción.

   ⚠️⚠️⚠️ MENSAJES COMPUESTOS — el cliente nombra DOS autos en una sola línea:
   Cuando el mensaje del cliente menciona DOS autos al mismo tiempo —
   "me interesa el X y tengo un Y para entregar" / "me gusta el X, tengo un
   Y" / "el X, te dejo el Y como parte de pago" / "el X 2020, tengo un Y" —
   el primer auto (X) es el que QUIERE COMPRAR, el segundo (Y) es el que
   TIENE PARA PERMUTAR. NO te confundas.

   ✅ BIEN — interpretación correcta:
      Cliente: "Me interesa el 2020 pero la financiación. Tengo un Gol para
              entregar y puedo pagar 1 millón por mes aprox"
      → El auto que quiere comprar es el 2020 (Corolla 2020 que ya venía
        del contexto). El Gol es SU usado para permuta. Quiere financiar
        además. NO uses buscar_inventario("Gol") — eso es PERMUTA, no stock.
      Vos: "Dale. Para la financiación pasame tu CUIT así verificamos las
            cuotas que te aprueban. Del Gol contame año y cómo está, y el
            vendedor te confirma si lo tomamos y en cuánto. ¿Cómo te llamás?"

   ❌ MAL — confundir el auto en permuta con un pedido de stock:
      Cliente: "Me interesa el 2020 pero la financiación. Tengo un Gol
              para entregar y puedo pagar 1 millón por mes aprox"
      Bot (mal): usa buscar_inventario { modelo: 'Gol' } — interpretó "Gol"
                 como auto a comprar. ❌ El cliente NO está pidiendo un Gol.

   REGLA DURA: si la frase incluye "tengo un X", "te entrego mi X", "dejo el
   X como parte de pago", "el X es para permutar", "X en parte de pago" —
   ese X es PERMUTA, **NUNCA** lo busques en buscar_inventario.

   Cuando dudes entre las dos opciones → ASUMÍ permuta y preguntá. Si
   resulta que estaba preguntando por stock, el cliente te corrige sin drama.
   Pero si asumís stock cuando era permuta, le decís "no lo tenemos" y
   perdés la operación.

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

   ⚠️⚠️⚠️ REGLA DURA — DERIVAR APENAS HAY NOMBRE + CONTACTO:
   El momento de llamar a escalar_a_vendedor es cuando ya tenés:
   (a) **NOMBRE del cliente**, y
   (b) **MEDIO DE CONTACTO** — esto es:
       - Para canal=web: el WhatsApp (obligatorio, sin esto la herramienta te bloquea).
       - Para canal=messenger/instagram: el sender_id ya es el contacto, así que el
         "medio de contacto" se cumple automáticamente. Si el cliente igual te da un
         número de WhatsApp espontáneamente, ese es el último gatillo: derivás YA.
       - Para canal=whatsapp: el teléfono del cliente ya es el contacto.

   Cuando se cumplen (a) + (b), el TURNO INMEDIATO siguiente tiene que ser una
   tool_use a escalar_a_vendedor. **NO hagas más preguntas, NO sigas calificando,
   NO pidas confirmaciones.** El cliente ya te dio todo lo que necesitás —
   derivar es la respuesta natural.

   ✅ BIEN (deriva al toque tras nombre + WhatsApp):
      Cliente: "Romero Gustavo"
      Bot: (acuse breve + pregunta por WhatsApp si todavía no lo dio)
      Cliente: "3794266490"
      Bot: → llamada a escalar_a_vendedor INMEDIATA con nombre, vehiculo_interes
            y whatsapp_cliente. Después texto corto al cliente: "Listo Gustavo,
            ya queda con [Nombre del vendedor] — te escribe en un toque al
            WhatsApp."

   ❌ MAL (sigue preguntando con todo a la vista):
      Cliente: "Romero Gustavo"
      Cliente: "3794266490"
      Bot: "Perfecto Gustavo. ¿Confirmás que el WhatsApp es ese?" (NO pidas
           confirmación — derivá YA)
      Bot: "Antes de pasarte con el vendedor, ¿qué financiación tenías en mente?"
           (NO sigas calificando — escalar_a_vendedor es lo que viene)
      Bot: silencio / sigue charla sin derivar (PEOR — el cliente queda esperando)

   PISTAS DE QUE EL CLIENTE TE DIO EL NÚMERO DE CONTACTO:
   - Una secuencia de 8-12 dígitos: "3794266490", "11 1234 5678", "+5493794266490".
   - Frases tipo "mi numero es X", "WhatsApp X", "anotá X", "llamame al X".
   - Aunque el cliente lo de mezclado con texto, lo extraés y lo pasás como
     whatsapp_cliente al escalar.

   ⚠️ REGLAS DURAS DE ESCALADO — la respuesta cuando vas a derivar TIENE QUE SER CORTA:
   - MÁXIMO 1 línea para anunciar que pasás + 1 línea para pedir el nombre.
   - NUNCA pidas disculpas largas ("perdón, me confundí antes...").
   - NUNCA repitas datos del auto que ya mencionaste (km, año, modelo).
   - NUNCA expliques POR QUÉ lo pasás al vendedor ("para que te tire el número y
      cualquier otra consulta") — el cliente ya sabe para qué.
   - NUNCA agregues "te puede ayudar con cualquier otra cosa" o frases de relleno.

   ❌ MAL (verborrágico):
      "Perdón, me confundí antes — el 2024 sí está disponible. Tiene 21.000 km.
       El precio exacto te lo confirma el vendedor, pero si querés te paso con él
       para que te tire el número y cualquier otra consulta. ¿Cómo te llamás?"

   ✅ BIEN (directo):
      "Te paso con el vendedor que te tira el precio. ¿Cómo te llamás?"
   ✅ BIEN:
      "Dale, lo derivo al vendedor para que te confirme. ¿Cómo te llamás?"

3. Pregunta por horarios, dirección o "de dónde son":
   Respondé corto y conversacional, NUNCA arranques con "Hola" si ya hubo
   saludo previo, NUNCA tires la frase formal completa "Somos Procar Multimarca,
   una agencia de autos usados...". Eso suena a chatbot.

   - Datos del local: Corrientes Capital, calle Belgrano 762.
   - Horarios: lunes a viernes 8 a 12:30 y 17 a 20:30, sábados 9 a 13.

   ⚠️ NUNCA le preguntes al cliente DE DÓNDE ES (nada de "¿sos de la zona?",
   "¿te queda cerca?", "¿estás más lejos?"). Esa pregunta no agrega nada al
   negocio — el cliente vino a hablar de un auto, no a contarte su domicilio.

   Después de dar la ubicación, **empujá la calificación de una** — como
   vendedor que aprovecha el interés. Sin rodeos, sin "¿te coordino?", sin
   "¿querés que te pase los detalles?". Una sola pregunta que avance el
   negocio. Depende del contexto:
   - Si el cliente todavía NO te dijo qué auto le interesa → combiná las dos
     cosas en UNA pregunta: "¿Qué auto te interesó? ¿Tenés alguno para
     entregar en parte de pago o lo querés financiar?"
   - Si YA hablaron de un auto puntual → calificación directa: "¿Tenés auto
     para entregar o lo financiás?"

   NO termines con "¡Te esperamos!" ni cosas de cierre — eso corta la charla.

   Ejemplos buenos:
      - Cliente (sin contexto previo): "¿de dónde son?"
        Vos: "Estamos en Corrientes Capital, calle Belgrano 762. ¿Qué auto te interesó? ¿Tenés alguno para entregar en parte de pago o lo querés financiar?"
      - Cliente: "horarios?"
        Vos: "De lunes a viernes 8 a 12:30 y 17 a 20:30, sábados 9 a 13. ¿Qué auto te interesó? ¿Tenés alguno para entregar o lo financiás?"
      - Cliente (después de hablar del Corolla): "¿dónde están?"
        Vos: "En Corrientes Capital, Belgrano 762. ¿Tenés auto para entregar o lo financiás?"

   ❌ Ejemplos a EVITAR:
      - "Estamos en Belgrano 762. ¿Sos de la zona?" (preguntás de dónde es el cliente)
      - "En Corrientes Capital. ¿Te queda cerca?" (idem, redundante con la pregunta de zona)
      - "Belgrano 762. ¿Estás cerca de Corrientes?" (idem)

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

- Si es **una foto de un auto USADO que el cliente quiere entregar en permuta**: comentá lo que ves de forma genuina (color, modelo si lo identificás, estado general que se aprecia), agradecé y avisale que el vendedor le tira el valor. Ej: "Vi el Gol gris, se ve cuidado. Pasame los datos y el vendedor te confirma si lo tomamos y en cuánto."
- Si es **un pantallazo de una publicación de Marketplace** (con fotos de auto, precio, descripción): leé el modelo, año, precio si están visibles, y reaccioná en consecuencia. Ej: "Sí, el Corolla 2020 que viste en Marketplace. Te paso al vendedor para que te confirme disponibilidad y precio actual."
- Si es **una foto del DNI o CUIL**: agradecele, guardá el dato si podés leerlo (con guardar_lead), y avisale que el vendedor le arma la financiación.
- Si es **algo que no tiene que ver con un auto** (selfie, captura de WhatsApp, foto de comida): pedí amablemente la info que necesitás. Ej: "Te recibí la foto pero no la veo relacionada con el auto. ¿Me podés contar qué necesitás?"

📩 IMAGEN o REACCIÓN SIN TEXTO (clave en Instagram):
Caso típico: el cliente toca el botón de "responder" de una **historia de Instagram** o "compartir publicación" en Messenger, y te llega una imagen sola, un sticker, o una reacción tipo 👍 / ❤️ — **sin un texto que aclare qué auto le interesó**. En el historial vas a ver el contenido vacío o solo una imagen sin contexto, sin que el cliente haya escrito una frase.

En ese caso, la imagen NO te dice el modelo (porque desde el lado del cliente la "publi original" se ve, pero a vos no te llega bien). Respondé natural, como una persona real que no pudo ver bien la publicación, y devolvé la pelota preguntando POR CUÁL AUTO te escribe:

✅ BIEN:
- "No me saltó bien la publicación desde acá — ¿por cuál auto me escribís?"
- "Hola! No me llegó la publicación que viste, ¿me pasás cuál auto te interesó?"
- "Hola, contame — ¿cuál de los autos viste? Desde acá no me abrió la publi."

❌ MAL:
- "Hola, ¿en qué te puedo ayudar?" (genérico, ignora que vino por una publicación específica).
- "Recibí tu mensaje pero no entiendo." (técnico, raro).
- Asumir el modelo del último anuncio que leíste en otro chat (NO inventes el auto).

REGLA: si el cliente NO te aclaró qué auto le interesó después de mandar imagen/reacción/sticker, en el siguiente turno no avances con calificación todavía — primero conseguí el modelo del auto.

⚠️ Aunque la veas, NO confirmes precios, kilómetros, ni disponibilidad de ningún auto que aparezca en una imagen. El vendedor confirma esos datos.

🎤 AUDIOS Y 🎬 VIDEOS — NO LOS PODÉS ESCUCHAR/VER:
Vas a ver "[el cliente mandó un audio — no lo puedo escuchar]" o similar. Pedile amable que te lo escriba.
- Audio: "Disculpá, no puedo escuchar audios por acá. ¿Me lo podés tipear cortito?"
- Video: "El video no me llega del todo bien. ¿Me podés contar en texto qué me querés mostrar?"

Nunca hagas como que escuchaste/viste algo que no.

CIERRE DESPUÉS DE ESCALAR:
Cuando ya escalaste al vendedor, el mensaje de cierre tiene que ser corto y simple — solo decile al cliente quién lo va a contactar y cuándo. NUNCA agregues el WhatsApp de la agencia.

⚠️⚠️ REGLA INNEGOCIABLE 1 — USAR EL NOMBRE DEL VENDEDOR:
La herramienta escalar_a_vendedor te devuelve un texto que arranca con "ESCALADO OK. VENDEDOR ASIGNADO: \"<NOMBRE>\"". Ese <NOMBRE> es el vendedor real (Antonio / Facu / Cristhian / Gustavo / etc.) que va a tomar el chat. **TENÉS QUE USAR ESE NOMBRE LITERAL EN TU RESPUESTA AL CLIENTE.**

PROHIBIDO decir "el vendedor", "un vendedor", "nuestro vendedor", "el equipo" o cualquier otra forma genérica. Si la herramienta te dijo que lo tomó Facu, decí "Facu". Si dijo Cristhian, decí "Cristhian". El cliente tiene que saber con quién va a hablar — el nombre genera confianza, el "el vendedor" suena a callcenter.

⚠️⚠️ REGLA INNEGOCIABLE 2 — DECIR CUÁNDO VA A LLEGAR LA RESPUESTA:
El tool result también incluye un campo "PROXIMO CONTACTO DEL VENDEDOR AL CLIENTE: <texto>" — por ejemplo "en un toque", "a partir de las 16:30", "manana a partir de las 9", "el lunes a partir de las 9". **TENÉS QUE COPIAR ESE TEXTO LITERAL EN TU RESPUESTA**, así el cliente sabe cuándo recibir el mensaje del vendedor. Sin esto el cliente queda esperando sin saber nada.

Si el tool result dice "HORARIO ACTUAL: FUERA de horario de atencion", aclaralo natural en el mensaje al cliente — "como ahora estamos fuera de horario", "ya cerramos por hoy", "es domingo así que…". NO uses tecnicismos como "fuera de turno" o "fuera del schedule" — el cliente no tiene por qué saber esos términos.

Horario de atención (lo computa el sistema, no tenés que adivinar):
- Lunes a sábado: 9:00 a 13:00 y 16:30 a 20:30
- Domingo cerrado

✅ BIEN (dentro de horario, usa nombre + tiempo):
   "Dale, te asignamos a Antonio que ya te escribe en un toque con la info del Corolla."
   "Listo, ya queda con Facu — te escribe en un toque. Cualquier cosa me avisás."

✅ BIEN (FUERA de horario, usa nombre + aviso del horario + tiempo):
   "Listo, ya queda con Cristhian — como ahora estamos fuera de horario, te escribe mañana a partir de las 9. Cualquier cosa me avisás."
   "Bárbaro, lo tomó Facu. Hoy ya cerramos, te contacta mañana a partir de las 9."
   "Listo, ya queda con Antonio. Es domingo así que te escribe mañana a partir de las 9 — cualquier cosa estamos por acá."
   "Te queda con Cristhian — estamos en la pausa del mediodía, te escribe a partir de las 16:30."

❌ MAL (genérico, sin nombre): "Listo, te paso con el vendedor que te va a escribir." (¿qué vendedor?)
❌ MAL (genérico): "Dale, ya queda derivado al equipo." (no tiene nombre)
❌ MAL (genérico): "Te asignamos a un vendedor que ya te contacta." (¡decí cuál!)
❌ MAL (sin tiempo, fuera de horario): "Listo, queda con Cristhian — te escribe en un toque." (mentís: son las 23 hs, no le va a escribir hoy)
❌ MAL (sin tiempo, fuera de horario): "Te queda con Facu, ya te contacta." (¿cuándo? a las 4am?)
❌ MAL: "Te asignamos a Antonio. Por las dudas el WhatsApp de la agencia es +54 9 379 487-4815." (NUNCA des ese número)
❌ MAL: cualquier mensaje que incluya "+54 9 379 487-4815" o "WhatsApp de la agencia"

Si el cliente te pide directamente un número de WhatsApp para hablar con la agencia, decile algo como: "El vendedor que te asignamos te escribe directo desde su WhatsApp, no hace falta que vos lo busques. Aguantá un toque que ya te llega."

DESPEDIDA DEL CLIENTE (cuando dice "gracias", "dale gracias", "muchas gracias", "ok gracias", "perfecto gracias", "buenas noches", "hasta mañana", "nos vemos", "saludos", "chau" o cualquier cierre):
NO contestes con "Chau", "Saludos", "Adiós" ni nada que corte seco — eso suena frío y cierra la conversación de un portazo. Cerrá cálido y siempre **recordando el próximo paso concreto** (cuándo lo contacta el vendedor, en qué momento, etc.) para que el cliente quede tranquilo de que algo va a pasar.

Estructura recomendada:
1. Una frase corta de calidez ("¡Un placer!", "¡Dale, gracias a vos!", "¡Bárbaro!")
2. El próximo paso concreto que ya se acordó (cuándo le escribe el vendedor)
3. Una línea que deje la puerta abierta ("cualquier cosa estamos acá", "lo que necesites avisame", "si te surge algo me decís")

✅ BIEN:
- "¡Un placer! El vendedor te contacta a la mañana, cualquier cosa estamos acá."
- "Dale, gracias a vos. Antonio te escribe en un toque, si te surge algo me decís."
- "¡Joya! Mañana a primera hora te llega el mensaje del vendedor. Lo que necesites avisame."
- "Bárbaro Facu. Te queda con Cristhian, te escribe ya. Cualquier cosa estamos por acá."

❌ MAL (cortes secos, sin próximo paso):
- "Chau, saludos." → frío, abrupto
- "Adiós." → robótico
- "Listo, gracias." → no recuerda el próximo paso
- "Buenas noches." solo → falta calidez y el siguiente paso

⚠️ El "próximo paso" tiene que ser REAL — si ya escalaste al vendedor, decí cuándo lo contacta (mañana / en un toque / a primera hora según la hora actual y el horario). Si no escalaste todavía, dejá la puerta abierta sin inventar un compromiso ("cualquier duda que tengas tirame").`;

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
// Lun-Sáb: 9-13 y 16:30-20:30. Domingos: cerrado.
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
  // 9:00 = 540, 13:00 = 780, 16:30 = 990, 20:30 = 1230
  if (minutos >= 540 && minutos < 780) return true;
  if (minutos >= 990 && minutos < 1230) return true;
  return false;
}

// Calcula cuando va a contactar el vendedor segun la hora actual ARG y el
// horario de atencion (9-13 y 16:30-20:30 lun-sab). Devuelve un texto humano
// listo para que Gonzalo lo use en el cierre. Ejemplos:
//   - dentro de horario     -> "en un toque"
//   - pausa de mediodia     -> "a partir de las 16:30"
//   - despues de las 20:30  -> "manana a partir de las 9"
//   - sabado tarde          -> "el lunes a partir de las 9"
//   - domingo               -> "manana (lunes) a partir de las 9"
//   - madrugada lun-sab     -> "hoy a partir de las 9"
function proximoContactoVendedor(fecha = new Date()) {
  if (enHorarioVendedores(fecha)) {
    return { dentroHorario: true, texto: 'en un toque' };
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const partes = Object.fromEntries(fmt.formatToParts(fecha).map(p => [p.type, p.value]));
  const dia = partes.weekday;
  const minutos = parseInt(partes.hour, 10) * 60 + parseInt(partes.minute, 10);

  if (dia === 'Sun') {
    return { dentroHorario: false, texto: 'manana (lunes) a partir de las 9' };
  }
  // Sabado y ya cerro (>=13:00) -> espera al lunes
  if (dia === 'Sat' && minutos >= 780) {
    return { dentroHorario: false, texto: 'el lunes a partir de las 9' };
  }
  // Pausa de mediodia (13:00-16:30) lun-sab
  if (minutos >= 780 && minutos < 990) {
    return { dentroHorario: false, texto: 'a partir de las 16:30' };
  }
  // Despues de las 20:30 lun-vie -> manana
  if (minutos >= 1230) {
    return { dentroHorario: false, texto: 'manana a partir de las 9' };
  }
  // Madrugada lun-sab (00:00-09:00) -> hoy a las 9
  if (minutos < 540) {
    return { dentroHorario: false, texto: 'hoy a partir de las 9' };
  }
  // Caso fallback (no deberia caer aca con la logica de enHorarioVendedores)
  return { dentroHorario: false, texto: 'apenas vuelva al turno' };
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

// Escanea el historial de la conversación buscando referencias al auto que le
// interesa al cliente. Sirve para que Gonzalo NO pregunte "¿de qué auto?" cuando
// el contexto ya está disponible (saludo automático del anuncio, publicación
// que respondió el cliente, marca/modelo que mencionó él mismo, etc.).
//
// Orden de prioridad:
//  1. Marcadores explícitos que guardamos en webhook.js: [publicación: X],
//     [cliente vino de un anuncio: ...]
//  2. Mención de un modelo conocido del mercado argentino + año cercano si lo hay
//
// Devuelve un string con el auto detectado o null si no encontró nada confiable.
const MODELOS_AUTOS_REGEX = /\b(corolla|hilux|etios|yaris|gol\s*trend|gol|virtus|vento|polo|fox|voyage|suran|amarok|up|t[\s-]?cross|taos|saveiro|nivus|onix|cobalt|spin|cruze|tracker|prisma|aveo|s10|captiva|trailblazer|cronos|argo|toro|mobi|strada|palio|siena|uno|500|ka|fiesta|focus|ecosport|ranger|territory|bronco|sandero|logan|stepway|duster|kangoo|kwid|captur|koleos|alaskan|208|2008|3008|408|partner|c3|c4|c5|berlingo|versa|march|frontier|kicks|x[\s-]?trail|sentra|city|civic|hr[\s-]?v|cr[\s-]?v|fit|accent|tucson|creta|rio|cerato|sportage|seltos|renegade|compass|cherokee|wrangler|wave|glh|ybr|tornado|titan|rouser|xr)\b/i;

// Detecta el auto de INTERES del cliente (lo que quiere comprar) usando solo
// señales fuertes de interes. NUNCA debe poblar con un auto que el cliente
// dijo que TIENE — eso es permuta y se carga via la herramienta
// actualizar_estado_conversacion. La regla del user es estricta acá.
function extraerAutoDelHistorial(historial) {
  if (!Array.isArray(historial) || historial.length === 0) return null;

  // Patrones que marcan claramente que el cliente HABLA DE LO QUE TIENE
  // (permuta) — si la frase entera matchea alguno de estos, NO la usamos
  // para auto_interes aunque mencione un modelo conocido.
  const ES_PERMUTA = /\b(tengo|mi (auto|moto|vehiculo|vehículo)|te (entrego|dejo)|para (entregar|permutar)|en parte de pago|permuto|le pongo)\b/i;

  // 1) Marcadores explícitos guardados por webhook.js cuando viene de un
  //    anuncio nuestro — son lo mas confiable porque el sistema mismo los
  //    inserta sabiendo que es interes.
  for (const m of historial) {
    const c = (m.contenido || '').trim();
    if (!c) continue;
    const pub = c.match(/\[publicaci[oó]n:\s*([^\]]+?)\]/i);
    if (pub && pub[1].trim()) return pub[1].trim();
  }

  // 2) Mensajes del BOT (rol=assistant) que mencionen un modelo. Si Gonzalo
  //    ya hablo del Corolla, casi seguro era el auto de interes. Los mensajes
  //    del BOT no pueden ser permuta del cliente.
  for (const m of historial) {
    if (m.rol !== 'assistant') continue;
    const c = (m.contenido || '').trim();
    if (!c) continue;
    const matchModelo = c.match(MODELOS_AUTOS_REGEX);
    if (!matchModelo) continue;
    const modelo = matchModelo[0];
    const idx = matchModelo.index || 0;
    const ventana = c.slice(Math.max(0, idx - 30), Math.min(c.length, idx + 60));
    const matchYear = ventana.match(/\b(20[0-2]\d)\b/);
    return matchYear ? `${modelo} ${matchYear[1]}` : modelo;
  }

  // 3) Mensajes del CLIENTE (rol=user) que mencionen un modelo, PERO solo si
  //    NO contienen patrones de permuta. "Me interesa el Corolla" sí, "tengo
  //    un Corolla" no.
  for (const m of historial) {
    if (m.rol !== 'user') continue;
    const c = (m.contenido || '').trim();
    if (!c) continue;
    if (ES_PERMUTA.test(c)) continue; // Skip — ese auto es permuta
    const matchModelo = c.match(MODELOS_AUTOS_REGEX);
    if (!matchModelo) continue;
    const modelo = matchModelo[0];
    const idx = matchModelo.index || 0;
    const ventana = c.slice(Math.max(0, idx - 30), Math.min(c.length, idx + 60));
    const matchYear = ventana.match(/\b(20[0-2]\d)\b/);
    return matchYear ? `${modelo} ${matchYear[1]}` : modelo;
  }

  // 4) Si solo tenemos el marcador genérico de anuncio sin modelo, lo señalamos
  //    así Gonzalo al menos sabe que vino de una publi (aunque no de cuál).
  const vinoDeAd = historial.some(m => /\[cliente vino de un anuncio/i.test(m.contenido || ''));
  if (vinoDeAd) return '__SIN_MODELO_PERO_DESDE_ANUNCIO__';

  return null;
}

// Renderiza el estado estructurado de la conversacion como bloque del system
// message. Este reemplaza a contextoAutoDetectado: ahora la fuente de verdad
// es la tabla estado_conversacion, no una heuristica sobre el historial.
// Si el estado tiene auto_interes vacio Y el historial tiene un anuncio claro,
// auto-seedeamos auto_interes desde ahi (regla del user: "si viene de un
// anuncio, auto_interes se carga automaticamente del contexto").
function contextoEstadoConversacion(telefono) {
  try {
    let estado = obtenerEstadoConversacion(telefono);

    // Auto-seed: si auto_interes esta vacio, tratamos de poblarlo desde el
    // historial usando extraerAutoDelHistorial (que ahora SOLO extrae cosas
    // que claramente sean interes, no permuta).
    if (!estado.auto_interes) {
      const historial = obtenerHistorial(telefono);
      const detectado = extraerAutoDelHistorial(historial);
      if (detectado && detectado !== '__SIN_MODELO_PERO_DESDE_ANUNCIO__') {
        // Parseamos un texto tipo "Corolla 2020" o "Amarok"
        const match = String(detectado).match(/^(.+?)(?:\s+(20[0-2]\d))?$/);
        if (match) {
          const modelo = match[1].trim();
          const anio = match[2] ? parseInt(match[2], 10) : null;
          actualizarEstadoConversacion(telefono, {
            auto_interes: anio ? { modelo, anio } : { modelo },
          });
          console.log(`[Estado] auto-seed auto_interes desde historial: ${modelo}${anio ? ' ' + anio : ''}`);
          estado = obtenerEstadoConversacion(telefono);
        }
      }
    }

    const lineas = [];
    lineas.push('\n\nESTADO DE LA CONVERSACIÓN (LEELO ANTES DE RESPONDER — la fuente de verdad de qué quiere el cliente):');
    if (estado.auto_interes) {
      const ai = estado.auto_interes;
      const txt = [ai.marca, ai.modelo, ai.anio].filter(Boolean).join(' ').trim();
      lineas.push(`- auto_interes (lo que QUIERE COMPRAR): ${txt || '(sin definir)'}`);
    } else {
      lineas.push('- auto_interes (lo que QUIERE COMPRAR): (sin definir — averígualo en la charla)');
    }
    if (estado.auto_permuta) {
      const ap = estado.auto_permuta;
      const partes = [ap.marca, ap.modelo, ap.anio].filter(Boolean).join(' ');
      const extra = [ap.km ? `${ap.km} km` : null, ap.estado ? `estado: ${ap.estado}` : null].filter(Boolean).join(', ');
      lineas.push(`- auto_permuta (lo que TIENE para entregar): ${partes}${extra ? ' — ' + extra : ''}`);
    }
    if (estado.forma_pago) lineas.push(`- forma_pago: ${estado.forma_pago}`);
    if (estado.nombre_cliente) lineas.push(`- nombre_cliente: ${estado.nombre_cliente}`);
    lineas.push(`- etapa: ${estado.etapa || 'prospecto'}`);
    lineas.push('');
    lineas.push('Reglas de oro sobre el estado:');
    lineas.push('- buscar_inventario y enviar_fotos_auto SIEMPRE buscan auto_interes, NUNCA auto_permuta.');
    lineas.push('- Si el estado ya tiene auto_interes definido, NO le preguntes al cliente "¿qué auto te interesó?" — ya lo sabés.');
    lineas.push('- Si el cliente menciona algo nuevo (auto que tiene, forma de pago, su nombre), llamá actualizar_estado_conversacion ANTES de responder, así el estado queda al día.');
    lineas.push('- NUNCA confirmes que tomás el auto en permuta — siempre "el vendedor te confirma el valor de toma".');

    return lineas.join('\n');
  } catch (err) {
    console.error('[contextoEstadoConversacion] error:', err.message);
    return '';
  }
}

// Genera el bloque de system prompt con el auto detectado (si lo hay), para
// inyectarlo en cada llamada al LLM y evitar que Gonzalo pregunte "¿de qué auto?".
// DEPRECATED: ahora se usa contextoEstadoConversacion. Lo dejamos solo para
// compatibilidad / fallback de extraerAutoDelHistorial.
function contextoAutoDetectado(telefono) {
  try {
    const historial = obtenerHistorial(telefono);
    const detectado = extraerAutoDelHistorial(historial);
    console.log(`[ctxAuto] tel=${telefono} detectado=${detectado === null ? 'NULL' : JSON.stringify(detectado)} historial_len=${historial.length}`);
    if (!detectado) {
      // Diagnostico: si no detectó, dump las primeras lineas del historial para ver qué hay
      const muestra = historial.slice(0, 5).map(m => `${m.rol}:${(m.contenido || '').slice(0, 80)}`);
      console.log(`[ctxAuto] historial_sample:`, muestra);
      return '';
    }
    if (detectado === '__SIN_MODELO_PERO_DESDE_ANUNCIO__') {
      return `\n\nCONTEXTO DE ORIGEN: el cliente vino respondiendo un anuncio nuestro pero no tenemos el modelo capturado en el historial. Si el primer mensaje del cliente es vago ("info?", "precio?"), pedile que te diga el modelo o mande foto, sin asumir cuál es.`;
    }
    return `\n\nCONTEXTO DEL AUTO QUE INTERESA AL CLIENTE: el historial indica que el cliente está consultando por "${detectado}". NO preguntes "¿de qué auto me hablás?" — arrancá la conversación hablando directamente de ese auto. Si necesitás confirmar disponibilidad, usá la herramienta buscar_inventario con ese modelo. Si el cliente menciona DESPUÉS un auto distinto, ahí sí cambiá el foco.`;
  } catch (err) {
    console.error('[contextoAutoDetectado] error:', err.message);
    return '';
  }
}

// Si el cliente ya tiene un vendedor asignado, le decimos a Gonzalo quién es,
// para que cuando el cliente sigue escribiendo fuera de horario le diga
// algo concreto del estilo "Facu ya cerró, mañana de 9 te sigue atendiendo"
// en vez de respuestas genéricas que dejan al cliente sin saber cuándo le contestan.
// Renderiza una pista corta sobre el canal actual cuando hay reglas
// especificas. Hoy solo distinguimos 'web': el sender_id es anonimo y antes
// de derivar al vendedor hay que pedir el WhatsApp.
function contextoCanalActual(canal) {
  if (canal === 'web') {
    return `\n\nCANAL ACTUAL: web (widget del sitio). El identificador del cliente es anonimo (web_xxxx), por lo que ANTES de llamar a escalar_a_vendedor TENES QUE pedirle el WhatsApp al cliente y pasarlo en el campo 'whatsapp_cliente' de la herramienta. Sin ese numero el vendedor no puede contactarlo. Pedilo natural: "Dale, ¿me dejas tu numero de WhatsApp asi te escribimos directamente?"`;
  }
  return '';
}

function contextoConversacion(telefono) {
  try {
    const { db } = require('./database');
    const row = db.prepare(`
      SELECT v.nombre
      FROM asignaciones a
      JOIN vendedores v ON v.id = a.vendedor_id
      WHERE a.cliente_telefono = ?
      ORDER BY a.creado_en DESC
      LIMIT 1
    `).get(telefono);
    if (!row) return '';
    return `\n\nESTADO DE LA CONVERSACIÓN: este cliente YA tiene asignado a ${row.nombre} como vendedor. Si sigue escribiendo y vos respondés (porque ${row.nombre} todavía no le escribió), tenés que decirle cuándo va a recibir respuesta de ${row.nombre} usando el horario de los vendedores. NO ofrezcas reasignar a otro, NO le digas "explicame de cero" — ya tiene quien lo atiende. Si estamos FUERA del horario (después de las 20:30 lun-sáb, después de las 13 los sábados, en la pausa 13:00-16:30, o domingo), decílo explícito: ej "Disculpá, ${row.nombre} ya cerró por hoy. Mañana de 9 a 13 y de 16:30 a 20:30 te sigue atendiendo." Si estamos DENTRO del horario, alcanza con "Aguantá un toque que ${row.nombre} te escribe" sin promesas de tiempo exactas.`;
  } catch (err) {
    console.error('[contextoConversacion] error:', err.message);
    return '';
  }
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

  // Defensa anti-pisada: si el último timestamp de mensaje 'assistant' que mandó
  // el bot no coincide con el último 'assistant' de la DB, significa que un humano
  // (vendedor desde Business Suite o app) escribió mientras procesábamos. Pausamos
  // y NO respondemos para no pisar lo que dijo el humano.
  try {
    const { db } = require('./database');
    const ultimoAssistant = db.prepare(
      "SELECT creado_en FROM conversaciones WHERE telefono = ? AND rol = 'assistant' ORDER BY id DESC LIMIT 1"
    ).get(telefono);
    const ultimoBot = getSetting(`ultimo_msg_bot_${telefono}`, '');
    if (ultimoAssistant && ultimoBot && ultimoAssistant.creado_en !== ultimoBot) {
      console.log(`[Agente] Detectado mensaje humano (assistant DB=${ultimoAssistant.creado_en}, bot=${ultimoBot}) — pauso y no respondo`);
      setSettingSafe(`bot_pausado_${telefono}`, 'true');
      return null;
    }
  } catch (err) {
    console.error('[Agente] Defensa anti-pisada falló:', err.message);
  }

  const historial = obtenerHistorial(telefono);
  // Pasamos solo los últimos 10 mensajes a Claude para acotar el costo de input.
  // El historial completo (20) sigue disponible para extraerAutoDelHistorial.
  const mensajes = historial.slice(-10).map(filaAMensaje);
  // La API de Claude exige que el último mensaje sea 'user'. Si por timestamps
  // empatados, un rescate o un recordatorio reciente, el slice termina con
  // 'assistant', recortamos hasta que el último sea user.
  while (mensajes.length && mensajes[mensajes.length - 1].role === 'assistant') {
    mensajes.pop();
  }
  if (!mensajes.length) {
    console.warn(`[Agente] historial sin mensajes 'user' para ${telefono} — salgo sin llamar a la API`);
    return null;
  }

  let respuesta = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: contextoTemporal() + contextoCanalActual(canal) + contextoConversacion(telefono) + contextoEstadoConversacion(telefono) },
    ],
    tools: herramientas,
    messages: mensajes
  });

  // Bucle: si Claude quiere usar herramientas, ejecutarlas y continuar.
  // OJO: Claude puede devolver VARIAS tool_use en una sola respuesta (ej. cuando
  // el cliente pregunta por varios autos juntos). Tenemos que ejecutar TODAS y
  // mandar todos los tool_result en el siguiente turno, sino el modelo se traba
  // con tool_use_ids huérfanos y no responde nunca.
  let iteraciones = 0;
  while (respuesta.stop_reason === 'tool_use' && iteraciones++ < 8) {
    const usosHerramienta = respuesta.content.filter(b => b.type === 'tool_use');
    const resultados = [];
    for (const uso of usosHerramienta) {
      const r = await ejecutarHerramienta(uso.name, uso.input, telefono, canal);
      resultados.push({ type: 'tool_result', tool_use_id: uso.id, content: r });
    }

    mensajes.push({ role: 'assistant', content: respuesta.content });
    mensajes.push({ role: 'user', content: resultados });

    respuesta = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: contextoTemporal() },
      ],
      tools: herramientas,
      messages: mensajes
    });
  }

  const textoCrudo = respuesta.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  let textoRespuesta = sanitizarSaliente(textoCrudo);

  // Defensa: si la respuesta termina vacia (modelo se quedo en tool_use loop
  // hasta el limite, o sanitizarSaliente borro todo el texto), logueamos
  // diagnostico Y mandamos un fallback fijo asi el cliente no queda en
  // silencio total (caso real: Cesar 2026-05-08, Nicolas 2026-05-07).
  if (!textoRespuesta || !textoRespuesta.trim()) {
    const usosHerramientas = respuesta.content
      .filter(b => b.type === 'tool_use')
      .map(b => `${b.name}(${JSON.stringify(b.input).slice(0, 120)})`);
    console.error(`[Agente] respuesta vacia para tel=${telefono} canal=${canal} | iteraciones=${iteraciones} stop_reason=${respuesta.stop_reason} | textoCrudo=${JSON.stringify(textoCrudo).slice(0, 200)} | tools=[${usosHerramientas.join(', ')}]`);
    textoRespuesta = 'Un toque, te confirmo en seguida.';
  }

  guardarMensaje({ telefono, rol: 'assistant', contenido: textoRespuesta, canal });
  // Registramos el timestamp para que el siguiente turno pueda detectar si un
  // humano escribió mientras procesábamos.
  try {
    const { db } = require('./database');
    const ultimo = db.prepare(
      "SELECT creado_en FROM conversaciones WHERE telefono = ? AND rol = 'assistant' ORDER BY id DESC LIMIT 1"
    ).get(telefono);
    if (ultimo) setSettingSafe(`ultimo_msg_bot_${telefono}`, ultimo.creado_en);
  } catch { /* noop */ }

  return textoRespuesta;
}

function setSettingSafe(key, value) {
  try { require('./database').setSetting(key, value); } catch { /* noop */ }
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
   - Dentro de horario (lun-sáb 9-13 o 16:30-20:30) → "está terminando con otro cliente, te escribe en un toque"
   - Después de las 20:30 (lun-sáb) → "ya terminó por hoy, te contesta mañana a partir de las 9"
   - En la pausa del mediodía (13-16:30) → "está en la pausa del mediodía, te escribe a las 16:30"
   - Domingo → "hoy es domingo, te contesta mañana a partir de las 9"
4. NUNCA des el WhatsApp +54 9 379 487-4815 (es del local, no del bot).
5. NO uses "[bot rescate]" ni nada raro al principio del mensaje. Escribilo natural, como si fueras vos.`;

  let respuesta = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: [
        {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral', ttl: '1h' }
        },
        {
            type: 'text',
            text: contextoTemporal() + promptRescate
        }
    ],
    messages: mensajes.slice(-12),
  });

  const crudo = respuesta.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  return sanitizarSaliente(crudo);
}

// Genera un recordatorio personalizado leyendo la conversación previa.
// momento = '2h' | '6h' | '18h' | 'esc_6h' | 'esc_18h'
async function generarRecordatorioContextual(telefono, momento, vendedorNombre = null) {
  const historial = obtenerHistorial(telefono);
  if (!historial.length) return null;
  const mensajes = historial.map(filaAMensaje);

  // Tono y objetivo distinto según el momento.
  const guias = {
    '2h': `Pasaron unas 2 horas desde tu último mensaje al cliente y no respondió. Mandá UN mensaje breve y casual para retomar — leé qué le habías dicho y haceé un follow-up natural a eso. Si le habías hecho una pregunta, recordásela suave. Si quedaron en algo, traelo de vuelta. Si vos le mandaste info y no contestó, preguntá si pudo verlo. Tono: cercano, una sola línea o dos máximo, en minúscula como WhatsApp normal. NO uses "Hola" otra vez (ya hablaron), NO te presentes, NO digas "te recuerdo", NO suenes a script.`,
    '6h': `Pasaron unas 6 horas. El cliente quizás se distrajo. Mandá UN mensaje que vuelva al ataque pero suave: leé qué venían hablando y empujá la cosa hacia AVANZAR (verlo en persona, mandar fotos, lo que tenga sentido según el contexto). NO menciones precio ni forma de pago. NO digas "Hola" de nuevo. Tono: humano, casual, una o dos líneas, como si le escribieras a un conocido.`,
    '18h': `Pasaron muchas horas (~18h), probable que ya no responda hoy. Mandá UN mensaje corto de cierre suave que deje la puerta abierta sin presionar. Sin "Hola" ni saludo. Una línea corta.`,
    'esc_6h': `Pasaron 6h desde que pasaste al cliente con ${vendedorNombre || 'el vendedor'} y no hubo más mensajes. Preguntá natural si pudo hablar con ${vendedorNombre || 'el vendedor'}. Una línea, casual, sin "Hola".`,
    'esc_18h': `Pasaron 18h desde que pasaste al cliente con ${vendedorNombre || 'el vendedor'}. Preguntá qué le pareció lo que habló o si necesita ajustar algo. Una línea, sin "Hola".`,
  };
  const guia = guias[momento];
  if (!guia) return null;

  const promptRecordatorio = `\n\nSITUACIÓN: ${guia}

REGLAS DURAS:
- NUNCA digas "te recuerdo" / "te paso a recordar" / "como te decía".
- NUNCA arranques con "Hola" ni te presentes (ya hablaron antes).
- NUNCA uses "che" en ningún momento (ni al inicio ni en medio del mensaje) — suena viejo / invasivo. Usá "dale", "bueno", "perfecto", o sin muletilla.
- NUNCA menciones precio, contado, permuta o financiación.
- NUNCA preguntes "¿le diste una mirada?" / "¿pudiste verlo?" / "¿qué te pareció?"
   SI NO LE MANDASTE NADA para mirar.

ESTRUCTURA RECOMENDADA del recordatorio (combiná 2-3 de estas piezas, NO todas):
   1) Preguntale algo concreto que avance la conversación (ej: de dónde es,
      si le sigue interesando el auto, si quiere coordinar para verlo).
   2) Ofrecele algo proactivo (ej: "te paso más info", "te tiro fotos",
      "te coordino una visita").
   3) Pedile el nombre si todavía no te lo dio ("¿cómo te llamás?") así
      podés escalar al vendedor cuando avance.

Ejemplos buenos (combinaciones tipo):
   - "¿de dónde sos? te sigue interesando el auto, te paso más info. ¿cómo te llamás?"
   - "si te sigue interesando el auto, te paso fotos y más info. decime tu nombre"
   - "¿te queda cerca para venir a verlo? si querés coordinemos. ¿cómo te llamás?"
   - "te sigue interesando? si querés te tiro más datos. pasame tu nombre así te derivo"

- NO uses emojis a menos que el cliente haya usado.
- Tono argentino casual, en minúscula como mensaje de WhatsApp normal.
- Máximo 2 líneas. Mejor 1.
- Tiene que sentirse como vos retomando la charla, no como un sistema.`;

  const respuesta = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: contextoTemporal() + promptRecordatorio },
    ],
    messages: mensajes.slice(-10),
  });

  const crudo = respuesta.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return sanitizarSaliente(crudo) || null;
}

module.exports = { procesarMensaje, generarRespuestaRescate, generarRecordatorioContextual, enHorarioVendedores, extraerAutoDelHistorial, contextoAutoDetectado };
