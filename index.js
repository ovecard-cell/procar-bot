require('dotenv').config();
const express = require('express');
const { inicializarDB, cargarAutosEjemplo, buscarAutos } = require('./database');
const { procesarMensaje } = require('./agente');
const { verificarWebhook, recibirMensaje } = require('./webhook');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Inicializar base de datos al arrancar
inicializarDB();
cargarAutosEjemplo();

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/demo.html');
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Ver inventario
app.get('/autos', async (req, res) => {
  try {
    const autos = await buscarAutos();
    res.json(autos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook de WhatsApp — verificación
app.get('/webhook', verificarWebhook);

// Webhook de WhatsApp — recibir mensajes
app.post('/webhook', recibirMensaje);

// Probar el agente desde el navegador o Postman
// POST /chat  { "telefono": "5491100000000", "mensaje": "hola" }
app.post('/chat', async (req, res) => {
  const { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) {
    return res.status(400).json({ error: 'Faltan campos: telefono y mensaje' });
  }
  try {
    const respuesta = await procesarMensaje(telefono, mensaje);
    res.json({ respuesta });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
server.keepAliveTimeout = 65000;
