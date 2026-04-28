# 🚗 Procar Bot — Mapa del Proyecto

> Última actualización: abril 2026

---

## ✅ HECHO

### Infra y deploy
- [x] Bot deployado en Railway: `procar-bot-production.up.railway.app`
- [x] Repo en GitHub: `ovecard-cell/procar-bot`
- [x] Política de privacidad publicada (`privacy.html`)
- [x] DB SQLite con tablas: autos, clientes, conversaciones, vendedores, asignaciones, settings

### Agente Gonzalo
- [x] Prompt con personalidad correntina, tono ablandado
- [x] Info pública: dirección, horarios, web, WhatsApp
- [x] Info de financiación (6 canales, 2016+, score, permuta)
- [x] Sin inventario falso — escala todo a vendedor real
- [x] Herramientas: `guardar_lead`, `escalar_a_vendedor`
- [x] Validación de token Meta al arrancar con logs claros

### Canales
- [x] **Facebook Messenger** — webhook configurado, Page ID 1507822689523582, suscrito a `messages` y `messaging_postbacks`, RESPONDIENDO 🟢
- [ ] **Instagram** — pendiente configurar
- [ ] **WhatsApp** — pendiente, falta abrir ventana de 24h con vendedores

### Dashboard
- [x] `/admin` — vista del jefe (todo)
- [x] `/vendedor/:nombre` — vista filtrada por vendedor (Antonio, Facu, Tiki, Gustavo)
- [x] Botón grande **Encender / Apagar** del agente
- [x] Stats: mensajes hoy, clientes, leads, asignaciones, canal más activo
- [x] Lista de conversaciones en vivo con preview, vendedor asignado y tiempo
- [x] Vista de chat: cliente vs Gonzalo, con chip dorado donde se escaló
- [x] Panel "Actividad por canal" (IG vs FB vs WA)
- [x] Panel "Asignaciones por vendedor" (total / pendientes / cerrados)
- [x] Panel "Últimos pasados a vendedor"
- [x] Auto-refresh cada 10s

### Endpoints útiles
- [x] `/demo` — chat de prueba con Gonzalo
- [x] `/analizar` — clasifica conversaciones de la DB con Claude
- [x] `/distribuir` — manda calientes a vendedores por WhatsApp
- [x] `/importar-conversacion` — sube conversaciones manualmente
- [x] `/agente/estado` — ver/cambiar estado del agente

---

## 🔄 EN PROCESO — entrenamiento del bot

Estamos puliendo el prompt con casos reales:
- [x] Saludo no dispara preguntas comerciales
- [x] No pide nombre+presupuesto+auto todo junto
- [x] Entiende "por la publicación del [auto]" aunque venga con tipeos
- [x] Info de financiación general
- [ ] Casos especiales: cliente molesto, envío a otra provincia
- [ ] Frases típicas de objeciones y respuestas
- [ ] Cierre de conversación cuando ya escaló

---

## ⏳ POR HACER (en orden)

### 1. Pulir Gonzalo con conversaciones reales 👈 ESTAMOS ACÁ
- Probar Messenger con clientes reales
- Cada respuesta rara → ajustar el prompt
- Ir cargando casos especiales

### 2. Configurar Instagram
- Mismo flujo que Messenger pero con caso de uso de IG
- Verificar webhook + suscripciones de la cuenta de IG Business

### 3. Inventario real
- Cargar la lista de autos reales (Excel / pasted text / form web)
- Reactivar la herramienta `buscar_autos` cuando haya datos
- Decidir formato de precio (USD / ARS / ambos)

### 4. WhatsApp para los vendedores
- Cada vendedor manda "hola" al WhatsApp Business para abrir ventana 24h
- Probar `/distribuir` con flujo real
- Eventualmente crear template de Meta para no depender de la ventana

### 5. Botón "Responder como vendedor" en el dashboard
- Que cada vendedor pueda escribirle directo al cliente desde el dashboard
- Cuando escribe, Gonzalo se queda quieto en esa conversación

### 6. Comentarios automáticos en posts
- Auto-respuesta a comentarios de IG/FB con "te ayudamos por DM"
- Requiere permiso `pages_manage_engagement` y suscripción a `feed`

### 7. Seguimiento automático
- Cron a los 30-40 min de escalado: "¿cómo te fue con el cliente?"
- Toggle por vendedor para no atormentarlos

### 8. Login con contraseña
- Las URLs `/admin` y `/vendedor/X` están abiertas
- Agregar contraseña por usuario

---

## 🚀 ÚLTIMO PASO — Publicar app en Meta

Para que clientes que NO son admin/tester puedan chatear:
- [ ] Categoría de la app, ícono 1024x1024
- [ ] Pasar app a modo Live
- [ ] Pedir review para los permisos avanzados

---

## 📂 Archivos clave

- [agente.js](agente.js) — cerebro del bot (prompt + herramientas)
- [webhook.js](webhook.js) — recibe mensajes de Meta + valida token
- [database.js](database.js) — SQLite + queries
- [mensajero.js](mensajero.js) — envía WhatsApp a vendedores
- [config.js](config.js) — variables de entorno
- [index.js](index.js) — servidor Express + endpoints + dashboard
- [admin.html](admin.html) — dashboard
- [demo.html](demo.html) — chat de prueba
- [analizar.js](analizar.js) — clasifica conversaciones con Claude
- [distribuir.js](distribuir.js) — manda leads a vendedores
- [privacy.html](privacy.html) — política de privacidad pública
