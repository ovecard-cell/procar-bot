// Scraper de Facebook Marketplace usando Playwright.
// Lee conversaciones nuevas de Marketplace, las pasa por procesarMensaje
// (canal: 'marketplace') y responde escribiendo en el composer de Messenger.
//
// Modos de uso:
//   1) Como módulo (recomendado): require('./marketplace-scraper')
//      y usar iniciar(), detener(), getEstado(), getLogs(), iniciarLogin(),
//      tandaAhora(). Esto se controla desde el panel admin.
//   2) Como CLI legacy: `node marketplace-scraper.js [--login] [--visible]`.
//
// Selectores: Facebook cambia seguido. Si deja de leer mensajes, ajustar
// `leerConversacionesNuevas` y `responderEnConversacion`.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { chromium } = require('playwright');

const PROFILE_DIR = path.join(__dirname, 'playwright-profile');
const SEEN_FILE = path.join(__dirname, 'marketplace-seen.json');
const INTERVALO_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const MAX_LOGS = 200;

// La PC agencia le pega a Railway para procesar mensajes y mandar heartbeat.
const RAILWAY_URL = (process.env.RAILWAY_URL || '').replace(/\/$/, '');
const MARKETPLACE_SECRET = process.env.MARKETPLACE_SECRET || 'cambia-esto-en-railway';
const MODO_REMOTO = !!RAILWAY_URL;

async function procesarMensajeRemoto(senderId, texto) {
  const { data } = await axios.post(`${RAILWAY_URL}/api/marketplace/procesar`,
    { senderId, texto, secret: MARKETPLACE_SECRET },
    { timeout: 60000 });
  return data.respuesta;
}

let logsPendientes = []; // logs aún no enviados a Railway

async function enviarHeartbeat() {
  if (!MODO_REMOTO) return;
  try {
    const logsNuevos = logsPendientes.splice(0);
    await axios.post(`${RAILWAY_URL}/api/marketplace/heartbeat`, {
      secret: MARKETPLACE_SECRET,
      estado,
      logsNuevos,
    }, { timeout: 10000 });
  } catch (err) {
    // si falla, los logs quedan perdidos pero no rompemos el scraper
  }
}

// Estado en memoria del scraper (cuando corre embebido en el server).
const estado = {
  corriendo: false,
  loginAbierto: false,
  ultimaTanda: null,
  proximaTanda: null,
  ultimoError: null,
  conversacionesUltima: 0,
  respondidasUltima: 0,
  logueado: fs.existsSync(PROFILE_DIR) && fs.readdirSync(PROFILE_DIR).length > 0,
};
const logs = [];
let pararSolicitado = false;
let loopPromise = null;
let loginCtx = null;

function log(nivel, msg) {
  const linea = { ts: Date.now(), nivel, msg };
  logs.push(linea);
  logsPendientes.push(linea);
  if (logs.length > MAX_LOGS) logs.shift();
  const tag = nivel === 'error' ? '[Marketplace ERROR]' : '[Marketplace]';
  if (nivel === 'error') console.error(tag, msg);
  else console.log(tag, msg);
}

function cargarSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function guardarSeen(set) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...set]));
}

async function abrirContexto(headless = true) {
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

async function leerConversacionesNuevas(page) {
  await page.goto('https://www.facebook.com/messages/t/?folder=marketplace', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const conversaciones = await page.$$eval('a[href*="/messages/t/"]', (links) => {
    const vistos = new Set();
    return links
      .map(a => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/messages\/t\/([^/?#]+)/);
        if (!m) return null;
        const threadId = m[1];
        if (vistos.has(threadId)) return null;
        vistos.add(threadId);
        const senderName = (a.textContent || '').trim().split('\n')[0].slice(0, 80);
        return { threadId, senderName, threadUrl: 'https://www.facebook.com' + href };
      })
      .filter(Boolean);
  });

  return conversaciones;
}

async function leerUltimoMensajeCliente(page, threadUrl) {
  await page.goto(threadUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const ultimo = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[role="row"]'));
    if (rows.length === 0) return null;
    const lastRow = rows[rows.length - 1];
    const texto = (lastRow.textContent || '').trim();
    if (/^(tú|tu|you)\s+(enviaste|sent)/i.test(texto)) return null;
    return texto.slice(0, 2000);
  });

  return ultimo;
}

async function responderEnConversacion(page, texto) {
  const selector = 'div[contenteditable="true"][role="textbox"]';
  await page.waitForSelector(selector, { timeout: 10000 });
  const composer = await page.$(selector);
  if (!composer) throw new Error('No encontré el composer de Messenger');
  await composer.click();
  await composer.type(texto, { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
}

async function procesarTanda(opciones = {}) {
  const visible = !!opciones.visible;
  const seen = cargarSeen();
  const ctx = await abrirContexto(!visible);
  const page = ctx.pages()[0] || await ctx.newPage();

  let respondidas = 0;
  let total = 0;

  try {
    const conversaciones = await leerConversacionesNuevas(page);
    total = conversaciones.length;
    log('info', `${total} conversaciones detectadas`);

    for (const conv of conversaciones) {
      if (pararSolicitado) { log('info', 'Tanda cortada por pedido de detener'); break; }
      const texto = await leerUltimoMensajeCliente(page, conv.threadUrl);
      if (!texto) continue;

      const key = `${conv.threadId}::${texto}`;
      if (seen.has(key)) continue;

      log('info', `Mensaje nuevo de ${conv.senderName}: ${texto.slice(0, 100)}`);

      try {
        const senderId = `marketplace_${conv.threadId}`;
        let respuesta;
        if (MODO_REMOTO) {
          respuesta = await procesarMensajeRemoto(senderId, texto);
        } else {
          // Modo standalone: procesa local (mismo proceso). Útil si todo corre en una PC.
          const { procesarMensaje } = require('./agente');
          respuesta = await procesarMensaje(senderId, texto, 'marketplace');
        }
        if (respuesta) {
          await responderEnConversacion(page, respuesta);
          respondidas++;
          log('info', `Respondido a ${conv.senderName}`);
        }
        seen.add(key);
        guardarSeen(seen);
      } catch (err) {
        log('error', `Error procesando ${conv.threadId}: ${err.message}`);
      }
    }
  } finally {
    estado.ultimaTanda = Date.now();
    estado.conversacionesUltima = total;
    estado.respondidasUltima = respondidas;
    await ctx.close();
  }
}

async function loopInterno() {
  while (!pararSolicitado) {
    const inicio = Date.now();
    try {
      await procesarTanda();
      estado.ultimoError = null;
    } catch (err) {
      estado.ultimoError = err.message;
      log('error', `Error en tanda: ${err.message}`);
    }
    if (pararSolicitado) break;
    const transcurrido = Date.now() - inicio;
    const espera = Math.max(0, INTERVALO_MS - transcurrido);
    estado.proximaTanda = Date.now() + espera;
    log('info', `Próxima tanda en ${Math.round(espera / 1000)}s`);
    // Sleep en pasos chicos para que detener() reaccione rápido.
    const pasos = Math.ceil(espera / 1000);
    for (let i = 0; i < pasos; i++) {
      if (pararSolicitado) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  estado.corriendo = false;
  estado.proximaTanda = null;
  log('info', 'Scraper detenido');
}

let heartbeatTimer = null;
function iniciar() {
  if (estado.corriendo) return { ok: false, msg: 'Ya está corriendo' };
  if (loginCtx) return { ok: false, msg: 'Hay una ventana de login abierta, cerrala primero' };
  pararSolicitado = false;
  estado.corriendo = true;
  estado.ultimoError = null;
  log('info', `Scraper iniciado${MODO_REMOTO ? ' (modo remoto → ' + RAILWAY_URL + ')' : ' (modo local)'}`);
  if (MODO_REMOTO && !heartbeatTimer) {
    enviarHeartbeat();
    heartbeatTimer = setInterval(enviarHeartbeat, HEARTBEAT_MS);
  }
  loopPromise = loopInterno();
  return { ok: true };
}

async function detener() {
  if (!estado.corriendo) return { ok: false, msg: 'No estaba corriendo' };
  pararSolicitado = true;
  log('info', 'Pidiendo detener…');
  try { if (loopPromise) await loopPromise; } catch {}
  return { ok: true };
}

async function tandaAhora() {
  if (estado.corriendo) return { ok: false, msg: 'El loop ya está corriendo, esperá la próxima tanda' };
  if (loginCtx) return { ok: false, msg: 'Cerrá la ventana de login primero' };
  log('info', 'Tanda manual solicitada');
  try {
    await procesarTanda();
    return { ok: true };
  } catch (err) {
    log('error', `Tanda manual falló: ${err.message}`);
    return { ok: false, msg: err.message };
  }
}

async function iniciarLogin() {
  if (estado.corriendo) return { ok: false, msg: 'Detené el scraper antes de loguearte' };
  if (loginCtx) return { ok: false, msg: 'Ya hay una ventana de login abierta' };
  log('info', 'Abriendo navegador para login de Facebook…');
  try {
    loginCtx = await abrirContexto(false);
    estado.loginAbierto = true;
    const page = loginCtx.pages()[0] || await loginCtx.newPage();
    await page.goto('https://www.facebook.com/login');
    // Cuando el usuario cierra el navegador, marcamos como logueado.
    loginCtx.on('close', () => {
      loginCtx = null;
      estado.loginAbierto = false;
      estado.logueado = true;
      log('info', 'Navegador de login cerrado, sesión guardada');
    });
    return { ok: true };
  } catch (err) {
    loginCtx = null;
    estado.loginAbierto = false;
    log('error', `No pude abrir el navegador: ${err.message}`);
    return { ok: false, msg: err.message };
  }
}

function getEstado() {
  return { ...estado };
}

function getLogs(desde = 0) {
  return logs.filter(l => l.ts > desde);
}

module.exports = { iniciar, detener, tandaAhora, iniciarLogin, getEstado, getLogs };

// Modo CLI legacy: `node marketplace-scraper.js [--login] [--visible]`
if (require.main === module) {
  const visible = process.argv.includes('--visible');
  if (process.argv.includes('--login')) {
    (async () => {
      const ctx = await abrirContexto(false);
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.goto('https://www.facebook.com/login');
      console.log('[Login] Logueate y cerrá el navegador cuando termines.');
      await new Promise(() => {});
    })().catch(err => { console.error(err); process.exit(1); });
  } else {
    // Arranca el loop normal usando iniciar() — esto activa heartbeat si hay RAILWAY_URL.
    if (visible) console.log('[Marketplace] modo --visible: el navegador se abrirá visible');
    iniciar();
  }
}
