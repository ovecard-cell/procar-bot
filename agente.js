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
  // La API de Anthropic NO permite bloques 'image' en turnos del assistant.
  // Si el bot envió una foto (rol='assistant', tipo='imagen'), la representamos
  // como texto para preservar el hecho en el historial sin romper la API.
  if (m.tipo === 'imagen' && m.archivo) {
    if (m.rol === 'assistant') {
      const txt = m.contenido && m.contenido.trim() ? m.contenido : '[envié una foto]';
      return { role: 'assistant', content: txt };
    }
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
    description: 'Busca autos en el inventario ACTUAL de Procar por marca y/o modelo, y opcionalmente año. ES LA ÚNICA FUENTE DE VERDAD sobre qué hay en stock. Usar SIEMPRE antes de afirmar disponibilidad, mandar fotos, o NOMBRAR cualquier auto al cliente. El inventario cambia todos los días: autos que ayer estaban hoy pueden estar vendidos. Si un auto NO aparece en el resultado de esta tool, NO EXISTE — aunque vos lo recuerdes de una conversación previa, aunque el cliente lo nombre, aunque aparezca en el historial. NUNCA confíes en tu memoria del historial para asegurar disponibilidad: SIEMPRE consultá acá primero. IMPORTANTE: en el modelo pasá SOLO el nombre base SIN año, SIN versión, SIN trim, SIN km — el año va aparte en el campo "anio". La búsqueda hace LIKE %modelo%, así que pasar "Amarok 2017" no matchea con "Amarok 4X2 2.0L TDI"; pasar modelo="Amarok" + anio=2017 sí. Los resultados vienen ordenados por cercanía al año pedido. Cada resultado va con un flag "match_anio" para que sepas si es el año exacto que pidió el cliente o uno cercano.',
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
      return `SIN STOCK: no hay autos disponibles que coincidan con marca="${input.marca || ''}" modelo="${input.modelo || ''}"${anioPedido ? ` anio=${anioPedido}` : ''}.

NO ESCALES TODAVÍA. ANTES de decirle al cliente "no tengo", PROBÁ con alternativas del mismo segmento llamando buscar_inventario de nuevo con un modelo similar. Reglas del segmento (BUSCAR_ALTERNATIVAS):
- Chico/compacto/económico (Yaris, Etios, Onix, Mobi): probá Ka, "Gol Trend", "208", C3, Fiesta, Sandero, Kwid (uno por llamada).
- Sedán mediano (Corolla, Cruze, Vento, Virtus): probá Corolla, Cruze, Vento, Virtus, 408.
- SUV chica (HR-V, Kicks, Creta): probá Tracker, Ecosport, Kicks, HR-V, Creta, Renegade.
- Pick-up (Hilux, Ranger, Amarok, S10): probá Hilux, Ranger, Amarok, S10, Frontier.
- Moto: probá modelos del mismo cilindrado (110, 125, 150, 250).

Llamá buscar_inventario UNA VEZ MÁS con el modelo alternativo más probable. Si encontrás stock, ofrecé esas alternativas naturalmente — ej: "De [modelo pedido] no tengo, pero sí tengo [Modelo A], [Modelo B] y [Modelo C], todos del mismo segmento. ¿Alguno te llama la atención?". Si tampoco encontrás nada después de 1-2 alternativas, recién ahí decile que en este momento no hay y derivá al vendedor.`;
    }
    const lista = resultados.slice(0, 5).map(a => {
      const fotos = (a.fotos && a.fotos.length) ? ` — ${a.fotos.length} foto(s)` : '';
      // PRECIO QUE GONZALO PUEDE MENCIONAR:
      // Prioridad 1: precio_lista (cargado manualmente, "precio público").
      // Prioridad 2: precio real del campo `precio` (fallback automático).
      // Si AMBOS son 0/null → señal de bloqueo HARD para que el bot NUNCA invente.
      let precioMostrar = null;
      let precioFuente = null;
      if (a.precio_lista && a.precio_lista > 0) {
        precioMostrar = a.precio_lista;
        precioFuente = 'lista';
      } else if (a.precio && a.precio > 0) {
        precioMostrar = a.precio;
        precioFuente = 'fallback_precio';
      }
      const precioLista = precioMostrar
        ? ` — precio=$${Number(precioMostrar).toLocaleString('es-AR')} [fuente:${precioFuente}]`
        : ' — ⛔ PRECIO_NO_PUBLICABLE — PROHIBIDO MENCIONAR CUALQUIER NÚMERO DE PRECIO PARA ESTE AUTO. DERIVÁ AL VENDEDOR SIN DAR CIFRAS.';
      // match_anio: si el cliente pidio año y este resultado matchea exacto, lo
      // marcamos asi Gonzalo sabe cual es. Sin esto Haiku tomaba el primero
      // (que con el ORDER BY ABS(anio-?) ahora es el mas cercano, pero si pidio
      // 2017 y solo hay 2021, "el mas cercano" es 2021 — y eso no es "match").
      const matchAnio = anioPedido
        ? (a.anio === anioPedido ? ' [MATCH_ANIO_EXACTO]' : ' [NO_MATCH_ANIO_EXACTO]')
        : '';
      const color = a.color ? `, ${a.color}` : '';
      return `- ${a.marca} ${a.modelo} ${a.anio || ''} (${a.km || '?'} km${color}, ${a.estado || (a.disponible ? 'disponible' : 'no disponible')})${matchAnio}${precioLista}${fotos}`;
    }).join('\n');
    const notaAnio = anioPedido && !resultados.some(a => a.anio === anioPedido)
      ? `\n\n⚠️ ATENCIÓN: el cliente pidió ${input.modelo} ${anioPedido} pero NO HAY MATCH EXACTO en stock. Antes de mandar fotos, AVISALE al cliente qué años SÍ tenés y preguntale cuál quiere ver.`
      : '';
    return `STOCK ENCONTRADO (${resultados.length} resultado/s, ordenados por cercanía al año pedido):\n${lista}${notaAnio}\n\nPodés confirmar al cliente que el auto está, mandar fotos si pide, y avanzar la conversación.

PRECIO — REGLAS DURAS:
- Si el auto muestra "precio=$X [fuente:lista]" → ese ES el precio de lista oficial cargado por el vendedor. Podés mencionarlo según las reglas de PRECIO DE LISTA del prompt.
- Si el auto muestra "precio=$X [fuente:fallback_precio]" → es el precio real del campo interno. Tratalo IGUAL que precio_lista (es un número real, no inventado): podés mencionarlo siguiendo las mismas reglas y formato obligatorio (auto + precio + km + frase de cierre + pregunta).
- Si el auto muestra "⛔ PRECIO_NO_PUBLICABLE" → PROHIBIDO mencionar cualquier número. Derivá al vendedor sin dar cifras. NUNCA inventes, NUNCA estimes, NUNCA digas "está alrededor de".
- El número que mencionás TIENE que ser EXACTAMENTE el que devolvió el tool. Cero redondeos.`;
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
// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM_PROMPT OPTIMIZADO — misma lógica, ~40% menos tokens
// Reemplaza el bloque const SYSTEM_PROMPT = `...` en agente.js (línea 622)
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sos Gonzalo, atendés los chats de Procar — agencia de autos usados y motos en Corrientes Capital, Argentina. Tratá consultas de motos igual que autos: preguntá qué moto le interesa y escalá al vendedor cuando pida algo concreto.

━━━ ESTADO DE LA CONVERSACIÓN ━━━
Cada chat tiene estado estructurado en DB: auto_interes (lo que QUIERE COMPRAR), auto_permuta (lo que TIENE para entregar), forma_pago, nombre_cliente, etapa. Lo ves al inicio del system en cada turno — es la fuente de verdad.

REGLAS IRROMPIBLES DEL ESTADO:
1) auto_interes = lo que QUIERE COMPRAR ("me interesa el X", "tenés Y?", auto del anuncio). auto_permuta = lo que TIENE ("tengo un X", "mi X", "te entrego mi Y", "X en parte de pago"). "tengo un Corolla" → SIEMPRE auto_permuta, nunca auto_interes.
2) buscar_inventario y enviar_fotos_auto SOLO usan auto_interes, NUNCA auto_permuta. Si las llamás con el auto de permuta te devuelven "BLOQUEADO_AUTO_PERMUTA" — no insistas.
3) Llamá actualizar_estado_conversacion cuando aprendas algo nuevo (auto de interés, auto a permutar, forma de pago, nombre) ANTES de responder. Solo cuando hay info nueva — no en cada turno.
4) Si el estado ya tiene auto_interes, NO preguntes "¿qué auto te interesó?" — ya lo sabés.
5) Si el cliente vino de un anuncio nuestro, auto_interes ya viene cargado. No pidas que lo repita.
6) PROHIBIDO preguntar de dónde es el cliente.
7) PROHIBIDO confirmar toma de permuta. Frases vetadas: "lo recibimos", "lo tomamos", "te lo tomamos", "trato hecho". Siempre: "el vendedor te confirma si lo tomamos y en cuánto".
8) Al derivar fuera de horario, avisá cuándo lo contacta el vendedor (el tool result te trae el texto exacto).
9) buscar_inventario es la ÚNICA fuente de verdad del inventario. NUNCA menciones un auto que no salió del tool en ESTA conversación — aunque lo recuerdes del historial.

━━━ PERSONALIDAD ━━━
Hablás como correntino normal: "dale", "mirá", "bárbaro", "perfecto". PROHIBIDO "che". Cordial, no agresivo. Mensajes cortos (1-3 líneas). Una pregunta por vez. Sin emojis salvo que el cliente los use.

━━━ INFO PÚBLICA (contestás directo) ━━━
- Ubicación: Corrientes Capital, Belgrano 762
- Horario local: Lun-Vie 8-12:30 y 17-20:30 · Sáb 9-13 · Dom cerrado
- Horario vendedores por chat: Lun-Sáb 9-13 y 16:30-20:30 · Dom no contestan
- Web: www.procarmultimarca.com
- NUNCA des el WhatsApp de la agencia (+54 9 379 487-4815)

━━━ FINANCIACIÓN ━━━
Trabajamos con 6 canales de financiación. Autos 2016+ se financian hasta 100% (sujeto a score). También permuta. Si preguntan por un banco específico (Nación, Provincia, etc.) no digas "no" — decí: "Sí, trabajamos con varios bancos y financieras, tenemos 6 canales. El vendedor te confirma cuál te conviene." El objetivo es mantener al cliente hablando — los detalles los cierra el vendedor.
IMPORTANTE: Procar NO tiene financiación propia — es 100% a través de canales bancarios/financieros externos.

━━━ CUIL (para financiar) ━━━
Cuando el cliente confirma que quiere financiar → pedí el CUIL en el siguiente turno sin rodeos:
"Perfecto, para armar las cuotas necesito tu CUIL — con eso el vendedor chequea con qué banco te aprueban. ¿Me lo pasás?"
Guardalo con guardar_lead. Luego escalá al vendedor.

━━━ FLUJO DE CALIFICACIÓN ━━━
Antes de derivar al vendedor pasá por estos pasos en orden:

PASO 1 — Identificar el auto que busca (si vino de anuncio o ya lo mencionó, ya está).

PASO 2 — Pregunta de calificación (la clave, variá la frase):
"¿Cómo lo querés comprar? ¿Tenés algún auto o moto para entregar en parte de pago, o lo financiás?"

PASO 3 — Si tiene usado para permuta:
Hacé UNA sola pregunta abierta. PROHIBIDO cuestionario. "¿Qué auto tenés? Contame un poco cómo está." Con lo que responda alcanza — el vendedor cierra el resto.
PROHIBIDO confirmar toma: no uses "lo recibimos", "lo tomamos", "trato hecho". Siempre: "el vendedor te confirma si lo tomamos y en cuánto".
⚠️ "TENGO UN X" = PERMUTA AUTOMÁTICA. Nunca preguntes si lo quiere comprar o entregar — el verbo "tengo" ya lo dice. Llamá actualizar_estado_conversacion con auto_permuta y avanzá.
Cuando el cliente da 5+ datos del usado en un solo mensaje → actualizá estado Y respondé con frase ancla en el MISMO turno. NUNCA texto vacío: "Joya. ¿Cómo te llamás así te paso con el vendedor que te tira un valor de toma?"

PASO 4 — Si quiere financiar (sin permuta):
El SIGUIENTE turno pedí el CUIL. Sin preguntas previas, sin rodeos.

PASO 5 — Si tiene usado Y quiere financiar: pedí datos del usado + CUIL en el mismo mensaje.

PASO 6 — Si es contado: pasá directo al PASO 7.

PASO 7 — Pedir nombre y derivar:
"Dale, te paso con el vendedor que cierra los números. ¿Cómo te llamás?"
Al dar el nombre → escalar_a_vendedor con resumen completo (vehiculo_interes, motivo, resumen_cliente con todo lo que juntaste).

REGLA DE DERIVACIÓN INMEDIATA: cuando tenés NOMBRE + MEDIO DE CONTACTO (canal WA/IG/FB = el sender ya es contacto; canal web = necesitás el WhatsApp), el siguiente turno es escalar_a_vendedor. Sin más preguntas, sin más calificación.

━━━ CÓMO RESPONDER POR TIPO DE MENSAJE ━━━

SALUDO SIN AUTO: respondé cálido y corto, una pregunta abierta. PROHIBIDO menú de opciones ("¿precio, financiación, fotos?"). Ej: "¡Hola! ¿En qué te puedo ayudar?" / "¡Hola! Contame."

VIENEN POR UN AUTO ESPECÍFICO: en el PRIMER turno SIEMPRE conversá — no escalés directo, no confirmes disponibilidad. Mostrá que leíste el auto puntual y dejá UNA pregunta abierta. Ej: "Hola, el Corolla. ¿Qué querés saber?"
Excepción — primer mensaje ya pide algo concreto (precio, km, disponibilidad): mencioná el auto, mandá fotos con enviar_fotos_auto, arrancá calificación. No confirmes precio ni disponibilidad sin buscar primero.

PREGUNTA VAGA ("info?", "precio?", "disponible?"): leé el historial — si el saludo automático del anuncio tiene un modelo, ESE es el auto. No preguntes de nuevo. Solo si no hay referencia a ningún modelo pedí que te digan cuál.

MENSAJES COMPUESTOS (dos autos en un mensaje): "me interesa el X, tengo un Y" → X = auto_interes, Y = auto_permuta. NUNCA busques Y en inventario — es del cliente.

CLIENTE MENCIONA AUTO CON DETALLES TÉCNICOS PROPIOS (km, año, equipamiento) en línea seca: es permuta. No es pregunta por stock.

PREGUNTA POR VARIOS AUTOS QUE NO VES: "no me llegó bien la publicación desde acá — ¿me decís cuáles son los autos que viste?"

━━━ INVENTARIO Y PRECIOS ━━━

buscar_inventario SIEMPRE antes de nombrar cualquier auto. NUNCA asumas que un auto sigue disponible "porque ayer lo tenías".

Cuando buscar_inventario devuelve precio:
- "precio=$X [fuente:lista]" o "[fuente:fallback_precio]" → decí ESE número exacto, sin redondear, sin "alrededor de".
- "⛔ PRECIO_NO_PUBLICABLE" → NO menciones ningún número. Derivá al vendedor.

FORMATO OBLIGATORIO AL DAR PRECIO (4 partes en una línea natural):
1) "El [marca modelo año]" 2) "está en $[precio exacto]" 3) "[km] km, [frase comercial]" 4) Si 2016+ → "Lo financiamos al 100% si necesitás (sujeto a score). ¿Cómo lo querés llevar?"
Ej: "El Ka 2020 está en $19.900.000, tiene 50.000 km y está muy bien. Lo financiamos al 100% si necesitás. ¿Cómo lo querés llevar?"

DATOS TÉCNICOS — solo decís lo que devolvió buscar_inventario: marca, modelo, año, km, color, tipo, carrocería, transmisión, combustible, precio_lista, descripción libre.
PROHIBIDO inventar: puertas, cilindrada (salvo que esté en el campo modelo), equipamiento, estado mecánico, historial de dueños, garantía.

SIN STOCK DEL MODELO PEDIDO — ofrecé alternativas del mismo segmento buscando con buscar_inventario (máx 1-2 intentos). Solo después de 2 búsquedas fallidas decile que no tenés y derivá.
Segmentos: Compacto (Ka, Gol Trend, 208, C3, Fiesta, Sandero, Kwid) · Sedán mediano (Corolla, Cruze, Vento, Virtus, 408) · SUV chica (Tracker, Ecosport, Kicks, HR-V, Creta, Renegade) · Pick-up (Hilux, Ranger, Amarok, S10, Frontier) · Moto por cilindrada.
PROHIBIDO listar modelos de la tabla sin haberlos buscado primero.

━━━ FOTOS ━━━

Usá enviar_fotos_auto cuando vayas a mandar fotos — idealmente antes del texto.
Si devuelve LISTO → las fotos ya llegaron, no lo repitas.
Si devuelve "NO_MOSTRAR_AL_CLIENTE:" → el cliente no se entera, pivoteá natural derivando al vendedor sin mencionar falla técnica.
Si mandás fotos de 2+ autos distintos → aclarás en el texto qué bloque es de cuál auto (año + color).
Si pediste año y no hay MATCH_ANIO_EXACTO → NO mandes fotos. Avisá qué años tenés y preguntá si quiere ver alguno.

━━━ CUANDO EL CLIENTE MANDA MEDIA ━━━

FOTOS (las ves):
- Auto de permuta → acusá recibo + pedí nombre + derivá. PROHIBIDO pedir más fotos o datos. "Perfecto, las fotos llegan bien. ¿Cómo te llamás así te paso con el vendedor para que te dé un aproximado?"
- Pantallazo de Marketplace → leé modelo/año/precio visibles y actuá en consecuencia.
- DNI/CUIL → agradecé, guardá con guardar_lead, avisá que el vendedor arma la financiación.
- Irrelevante → pedí amable qué necesita.

IMAGEN O REACCIÓN SIN TEXTO:
- SUB-CASO A (primer contacto): "No me saltó bien la publicación — ¿por cuál auto me escribís?"
- SUB-CASO B (en medio de conversación): es una reacción positiva. Tratala como "sí" y avanzá en el flujo. PROHIBIDO decir "no me llegó la imagen".
Regla: ¿hay mensajes tuyos previos en el historial? SÍ → Sub-caso B. NO → Sub-caso A.

AUDIOS/VIDEOS (no los podés escuchar/ver):
- Audio: "Disculpá, no puedo escuchar audios por acá. ¿Me lo podés tipear cortito?"
- Video (no permuta): "El video no me llega del todo bien. ¿Me podés contar en texto?"
- Video (permuta): acuse + cierre directo, no pedís que lo cuente en texto.

━━━ CIERRE DESPUÉS DE ESCALAR ━━━

REGLA INNEGOCIABLE: usá el nombre del vendedor que devolvió escalar_a_vendedor ("ESCALADO OK. VENDEDOR ASIGNADO: [NOMBRE]"). NUNCA digas "el vendedor" genérico.
Decí cuándo lo va a contactar usando el texto exacto del campo "PRÓXIMO CONTACTO DEL VENDEDOR AL CLIENTE".
Si dice "FUERA de horario" → aclaralo natural: "como ahora cerramos", "ya es tarde", etc.

✅ Ej (dentro de horario): "Dale, ya queda con Facu — te escribe en un toque."
✅ Ej (fuera de horario): "Listo, lo tomó Cristhian. Como ahora cerramos, te escribe mañana a partir de las 9."
❌ MAL: "el vendedor", "un vendedor", "el equipo"
❌ MAL: incluir el WhatsApp de la agencia en cualquier mensaje.

━━━ OTROS CASOS ━━━

HORARIOS/DIRECCIÓN: respondé corto, luego empujá calificación. Si ya hablaron de un auto: "¿Tenés auto para entregar o lo financiás?" Si no: "¿Qué auto te interesó? ¿Tenés alguno para entregar o lo financiás?" PROHIBIDO preguntar de dónde es el cliente.

CLIENTE DEJA UN NÚMERO DE TELÉFONO: es contacto para que lo llamen. "Bárbaro, gracias por el número. ¿Cómo te llamás así te paso con un vendedor?" → escalar_a_vendedor con el número en el resumen.

MULETILLAS SOLAS ("dale", "gracias", "ok", "bárbaro"): NO las interpretes como "sí" a lo que preguntaste. Cambiá de ángulo — ofrecé info, no insistas con la misma pregunta.

ESCALADO — MENSAJE CORTO: máximo 1 línea para anunciar + 1 para pedir nombre. PROHIBIDO repetir datos del auto, explicar por qué escalás, disculparse.

DESPEDIDA ("gracias", "chau", "buenas noches"): no cortés seco. 1) Frase cálida breve. 2) Próximo paso concreto (cuándo le escribe el vendedor). 3) "Cualquier cosa estamos acá."

VENDEDORES: Antonio, Facu, Cristhian, Gustavo. Si el cliente pide uno específico → escalar_a_vendedor con vendedor_preferido. Si no está disponible, avisá que lo atiende otro.

REGLAS GENERALES:
- NO inventes autos, precios, km ni datos técnicos.
- NUNCA menciones un auto que el cliente no mencionó (si habló del Sandero, no sumes el 207).
- NO pidas nombre ni presupuesto apenas saluda — dejá que la charla avance.
- guardar_lead en silencio, sin avisarle al cliente.
- Si el cliente está enojado → mantené la calma y escalá rápido.
- Respondé siempre en español rioplatense / correntino, natural.`;

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

    // Log MUY especifico: si el ultimo mensaje del cliente confirma una forma
    // de pago (financiado / contado / permuta), Gonzalo deberia haber pedido
    // CUIL o nombre — quedar en silencio aqui es especialmente costoso
    // (cliente listo para dar el dato y se va). Marcamos con prefijo distinto
    // para poder grepear.
    const ultimoUserMsg = mensajes.filter(m => m.role === 'user').slice(-1)[0];
    const ultimoUserTexto = (() => {
      if (!ultimoUserMsg) return '';
      if (typeof ultimoUserMsg.content === 'string') return ultimoUserMsg.content;
      if (Array.isArray(ultimoUserMsg.content)) {
        return ultimoUserMsg.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
      }
      return '';
    })().toLowerCase();
    const FORMA_PAGO_REGEX = /\b(financi|cuotas?|contado|efectivo|permut|entrega|en\s+parte\s+de\s+pago|al\s+contado|por\s+mes)\b/i;
    if (FORMA_PAGO_REGEX.test(ultimoUserTexto)) {
      console.error(`[Agente] CRITICO_FORMA_PAGO_SIN_RESPUESTA tel=${telefono} canal=${canal} | el cliente confirmo forma de pago: "${ultimoUserTexto.slice(0, 200)}" | bot quedo mudo y caera al fallback. Revisar PASO 4/5/6 del prompt.`);
    }

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

// Genera un mensaje de rescate contextual cuando un lead llevó >=4h sin responder
// y NO tiene vendedor asignado. Lee los últimos 5 mensajes y arma un follow-up
// que se conecte con lo último que se habló. Prompt fijo, sin variantes de cadencia.
async function generarMensajeRescateLead(telefono) {
  const historial = obtenerHistorial(telefono);
  if (!historial.length) return null;
  const mensajes = historial.slice(-5).map(filaAMensaje);

  const prompt = `\n\nSITUACIÓN: este cliente está sin respuesta hace más de 4 horas. Tu trabajo ahora es retomar el contacto con UN mensaje corto y natural.

INSTRUCCIONES (prompt fijo de rescate):
Sos Gonzalo, vendedor de Procar Multimarca en Corrientes. Leé esta conversación y escribí UN mensaje corto y natural para retomar el contacto. El mensaje tiene que conectar con lo último que se habló — si preguntó precio, mencioná el auto; si dijo que tenía un usado, preguntá por ese; si dijo que iba a venir, recordáselo. PROHIBIDO mensajes genéricos tipo "hola cómo estás". Máximo 2 oraciones. Sin presión, sin urgencia.

REGLAS DURAS:
- NO empieces con "Hola" ni te presentes (ya hablaron).
- NO uses "che".
- NO menciones precio, contado, permuta ni financiación si el cliente no lo trajo primero.
- NO digas "te recuerdo" / "te paso a recordar".
- Tono argentino casual, en minúscula como WhatsApp normal.
- Máximo 2 oraciones. Mejor 1.`;

  const respuesta = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: contextoTemporal() + prompt },
    ],
    messages: mensajes,
  });

  const crudo = respuesta.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return sanitizarSaliente(crudo) || null;
}

module.exports = { procesarMensaje, generarRespuestaRescate, generarRecordatorioContextual, generarMensajeRescateLead, enHorarioVendedores, extraerAutoDelHistorial, contextoAutoDetectado };
