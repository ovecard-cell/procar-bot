/* Procar Chat Widget — embed en cualquier sitio.
 * Uso: <script src="https://procar-bot-production.up.railway.app/widget.js" async></script>
 * Inyecta un botón flotante abajo a la derecha que abre un iframe con el chat.
 */
(function () {
  if (window.__procarWidgetCargado) return;
  window.__procarWidgetCargado = true;

  // Detectamos el host desde donde se cargó este script.
  const me = document.currentScript || (function () {
    const ss = document.getElementsByTagName('script');
    return ss[ss.length - 1];
  })();
  const SRC = me && me.src ? me.src : 'https://procar-bot-production.up.railway.app/widget.js';
  const HOST = SRC.replace(/\/widget\.js.*$/, '');

  const css = `
    #procar-fab { position:fixed; right:20px; bottom:20px; width:60px; height:60px; border-radius:50%;
      background:#C9A84C; color:#1a1a2e; border:none; cursor:pointer; box-shadow:0 4px 14px rgba(0,0,0,0.3);
      font-size:28px; line-height:1; display:flex; align-items:center; justify-content:center;
      z-index:2147483647; transition:transform .15s; }
    #procar-fab:hover { transform:scale(1.08); }
    #procar-frame-wrap { position:fixed; right:20px; bottom:90px; width:360px; height:520px; max-width:calc(100vw - 40px);
      max-height:calc(100vh - 110px); background:#0f0f1a; border-radius:12px; overflow:hidden;
      box-shadow:0 8px 30px rgba(0,0,0,0.4); display:none; z-index:2147483647; }
    #procar-frame-wrap.abierto { display:block; }
    #procar-frame-wrap iframe { width:100%; height:100%; border:0; display:block; }
    @media (max-width: 480px) {
      #procar-frame-wrap { right:10px; bottom:80px; width:calc(100vw - 20px); height:calc(100vh - 100px); }
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const fab = document.createElement('button');
  fab.id = 'procar-fab';
  fab.title = 'Chat con Procar';
  fab.innerHTML = '💬';
  document.body.appendChild(fab);

  const wrap = document.createElement('div');
  wrap.id = 'procar-frame-wrap';
  document.body.appendChild(wrap);

  let cargado = false;
  fab.addEventListener('click', () => {
    if (!cargado) {
      const ifr = document.createElement('iframe');
      ifr.src = HOST + '/widget.html';
      ifr.allow = 'clipboard-write';
      wrap.appendChild(ifr);
      cargado = true;
    }
    const abierto = wrap.classList.toggle('abierto');
    fab.innerHTML = abierto ? '×' : '💬';
    fab.style.fontSize = abierto ? '32px' : '28px';
  });
})();
