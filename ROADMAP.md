# 🚗 Procar Bot — Mapa del Proyecto

> Última actualización: abril 2026

---

## ✅ HECHO

- [x] Agente **Tito** con Claude (Sonnet 4.6) — busca autos, guarda leads, escala a vendedor
- [x] Webhook funcionando: WhatsApp + Instagram + Messenger
- [x] Base de datos SQLite (autos, clientes, conversaciones, vendedores, asignaciones)
- [x] Aviso automático al vendedor por WhatsApp cuando se escala un cliente
- [x] Política de privacidad (`privacy.html`) publicada en GitHub Pages
- [x] Repo en GitHub: `ovecard-cell/procar-bot`

---

## 🔄 DECIDIDO — listo para implementar

### Multimedia
- **Fotos:** el bot las lee con la visión de Claude (sin costo extra)
- **Audios:** el bot responde "no puedo escuchar audios, mandame por texto" (no usamos Whisper para no pagar)

### Horario
- Bot responde **24/7**
- Escalado a vendedor solo entre **8:00 y 21:00** — fuera de horario queda en cola y se dispara a la mañana

### Panel de administración
Va a tener:
- Mensajes entrantes por día / canal
- Asignaciones por vendedor (pendientes / cerradas)
- **Botón maestro:** Agente ON/OFF global
- **Por vendedor:** activo/inactivo + recibir seguimientos sí/no
- Lista de últimas conversaciones

---

## ⏳ POR HACER (en orden)

### 1. Entrenar al bot 👈 ESTAMOS ACÁ
Cargar al prompt todo lo que Tito tiene que saber:
- [ ] **Info básica de Procar** (horarios, dirección, formas de pago, financiación, recibís usado en parte de pago, garantía)
- [ ] **Preguntas frecuentes** y cómo responderlas
- [ ] **Técnicas de venta** (regateo, cliente indeciso, comparaciones)
- [ ] **Forma de hablar de Tito** (frases sí / frases no)
- [ ] **Casos especiales** (cliente molesto, envío a otra provincia, etc.)

### 2. Panel de administración
- [ ] HTML simple servido por Express en `/admin`
- [ ] Login con contraseña
- [ ] Stats + tablas + botones ON/OFF
- [ ] Tabla `settings` y campos nuevos en `vendedores`

### 3. Multimedia
- [ ] Procesar `type: image` de WhatsApp (descargar + pasar a Claude)
- [ ] Procesar `type: image` de Instagram
- [ ] Procesar `type: audio` → respuesta automática pidiendo texto

### 4. Horario inteligente
- [ ] Función `esHorarioEscalado()`
- [ ] Cron job que dispara escalados pendientes a las 8:00
- [ ] Mensaje al cliente: "Te contacta un vendedor mañana a primera hora"

### 5. Críticos antes de publicar
- [ ] **Deduplicación** de webhooks (Meta reenvía si tardás)
- [ ] **Vendedores reales** (reemplazar teléfonos de ejemplo)
- [ ] **Manejo de errores** si Claude falla
- [ ] **Inventario real** (cargar autos reales — ¿desde CSV? ¿panel?)

### 6. Seguimiento automático
- [ ] Cron a los 30-40 min de escalado: "¿Cómo te fue con el cliente?"
- [ ] Respetar el toggle de cada vendedor (no atormentar)

---

## 🚀 ÚLTIMO PASO — Publicar en Meta

Cuando todo lo anterior esté listo:
- [ ] Subir privacy.html y activar en config de Meta
- [ ] Completar datos de la app en Meta (categoría, ícono, etc.)
- [ ] Pasar app a modo producción (Live)
- [ ] Configurar webhooks productivos
- [ ] Probar end-to-end con cuenta real

---

## 📂 Archivos clave

- [agente.js](agente.js) — cerebro del bot (prompt + herramientas)
- [webhook.js](webhook.js) — recibe mensajes de Meta
- [database.js](database.js) — SQLite + queries
- [mensajero.js](mensajero.js) — envía WhatsApp a vendedores
- [config.js](config.js) — variables de entorno
- [index.js](index.js) — servidor Express
- [privacy.html](privacy.html) — política de privacidad pública
