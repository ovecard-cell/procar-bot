require('dotenv').config();
const express = require('express');
const { inicializarDB, cargarAutosEjemplo, cargarVendedoresEjemplo } = require('./database');
const { verificarWebhook, recibirMensaje } = require('./webhook');

const app = express();
const PORT = process.env.PORT || 3000;

// Parsear JSON de los webhooks de Meta
app.use(express.json());

// Inicializar base de datos, inventario y vendedores
inicializarDB();
cargarAutosEjemplo();
cargarVendedoresEjemplo();

// Health check
app.get('/', (req, res) => {
  res.send('Bot Procar funcionando correctamente');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Webhook de Meta (WhatsApp + Instagram + Messenger)
app.get('/webhook', verificarWebhook);
app.post('/webhook', recibirMensaje);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor Procar Bot v1.1 corriendo en puerto ${PORT}`);
});
