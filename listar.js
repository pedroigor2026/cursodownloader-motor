// Lista os cursos comprados de uma plataforma (área de membros logada), pra o app mostrar
// a lista pronta com checkbox. Hotmart via API club-drive-api/purchase (paginada por scroll).
const { abrirNavegador } = require('./gravador');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listarHotmart(ctx, page, onLog) {
  const cursos = new Map();
  ctx.on('response', async (res) => {
    if (!/club-drive-api\/rest\/v\d\/purchase\//i.test(res.url())) return;
    try {
      const j = await res.json();
      for (const it of (j.data || [])) {
        const p = it.product; if (!p) continue;
        const club = p.hotmartClub;
        if (club && club.link) cursos.set(p.id, { nome: p.name, autor: (p.seller && p.seller.name) || '', tamanho: (it.purchase && it.purchase.totalContentsSize) || 0, url: club.link, plataforma: 'hotmart' });
      }
    } catch (_) {}
  });
  await page.goto('https://hotmart.com/pt-br/area-de-membros', { waitUntil: 'domcontentloaded' }).catch(() => {});
  onLog && onLog('Abrindo seus cursos… se pedir login, faça login na janela.');
  // espera aparecer o 1º curso (dá tempo de logar)
  const t0 = Date.now();
  while (cursos.size === 0 && Date.now() - t0 < 180000) await sleep(1000);
  // rola a página pra carregar as próximas páginas (lazy load)
  let antes = -1;
  for (let i = 0; i < 30 && cursos.size !== antes; i++) {
    antes = cursos.size;
    try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch (_) {}
    await sleep(1800);
    onLog && onLog(`${cursos.size} curso(s) encontrado(s)…`);
  }
  return [...cursos.values()];
}

async function listarCursos(plataforma, dataDir, onLog) {
  const ctx = await abrirNavegador(dataDir);
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    let lista = [];
    if (plataforma === 'hotmart') lista = await listarHotmart(ctx, page, onLog);
    else throw new Error(`Listagem ainda não implementada para ${plataforma}`);
    return lista;
  } finally {
    await ctx.close().catch(() => {});
  }
}

module.exports = { listarCursos };

// teste manual: node core/listar.js hotmart
if (require.main === module) {
  const plat = process.argv[2] || 'hotmart';
  const DATA = 'C:\\Users\\PEDRO IGOR\\AppData\\Roaming\\curso-downloader';
  listarCursos(plat, DATA, (m) => console.log('[log]', m)).then((lista) => {
    console.log(`\n=== ${lista.length} CURSOS ===`);
    lista.forEach((c, i) => console.log(`${i + 1}. ${c.nome}\n   ${c.url}`));
    process.exit(0);
  }).catch((e) => { console.log('ERRO:', e.message); process.exit(1); });
}
