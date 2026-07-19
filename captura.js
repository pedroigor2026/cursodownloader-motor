// Baixa cursos protegidos (Hotmart/Kiwify): o yt-dlp não entende essas páginas.
// Hotmart: usa a API interna /v1/navigation (lista todas as aulas) e navega por URL,
// capturando o HLS real (.m3u8) de cada aula. Kiwify/outros: navega clicando "próxima".
// Só funciona sem DRM (playDrm:false), que é o caso desses cursos.
const path = require('path');
const fs = require('fs-extra');
const readline = require('readline');
const { spawn } = require('child_process');
const { garantirTudo, caBundlePath } = require('./binaries');
const { abrirNavegador, proximaAula } = require('./gravador');
const { matarArvore } = require('./proc');
const prioridade = require('./prioridade');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sanitizar = (n) => (n || 'aula').replace(/[<>:"/\\|?*\n\r]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 70);

const STUB_BYTES = 300 * 1024; // abaixo disso não é aula, é stub (o Panda entrega 6s / ~90KB)

// A aula já está no disco? Compara pelo TÍTULO, ignorando o número da frente.
// (A plataforma adiciona aulas: o módulo saiu de 402 pra 403 aulas e TODA a numeração andou —
// pelo nome completo, 24 aulas já baixadas seriam re-baixadas com outro número, duplicadas.)
function arquivoDaAula(arquivos, titulo) {
  const alvo = `${sanitizar(titulo)}.mp4`.toLowerCase();
  return arquivos.find((f) => f.toLowerCase().replace(/^\d+\s*-\s*/, '') === alvo) || null;
}

// Panda: o iframe do player (player-vz-<hash>.tv.pandavideo.com.br/embed/?v=<id>) dá o m3u8 sem play:
// o host de mídia é o mesmo com b-vz-. O jeito robusto é o MASTER limpo /<id>/playlist.m3u8 (sem
// token) — o yt-dlp lê as variantes e pega a melhor sozinho. Isso resolve os DOIS esquemas de nome
// de pasta que o Panda usa: /720p/video.m3u8 E /1280x720/video.m3u8 (adivinhar "720p" falhava nos
// cursos do 2º esquema — todas as aulas davam 302/0KB). As resoluções fixas ficam só de reserva.
// (O stub de 6s vinha do playlist.m3u8?token=... — o master SEM query vem completo.)
async function acharPanda(page, getCancelado) {
  for (let t = 0; t < 15; t++) {
    const src = await page.evaluate(() => {
      const f = [...document.querySelectorAll('iframe')].map((i) => i.src || i.getAttribute('src') || '').find((s) => /player-vz-.*pandavideo/i.test(s));
      return f || null;
    }).catch(() => null);
    if (src) {
      const u = new URL(src);
      const id = u.searchParams.get('v');
      if (id) {
        const host = u.host.replace(/^player-vz-/, 'b-vz-');
        const base = `https://${host}/${id}`;
        return {
          videoId: id, // UUID do vídeo no Panda = IDENTIDADE do conteúdo (a mesma gravação pode
          // aparecer em 2 aulas diferentes com esse mesmo id — é como não re-baixar o conteúdo).
          referer: `https://${u.host}/`,
          urls: [
            `${base}/playlist.m3u8`, // master limpo: yt-dlp escolhe a melhor variante (qualquer nome)
            `${base}/1080p/video.m3u8`, `${base}/720p/video.m3u8`, // reserva (se o master falhar)
            `${base}/480p/video.m3u8`, `${base}/360p/video.m3u8`,
          ],
        };
      }
    }
    if (getCancelado && getCancelado()) return null;
    await sleep(1000);
  }
  return null;
}

// Escolhe o m3u8 pra baixar. Preferir a MEDIA PLAYLIST de maior resolução (ex.: 720p/video.m3u8),
// que tem os segmentos reais. NÃO usar o "playlist.m3u8" master do Panda: ele é obfuscado e às vezes
// aponta pra outro vídeo (block_download), o que fazia o yt-dlp baixar só 1-2 segmentos (~6s).
function escolherMaster(urls) {
  const m3u8 = urls.filter((u) => /\.m3u8/i.test(u));
  const res = (u) => { const m = u.match(/(\d{3,4})p/); return m ? parseInt(m[1], 10) : 0; };
  // Panda com ?token= devolve o STUB de 6s; a mesma URL sem query vem completa (CDN público).
  // Só o Panda — em SmartPlayer/outros o token é obrigatório.
  const semToken = (u) => (/pandavideo/i.test(u) ? u.split('?')[0] : u);
  // variantes de vídeo por resolução (segmentos reais) — evita áudio-only
  const variantes = m3u8.filter((u) => /\d{3,4}p/i.test(u) && !/audio|_a\d|\d+k\.m3u8|_en_|_pt_\d+k/i.test(u));
  if (variantes.length) return semToken(variantes.slice().sort((a, b) => res(b) - res(a))[0]);
  // HLS master. A Hotmart (player próprio, vod-akm.play.hotmart.com) nomeia o master como
  // "master-pkg-t-<num>.m3u8" — não é "master.m3u8" exato nem tem "720p". O yt-dlp lê esse master
  // e escolhe a melhor variante sozinho. Mantém o token (?hdnts=) — na Hotmart ele é obrigatório.
  const master = m3u8.find((u) => /master[-.\w]*\.m3u8/i.test(u));
  if (master) return master;
  // NÃO usar playlist.m3u8 do Panda: fora do player ele devolve um stub de ~6s (block_download).
  return null;
}

// Escuta o tráfego até aparecer um master de verdade (resolve na hora) ou o timeout.
function capturarMaster(context, getCancelado, timeoutMs) {
  return new Promise((resolve) => {
    const urls = [];
    const referers = {};
    const onReq = (req) => {
      const u = req.url();
      if (/\.m3u8/i.test(u)) { urls.push(u); try { referers[u] = req.headers()['referer'] || null; } catch (_) {} }
    };
    context.on('request', onReq);
    const t0 = Date.now();
    const timer = setInterval(() => {
      const atual = escolherMaster(urls); // não-nulo = já achou variante/master bom (não o stub playlist.m3u8)
      if (atual || Date.now() - t0 > timeoutMs || (getCancelado && getCancelado())) {
        clearInterval(timer); context.off('request', onReq);
        const e = escolherMaster(urls);
        resolve({ master: e, referer: e ? referers[e] : null });
      }
    }, 500);
  });
}

// Ouve os m3u8 desde JÁ (attach imediato). CRÍTICO: players com autoplay (ex.: Hotmart, iframe com
// autoplay=true) pedem o master no INSTANTE em que a página carrega — muito antes de qualquer play
// nosso. Se o ouvinte só liga depois, esse pedido se perde e nunca acha o vídeo. Por isso a escuta
// é ligada logo após abrir a aula, ANTES de acharPanda/esperas. `parar()` desliga.
function iniciarEscutaM3u8(context) {
  const urls = [];
  const referers = {};
  const onReq = (req) => {
    const u = req.url();
    if (/\.m3u8/i.test(u)) { urls.push(u); try { referers[u] = req.headers()['referer'] || null; } catch (_) {} }
  };
  context.on('request', onReq);
  return {
    urls, referers,
    master: () => { const m = escolherMaster(urls); return { master: m, referer: m ? referers[m] : null }; },
    parar: () => { try { context.off('request', onReq); } catch (_) {} },
  };
}

// Tenta obter o master de uma escuta já ligada, dando play em rodadas (players que só carregam o
// vídeo após interação). Se o autoplay já trouxe o master, resolve na 1ª checagem sem nem tocar.
async function obterMaster(page, getCancelado, escuta, rounds, msPorRound) {
  for (let k = 0; k < rounds; k++) {
    let r = escuta.master();
    if (r.master) return r;
    await darPlay(page);
    const t0 = Date.now();
    while (Date.now() - t0 < msPorRound) {
      r = escuta.master();
      if (r.master) return r;
      if (getCancelado && getCancelado()) return { master: null, referer: null };
      await sleep(500);
    }
  }
  return escuta.master();
}

// O Chrome bloqueia autoplay com som. Mudo + clique real libera o vídeo a tocar sozinho.
async function darPlay(page) {
  try { await page.mouse.click(640, 400); } catch (_) {}
  for (const f of page.frames()) {
    try {
      await f.evaluate(() => {
        document.querySelectorAll('video').forEach((v) => { v.muted = true; const p = v.play(); if (p) p.catch(() => {}); });
        const sels = ['button[aria-label*="lay" i]', '.vjs-big-play-button', '[class*="play-button"]',
          '[class*="playButton"]', 'button[title*="lay" i]', '[class*="playbacktogglebutton"]'];
        for (const s of sels) { const b = document.querySelector(s); if (b) { try { b.click(); } catch (_) {} } }
      });
    } catch (_) {}
  }
}

// Baixa um .m3u8 com o yt-dlp, emitindo progresso (pct/velocidade/ETA) pra UI.
// Arquivos em gravação NESTE instante — se o HD cair no meio, são os suspeitos de corrupção
// (a guarda de HD apaga os parciais deles pra aula re-baixar limpa).
const emEscrita = new Set();

function baixarM3u8(ytdlp, ffmpeg, master, referer, saida, aulaAtual, totalAulas, onEvent, getCancelado) {
  const bundle = caBundlePath();
  const env = { ...process.env };
  if (bundle) { env.SSL_CERT_FILE = bundle; env.REQUESTS_CA_BUNDLE = bundle; }
  // Tem aula ao vivo / live gravando? o curso baixa com teto de velocidade pra não roubar a banda.
  const teto = prioridade.limiteRate();
  // ARMADILHA: --limit-rate vale POR CONEXÃO. Com -N 8, um teto de 3M vira 24 MB/s — ou seja,
  // limite nenhum (medido: com "teto" ele baixou MAIS rápido que sem). Com teto, usa 1 conexão.
  const conexoes = teto ? '1' : '8';
  const args = [
    '--no-warnings', '--newline', '--no-check-certificates',
    '-N', conexoes, '--retries', '10', '--fragment-retries', '10', '--continue', '--no-overwrites',
    '--ffmpeg-location', ffmpeg, '--merge-output-format', 'mp4', '-o', saida,
    '--progress-template', 'PROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
  ];
  if (teto) args.push('--limit-rate', teto);
  // ATENÇÃO: download com teto NÃO mede banda — ele mede o próprio teto. Se contasse, o app leria
  // "3 MB/s", concluiria "rede fraca" e pararia os cursos por engano (foi o que aconteceu).
  const podeMedirBanda = !teto;
  if (referer) args.push('--referer', referer);
  args.push(master);
  const log = (m) => { try { fs.appendFileSync(path.join(path.dirname(saida), '_log.txt'), `${new Date().toISOString()} ${m}\n`); } catch (_) {} };
  log(`URL: ${master}\n  ref: ${referer}\n  saida: ${path.basename(saida)}`);
  const bytesAntes = fs.existsSync(saida) ? fs.statSync(saida).size : 0; // retomada não conta como banda
  const t0 = Date.now();
  emEscrita.add(saida);
  return new Promise((resolve) => {
    const proc = spawn(ytdlp, args, { env });
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (linha) => {
      if (!linha.startsWith('PROG|')) return;
      const [, pct, speed, eta] = linha.split('|');
      const p = parseFloat(pct) || 0;
      // % do curso inteiro = aulas já feitas + fração da aula atual, sobre o total
      const pctCurso = totalAulas ? Math.round((((aulaAtual - 1) + p / 100) / totalAulas) * 100) : null;
      onEvent({ tipo: 'progresso', pct: p, speed: (speed || '').trim(), eta: (eta || '').trim(), aulaAtual, totalAulas, pctCurso });
    });
    // Pausar = matar a ÁRVORE do yt-dlp. proc.kill() sozinho deixa o filho (PyInstaller) baixando.
    const timer = setInterval(() => { if (getCancelado && getCancelado()) { matarArvore(proc); clearInterval(timer); } }, 500);
    proc.on('close', (code) => {
      clearInterval(timer);
      emEscrita.delete(saida);
      let bytes = 0; try { bytes = fs.statSync(saida).size; } catch (_) {}
      const seg = (Date.now() - t0) / 1000;
      // MB/s reais desta aula — é isso que mede a banda do lugar onde o note está agora.
      // Só vale como medida de banda se o download foi SEM teto (senão mede o teto, não a linha).
      const mbs = podeMedirBanda && seg > 5 ? (bytes - bytesAntes) / 1048576 / seg : null;
      log(`  fim code=${code} ${Math.round(bytes / 1024)}KB${bytes > 0 && bytes < STUB_BYTES ? '  *** STUB ***' : ''}${mbs ? ` ${mbs.toFixed(1)}MB/s` : ''}`);
      resolve({ code, mbs });
    });
    proc.on('error', () => { clearInterval(timer); emEscrita.delete(saida); resolve({ code: -1 }); });
  });
}

// Extrai links de material (PDF/zip/doc/anexo) dos dados da aula (lessons API do Hotmart).
function urlsDeMaterial(lesson) {
  if (!lesson) return [];
  const urls = new Set();
  const html = lesson.content || '';
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const u = m[1];
    if (/\.pdf|\.zip|\.docx?|\.xlsx?|\.pptx?|api-club-file|\/files\//i.test(u)) urls.add(u);
  }
  for (const at of (lesson.attachments || lesson.materials || [])) {
    const u = at.url || at.fileUrl || at.downloadUrl;
    if (u) urls.add(u);
  }
  for (const md of (lesson.medias || [])) if (md.type && md.type !== 'VIDEO' && md.url) urls.add(md.url);
  return [...urls];
}

// Baixa UM material (PDF/zip/doc) usando a sessão do navegador (cookies). Salva no destino.
async function baixarUmMaterial(ctx, u, destDir, prefixo, onEvent) {
  try {
    const resp = await ctx.request.get(u, { timeout: 60000 });
    if (!resp.ok()) return;
    const buf = await resp.body();
    if (!buf || buf.length < 100) return;
    const cd = resp.headers()['content-disposition'] || '';
    let fn = (cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i) || [])[1] || u.split('/').pop().split('?')[0] || 'material';
    try { fn = decodeURIComponent(fn); } catch (_) {}
    fn = sanitizar(fn);
    if (!/\.[a-z0-9]{2,5}$/i.test(fn)) fn += '.pdf';
    const destino = path.join(destDir, `${prefixo} - MAT - ${fn}`);
    if (await fs.pathExists(destino)) return; // já baixado
    await fs.writeFile(destino, buf);
    onEvent({ tipo: 'log', msg: `  material salvo: ${fn}` });
  } catch (_) {}
}

async function baixarMateriais(ctx, lesson, destDir, prefixo, onEvent) {
  for (const u of urlsDeMaterial(lesson)) await baixarUmMaterial(ctx, u, destDir, prefixo, onEvent);
}

// Materiais anexos da PÁGINA da aula (MemberKit/Strats): links "…/downloads/<id>" (PDF, apostila,
// caderno de atividades). Devolve as URLs absolutas encontradas na página aberta.
async function materiaisDaPagina(page) {
  return page.evaluate(() => [...new Set([...document.querySelectorAll('a')]
    .map((a) => a.href).filter((h) => /\/downloads?\/\d+/i.test(h)))]).catch(() => []);
}

const esperarAte = async (cond, timeoutMs) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < timeoutMs) await sleep(500);
  return cond();
};

async function baixarCursoViaCaptura(curso, config, dataDir, onEvent, getCancelado) {
  const { ytdlp, ffmpeg } = await garantirTudo((e) => onEvent({ tipo: 'setup', ...e }));
  const destDir = path.join(config.destino, sanitizar(curso.nome));
  // HD externo do destino pode sumir no meio (cabo puxado — 16/07 corrompeu o exFAT do E: assim).
  // Sem esta espera cada aula viraria "falha" e o curso iria pra "erro"; com ela a fila PAUSA e
  // retoma sozinha quando o HD volta. Checa a RAIZ do drive (a pasta pode ainda não existir).
  const raizDestino = path.parse(path.resolve(config.destino)).root;
  const destinoDisponivel = () => { try { fs.accessSync(raizDestino); return true; } catch (_) { return false; } };
  const esperarDestino = async () => {
    if (destinoDisponivel()) return true;
    const afetados = [...emEscrita]; // aulas que estavam GRAVANDO no instante da queda
    onEvent({ tipo: 'log', msg: `HD do destino (${raizDestino}) desconectado — downloads em espera. Reconecte o HD.` });
    while (!destinoDisponivel() && !(getCancelado && getCancelado())) await sleep(5000);
    if (!destinoDisponivel()) return false;
    // Arquivo interrompido no meio da gravação = suspeito de corrupção (caso 16/07: referência
    // cruzada no exFAT). Apaga o parcial — a aula re-baixa limpa sozinha (o skip é por índice).
    for (const s of afetados)
      for (const p of [s, s + '.part', s + '.ytdl', s.replace(/\.mp4$/i, '.temp.mp4')])
        { try { fs.removeSync(p); } catch (_) {} }
    onEvent({ tipo: 'hd_incidente', drive: raizDestino, interrompidos: afetados.length });
    onEvent({ tipo: 'log', msg: `HD reconectado — retomando. ${afetados.length ? `${afetados.length} download(s) interrompido(s) apagado(s) pra re-baixar limpo. ` : ''}O disco pode ter ficado corrompido — o app vai propor a correção.` });
    return true;
  };
  await esperarDestino();
  await fs.ensureDir(destDir);
  onEvent({ tipo: 'inicio', destino: destDir });

  const ctx = await abrirNavegador(dataDir, true); // oculto: janela fora da tela, não atrapalha o PC
  let navHotmart = null, cursoKiwify = null, cursoGreenn = null;
  const lessons = {}; // Hotmart: dados da aula (inclui materiais)
  ctx.on('response', async (res) => {
    const u = res.url();
    try {
      if (/\/v1\/navigation/i.test(u)) { const j = await res.json(); if (j && Array.isArray(j.modules) && j.modules.some((m) => (m.pages || []).length)) navHotmart = j; } // ignora a navegação vazia do club (multi-produto dispara 2x)
      else if (/\/v2\/web\/lessons\//i.test(u)) { const j = await res.json(); if (j && j.hash) lessons[j.hash] = j; }
      else if (/\/v1\/viewer\/courses\/[0-9a-f-]+(\?|$)/i.test(u)) { const j = await res.json(); if (j && j.course) cursoKiwify = j; }
      else if (/api\.greenn\.club\/course\/\d+\/watch/i.test(u)) { const j = await res.json(); if (j && j.course) cursoGreenn = j; }
    } catch (_) {}
  });

  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    onEvent({ tipo: 'log', msg: 'Abrindo o curso. Se pedir login, faça login na janela — depois é automático.' });
    await page.goto(curso.url, { waitUntil: 'domcontentloaded' }).catch(() => {});

    // Espera a lista de aulas (Hotmart/Kiwify/Greenn). Até 3 min pra dar tempo de logar.
    // Plataformas SEM essa API (ex.: varejoativo/Curseduca) não disparam nada — espera curta e vai pro fallback.
    const temApi = /hotmart\.com|kiwify|greenn\.club/i.test(curso.url || '');
    await esperarAte(() => navHotmart || cursoKiwify || cursoGreenn || (getCancelado && getCancelado()), temApi ? 180000 : 8000);

    let concluidas = 0;
    let falhas = 0;   // aulas onde havia vídeo mas o download falhou (trava de completude)
    let bloqueadas = 0; // aulas sem acesso na conta (não são falha — não há o que baixar)
    let total = null; // nº de aulas enumeradas pela API (null = plataforma sem enumeração)

    // Quantas aulas ao mesmo tempo e a que velocidade: quem decide é core/prioridade.js, com a
    // banda REAL medida aqui. Se tiver aula ao vivo rolando, ele manda a fila esperar (0).
    const limiteAtual = () => {
      const fixo = parseInt(config.downloads_paralelos, 10);
      if (fixo >= 1) return Math.min(fixo, 3); // o Pedro pode fixar no config, se quiser
      return prioridade.paralelasPermitidas();
    };
    const emAndamento = new Set();

    // Monta a lista de aulas unificada [{url, name, temVideo, hash?, materiais[]}] conforme a plataforma.
    let aulas = null;
    if (navHotmart && Array.isArray(navHotmart.modules)) {
      const base = curso.url.split('/content/')[0] + '/content/';
      aulas = [];
      for (const m of navHotmart.modules) for (const p of (m.pages || []))
        aulas.push({ url: base + p.hash, name: p.name, temVideo: !!p.hasPlayerMedia, hash: p.hash, materiais: [] });
    } else if (cursoKiwify && cursoKiwify.course) {
      const courseId = cursoKiwify.course.id;
      const clubId = (curso.url.match(/[?&]club=([^&]+)/) || [])[1] || '';
      const base = `https://members.kiwify.com/${courseId}/`;
      aulas = [];
      for (const mod of (cursoKiwify.course.modules || [])) for (const les of (mod.lessons || []))
        aulas.push({
          url: base + mod.id + '/' + les.id + (clubId ? '?club=' + clubId : ''),
          name: les.title, temVideo: !!les.video,
          materiais: (les.files || []).map((f) => f.url).filter(Boolean),
        });
    } else if (cursoGreenn && cursoGreenn.course) {
      // Greenn: <escola>.greenn.club/curso/<courseId>/modulo/<moduleId>/aula/<lessonId> (vídeo = Panda)
      const host = new URL(curso.url).origin;
      const courseId = cursoGreenn.course.id;
      const mods = cursoGreenn.modules || cursoGreenn.course.modules || [];
      aulas = [];
      for (const mod of mods) for (const les of (mod.lessons || mod.lesson || []))
        aulas.push({ url: `${host}/curso/${courseId}/modulo/${mod.id}/aula/${les.id}`, name: les.title || les.name, temVideo: true, materiais: [] });
    } else if (/vivapositivamente\.com\.br/i.test(curso.url)) {
      // MemberKit: a página do módulo (/‹id›-slug) lista as aulas (/‹id›-slug/‹aulaid›-slug). Vídeo = Panda HLS.
      try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (_) {}
      const mp = new URL(curso.url).pathname.replace(/\/$/, '');
      const origin = new URL(curso.url).origin;
      const hrefs = await page.evaluate((m) => [...new Set([...document.querySelectorAll('a')]
        .map((a) => a.getAttribute('href')).filter(Boolean)
        .filter((h) => h.startsWith(m + '/') && /^\d+-/.test(h.slice(m.length + 1)) && !/\/downloads?\//i.test(h)))], mp).catch(() => []);
      aulas = hrefs.map((h) => ({ url: origin + h, name: h.split('/').pop().replace(/^\d+-/, '').replace(/-/g, ' '), temVideo: true, materiais: [] }));
    }

    if (aulas) {
      // ── HOTMART / KIWIFY: percorre TODAS as aulas pela API (robusto, sem clicar) ──
      total = aulas.length;
      // Quantas já estão no disco: o card mostra o % do curso desde o primeiro segundo, sem
      // esperar o yt-dlp começar (antes o card ficava em "iniciando…" sem dizer nada).
      const arquivos = fs.readdirSync(destDir).filter((f) => f.toLowerCase().endsWith('.mp4'));
      // ÍNDICE de aulas já baixadas, por IDENTIDADE ÚNICA da aula (URL/hash), NÃO por título. É o que
      // impede re-download SEM perder conteúdo: duas aulas diferentes que só compartilham o título
      // (ex.: "Valuation" 19min vs 10min, ou "escala 02/07" 1h06 vs 1h56) têm chaves diferentes e
      // ambas baixam; a MESMA aula listada 2x (mesma URL) baixa uma vez só. `_baixadas.json`: {chave: arquivo}.
      const idxPath = path.join(destDir, '_baixadas.json');
      let indice = {};
      try { indice = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch (_) {}
      const salvarIndice = () => { try { fs.writeFileSync(idxPath, JSON.stringify(indice)); } catch (_) {} };
      const chaveAula = (a) => a.url || a.hash || a.name;
      const clamados = new Set(Object.values(indice));
      // Bootstrap de downloads ANTIGOS (sem índice): adota UM arquivo de mesmo título ainda não
      // reivindicado por outra chave. Assim os 160 já baixados não re-baixam, mas 2 vídeos de mesmo
      // título nunca reivindicam o mesmo arquivo (o 2º não acha livre → baixa de verdade).
      const adotarPorTitulo = (titulo) => {
        const alvo = sanitizar(titulo).toLowerCase();
        const f = arquivos.find((x) => !clamados.has(x) && x.toLowerCase().replace(/^\d+\s*-\s*/, '').replace(/\.mp4$/, '') === alvo);
        if (f) clamados.add(f);
        return f || null;
      };
      const jaNoDisco = arquivos.length;
      // Aulas que já sabemos estar bloqueadas: nem navega de novo (economiza 2s x N a cada passada).
      const arqBloq = path.join(destDir, '_aulas_bloqueadas.txt');
      const jaBloqueadas = new Set(fs.existsSync(arqBloq)
        ? fs.readFileSync(arqBloq, 'utf8').split('\n').map((l) => l.replace(/^\d+\s*-\s*/, '').trim()).filter(Boolean)
        : []);
      // % do curso = baixadas ÷ aulas que DÁ pra baixar (as bloqueadas na conta saem da conta,
      // senão a barra nunca chega perto de 100% e parece que o curso empacou).
      const pct = () => Math.round((concluidas / Math.max(1, aulas.length - bloqueadas)) * 100);
      onEvent({ tipo: 'curso_info', total: aulas.length, prontas: jaNoDisco, pctCurso: Math.round((jaNoDisco / aulas.length) * 100) });
      onEvent({ tipo: 'log', msg: `Curso com ${aulas.length} aula(s) — ${jaNoDisco} já baixada(s).` });
      for (let i = 0; i < aulas.length; i++) {
        if (getCancelado && getCancelado()) break;
        if (!(await esperarDestino())) break; // HD fora: espera voltar (Pausar cancela a espera)
        // Aula ao vivo rolando com a banda apertada: o curso ESPERA (não perde nada, retoma sozinho).
        let avisou = false;
        while (limiteAtual() === 0 && !(getCancelado && getCancelado())) {
          if (!avisou) { onEvent({ tipo: 'log', msg: 'Aula ao vivo gravando — cursos em espera (a banda é dela).' }); avisou = true; }
          await sleep(5000);
        }
        if (getCancelado && getCancelado()) break;
        const aula = aulas[i];
        const nome = `${String(i + 1).padStart(3, '0')} - ${sanitizar(aula.name)}`;
        const chave = chaveAula(aula);
        // Já baixada? Skip por IDENTIDADE (chave), não por título. Exato: nunca re-baixa a mesma
        // aula, nunca pula uma aula diferente que só tem o mesmo nome.
        if (indice[chave] && fs.existsSync(path.join(destDir, indice[chave]))) {
          concluidas++;
          onEvent({ tipo: 'aula_ok', concluidas, bloqueadas, aulaAtual: i + 1, totalAulas: aulas.length, pulada: true, pctCurso: pct() });
          continue;
        }
        // (A adoção de download antigo por título acontece DEPOIS de descobrir o vídeo — no bloco
        //  Panda — pra registrar também o ID do vídeo. Assim a mesma gravação em 2 aulas não re-baixa.)
        // Já sabíamos que esta é bloqueada (passada anterior): pula sem abrir a página.
        if (jaBloqueadas.has(sanitizar(aula.name))) {
          bloqueadas++;
          onEvent({ tipo: 'aula_ok', concluidas, bloqueadas, aulaAtual: i + 1, totalAulas: aulas.length, pctCurso: pct() });
          continue;
        }
        onEvent({ tipo: 'aula', aulaAtual: i + 1, totalAulas: aulas.length, aulaTitulo: aula.name, bloqueadas, pctCurso: pct() });

        await page.goto(aula.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        // Liga a escuta de m3u8 AGORA (antes de acharPanda/esperas): players com autoplay pedem o
        // master assim que a página carrega — se esperar, perde. parada no fim de cada caminho.
        const escuta = iniciarEscutaM3u8(ctx);
        await sleep(1800);
        if (aula.hash) await esperarAte(() => lessons[aula.hash] || (getCancelado && getCancelado()), 8000);

        // Procura o iframe do YouTube (com polling — carrega async). Hotmart marca aula com
        // vídeo do YouTube como hasPlayerMedia=false, por isso checamos mesmo quando temVideo é false.
        const acharYt = async (ms) => {
          for (let t = 0; t < ms; t += 1000) {
            const s = await page.evaluate(() => { const f = document.querySelector('iframe[src*="youtube.com/embed"], iframe[src*="youtube-nocookie.com/embed"], iframe[src*="youtu.be"]'); return f ? f.src : null; }).catch(() => null);
            if (s) return s;
            if (getCancelado && getCancelado()) return null;
            await sleep(1000);
          }
          return null;
        };
        const saida = path.join(destDir, nome + '.mp4');

        // Aula que a conta do Pedro não tem direito ("Conteúdo bloqueado... contate o instrutor"):
        // não há vídeo nenhum na página. Sem isso o app gastava 1 MINUTO por aula procurando um
        // vídeo que não existe (109 aulas = ~2h) e ainda contava como falha, o que impedia o curso
        // de fechar e fazia a fila repetir tudo 3x. Bloqueada não é falha: é conteúdo sem acesso.
        const bloqueada = await page.evaluate(() =>
          /conte[úu]do bloqueado|acesso bloqueado/i.test(document.body.innerText)).catch(() => false);
        if (bloqueada) {
          escuta.parar();
          bloqueadas++;
          fs.appendFileSync(path.join(destDir, '_aulas_bloqueadas.txt'), `${nome}\n`);
          onEvent({ tipo: 'log', msg: `  aula ${i + 1}: conteúdo bloqueado na sua conta — pulando.` });
          onEvent({ tipo: 'aula_ok', concluidas, bloqueadas, aulaAtual: i + 1, totalAulas: aulas.length, pctCurso: pct() });
          continue;
        }

        // Materiais anexos DESTA aula (PDF/apostila) — capturados agora, enquanto a página está
        // aberta. Baixados junto com o vídeo, dentro da tarefa (aula = vídeo + material, uma unidade).
        const matPagina = await materiaisDaPagina(page);

        // Panda: a URL do m3u8 sai do próprio iframe, sem depender de play (o play na janela oculta
        // falha na maioria das aulas) e sem ?token= (com token o Panda entrega um stub de 6s).
        const panda = await acharPanda(page, getCancelado);
        if (panda) {
          escuta.parar(); // Panda pega a URL do iframe, não precisa da escuta de tráfego
          // MESMO VÍDEO já baixado por OUTRA aula? (a plataforma às vezes lista a mesma gravação em
          // 2 páginas diferentes). O ID do vídeo é a identidade real do conteúdo — se já temos, não
          // re-baixa. Registra a chave desta aula apontando pro arquivo que já existe.
          const kv = 'vid:' + panda.videoId;
          // (1) mesmo VÍDEO já baixado por outra aula (2 páginas, 1 gravação) → não re-baixa.
          if (panda.videoId && indice[kv] && fs.existsSync(path.join(destDir, indice[kv]))) {
            indice[chave] = indice[kv]; salvarIndice();
            concluidas++;
            onEvent({ tipo: 'log', msg: `  aula ${i + 1}: mesmo vídeo de outra aula — não re-baixa.` });
            onEvent({ tipo: 'aula_ok', concluidas, bloqueadas, aulaAtual: i + 1, totalAulas: aulas.length, pctCurso: pct() });
            await sleep(500);
            continue;
          }
          // (2) download ANTIGO desta aula (sem índice ainda): adota o arquivo de mesmo título livre
          //     e registra AGORA a chave da aula E o ID do vídeo (já sabemos) → não re-baixa depois.
          const adotado = adotarPorTitulo(aula.name);
          if (adotado) {
            indice[chave] = adotado; if (panda.videoId) indice[kv] = adotado; salvarIndice();
            concluidas++;
            onEvent({ tipo: 'aula_ok', concluidas, bloqueadas, aulaAtual: i + 1, totalAulas: aulas.length, pulada: true, pctCurso: pct() });
            await sleep(300);
            continue;
          }
          // Baixa em PARALELO (o navegador já vai buscando a URL da próxima aula enquanto estas
          // baixam). Quantas ao mesmo tempo é decidido pela banda medida — ver limiteAtual().
          const tarefa = (async () => {
            let ok = false;
            // 1ª candidata é o master limpo (yt-dlp pega a melhor variante, qualquer esquema de
            // nome). As resoluções fixas ficam de reserva se o master falhar num vídeo específico.
            for (const cand of panda.urls) {
              let r = await baixarM3u8(ytdlp, ffmpeg, cand, panda.referer, saida, i + 1, aulas.length, onEvent, getCancelado);
              let bytes = fs.existsSync(saida) ? fs.statSync(saida).size : 0;
              // Baixou o vídeo quase todo e o yt-dlp errou no fim (fragmento/fixup): retoma de onde
              // parou (--continue) em vez de jogar fora 500MB e cair pra outra URL.
              for (let tent = 0; tent < 3 && r.code !== 0 && bytes > STUB_BYTES && !(getCancelado && getCancelado()); tent++) {
                onEvent({ tipo: 'log', msg: `  aula ${i + 1}: yt-dlp saiu com erro após ${Math.round(bytes / 1048576)}MB — retomando.` });
                r = await baixarM3u8(ytdlp, ffmpeg, cand, panda.referer, saida, i + 1, aulas.length, onEvent, getCancelado);
                bytes = fs.existsSync(saida) ? fs.statSync(saida).size : 0;
              }
              if (getCancelado && getCancelado()) return;
              if (r.code === 0 && bytes > STUB_BYTES) {
                ok = true;
                if (r.mbs) prioridade.registrarBanda(r.mbs);
                break;
              }
              fs.removeSync(saida); // stub ou URL inexistente: apaga e tenta a próxima
            }
            if (ok) {
              indice[chave] = nome + '.mp4'; // chave da aula (URL)
              if (panda.videoId) indice['vid:' + panda.videoId] = nome + '.mp4'; // identidade do vídeo
              salvarIndice(); // registra as duas → nunca re-baixa (nem outra aula do mesmo vídeo)
              concluidas++;
              onEvent({ tipo: 'aula_ok', concluidas, bloqueadas, aulaAtual: i + 1, totalAulas: aulas.length, pctCurso: pct() });
            } else { falhas++; onEvent({ tipo: 'log', msg: `  aula ${i + 1}: não consegui baixar o vídeo do Panda.` }); }
            await baixarMateriais(ctx, lessons[aula.hash], destDir, nome, onEvent);
            for (const murl of aula.materiais) await baixarUmMaterial(ctx, murl, destDir, nome, onEvent);
            for (const murl of matPagina) await baixarUmMaterial(ctx, murl, destDir, nome, onEvent);
          })();

          emAndamento.add(tarefa);
          tarefa.finally(() => emAndamento.delete(tarefa));
          // Pool cheio? espera a primeira aula terminar antes de ir buscar a próxima URL.
          while (emAndamento.size >= limiteAtual() && !(getCancelado && getCancelado())) {
            await Promise.race(emAndamento);
          }
          await sleep(2000); // respiro entre navegações (o Panda não gosta de rajada)
          continue;
        }

        // Sem vídeo Panda mas COM anexo: é uma aula só de material ("Material de Apoio do Módulo").
        // Baixa os arquivos e conta como concluída — não é falha de vídeo.
        if (matPagina.length) {
          escuta.parar();
          for (const murl of matPagina) await baixarUmMaterial(ctx, murl, destDir, nome, onEvent);
          concluidas++;
          onEvent({ tipo: 'aula_ok', concluidas, bloqueadas, aulaAtual: i + 1, totalAulas: aulas.length, pctCurso: pct() });
          await sleep(1500);
          continue;
        }

        // Download antigo desta aula (não-Panda): adota o arquivo de mesmo título livre e registra.
        const adotadoNP = adotarPorTitulo(aula.name);
        if (adotadoNP) {
          escuta.parar();
          indice[chave] = adotadoNP; salvarIndice();
          concluidas++;
          onEvent({ tipo: 'aula_ok', concluidas, bloqueadas, aulaAtual: i + 1, totalAulas: aulas.length, pulada: true, pctCurso: pct() });
          continue;
        }

        let alvo = null, ref = null;
        if (aula.temVideo) {
          // A escuta já está ligada desde o goto: se o autoplay trouxe o master, obterMaster resolve
          // na 1ª checagem; senão dá play em rodadas. (Hotmart: master-pkg vem no autoplay.)
          const cap = await obterMaster(page, getCancelado, escuta, 6, 6000);
          alvo = cap.master; ref = cap.referer;
          if (!alvo) alvo = await acharYt(6000); // fallback: YouTube mesmo marcado como player Hotmart
        } else {
          alvo = await acharYt(8000); // sem player Hotmart: costuma ser YouTube embutido
        }
        escuta.parar();
        if (getCancelado && getCancelado()) break;
        if (alvo) {
          if (/youtu/i.test(alvo)) onEvent({ tipo: 'log', msg: '  vídeo do YouTube.' });
          const r = await baixarM3u8(ytdlp, ffmpeg, alvo, ref, saida, i + 1, aulas.length, onEvent, getCancelado);
          if (r.code === 0) { indice[chave] = nome + '.mp4'; salvarIndice(); concluidas++; onEvent({ tipo: 'aula_ok', concluidas }); }
          else { falhas++; onEvent({ tipo: 'log', msg: `  download da aula ${i + 1} falhou (código ${r.code}).` }); }
        } else if (aula.temVideo) { falhas++; onEvent({ tipo: 'log', msg: `  não achei o vídeo da aula ${i + 1}.` }); }
        // materiais/PDFs: Hotmart vem da lessons API; Kiwify vem da lista (files da API)
        await baixarMateriais(ctx, lessons[aula.hash], destDir, nome, onEvent);
        for (const murl of aula.materiais) await baixarUmMaterial(ctx, murl, destDir, nome, onEvent);

        if (getCancelado && getCancelado()) break;
        await sleep((config.pausar_entre_videos || 3) * 1000);
      }
      // As últimas aulas ainda podem estar baixando (pool): o curso NÃO termina antes delas,
      // senão a trava de completude contaria errado e o curso sairia da fila incompleto.
      if (emAndamento.size) {
        onEvent({ tipo: 'log', msg: `Terminando ${emAndamento.size} aula(s) em andamento…` });
        await Promise.all(emAndamento);
      }
    } else {
      // ── Fallback: plataforma sem API conhecida → navega clicando "próxima" ──
      onEvent({ tipo: 'log', msg: 'Baixando aula a aula (avanço por navegação).' });
      let semVideo = 0;
      for (let n = 1; n <= 500; n++) {
        if (getCancelado && getCancelado()) break;
        if (!(await esperarDestino())) break; // HD fora: espera voltar (Pausar cancela a espera)
        // Escuta ligada ANTES do play (autoplay pode trazer o master já); SmartPlayer monta o <video>
        // com atraso, então também dá play em rodadas.
        const escutaFb = iniciarEscutaM3u8(ctx);
        await sleep(2000);
        const cap = await obterMaster(page, getCancelado, escutaFb, (n === 1 ? 14 : 5), 6000);
        escutaFb.parar();
        let master = cap.master, referer = cap.referer;
        if (!master) { if (++semVideo >= 3) break; }
        else {
          semVideo = 0;
          let titulo = String(n).padStart(3, '0');
          try { const t = await page.title(); if (t) titulo += ' - ' + sanitizar(t); } catch (_) {}
          const r = await baixarM3u8(ytdlp, ffmpeg, master, referer, path.join(destDir, titulo + '.mp4'), n, null, onEvent, getCancelado);
          if (getCancelado && getCancelado()) break;
          if (r.code === 0) { concluidas++; onEvent({ tipo: 'aula_ok', concluidas }); }
        }
        if (getCancelado && getCancelado()) break;
        await sleep((config.pausar_entre_videos || 3) * 1000);
        if (!(await proximaAula(page))) break;
      }
    }

    // A transcrição NÃO roda aqui — é feita globalmente pela fila (main.js), depois que
    // todos os downloads pendentes terminam, pra nunca travar o download de novos cursos.
    // Pausado pelo usuário: retorna cancelado pra o curso VOLTAR a 'pendente' (retoma de onde parou).
    if (getCancelado && getCancelado()) return { sucesso: concluidas > 0, cancelado: true, destino: destDir, concluidas, total, falhas };
    // TRAVA de completude: só é "completo" se enumerou (total!=null) e nenhuma aula de vídeo falhou.
    // Sem enumeração (fallback/varejoativo) => completo indefinido (null) → main decide.
    // total===0 = enumerou ZERO aulas (login caído / URL errada) — nunca é "completo".
    // Aula bloqueada na conta não conta como falha: se contasse, o curso jamais fecharia e a fila
    // ficaria repetindo a passagem inteira 3x até jogá-lo em "erro" — por nada.
    const completo = total == null ? null : (total > 0 && falhas === 0);
    if (bloqueadas) onEvent({ tipo: 'log', msg: `${bloqueadas} aula(s) bloqueada(s) na sua conta — lista em _aulas_bloqueadas.txt` });
    return {
      sucesso: concluidas > 0, destino: destDir, concluidas, total, falhas, bloqueadas, completo,
      erro: concluidas === 0 ? 'Nenhuma aula baixada. Faça login na janela e confira se a URL é do curso.' : undefined,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

module.exports = { baixarCursoViaCaptura, escolherMaster, urlsDeMaterial };

// self-check: node core/captura.js
if (require.main === module) {
  console.assert(escolherMaster(['https://x/720p/video.m3u8', 'https://x/playlist.m3u8']).includes('720p'), 'prefere variante 720p ao playlist stub');
  console.assert(escolherMaster(['https://x/480p/v.m3u8', 'https://x/1080p/v.m3u8']).includes('1080p'), 'pega maior resolução');
  console.assert(/master/.test(escolherMaster(['https://x/v.ts', 'https://x/master.m3u8'])), 'usa master.m3u8 real');
  console.assert(escolherMaster(['https://vod-akm.play.hotmart.com/video/ab/hls/master-pkg-t-123.m3u8?hdnts=tok', 'https://vod-akm.play.hotmart.com/video/ab/hls/ab-123-audio=1-video=2.m3u8']).includes('master-pkg'), 'Hotmart: pega master-pkg-...m3u8 (com token)');
  console.assert(escolherMaster(['https://x/playlist.m3u8']) === null, 'playlist.m3u8 sozinho (Panda stub) = null');
  console.assert(escolherMaster(['https://b-vz-x.tv.pandavideo.com.br/id/720p/video.m3u8?token=abc']) === 'https://b-vz-x.tv.pandavideo.com.br/id/720p/video.m3u8', 'Panda: tira o ?token= (com token vem stub de 6s)');
  console.assert(escolherMaster(['https://stream.smartplayer.io/id_720p.m3u8?token=abc']).includes('token=abc'), 'SmartPlayer: mantém o token');
  console.assert(escolherMaster(['https://x/a.ts']) === null, 'sem m3u8 = null');
  const arqs = ['210 - mentoria estrategica 14 05 2026.mp4', '001 - abertura.mp4'];
  console.assert(arquivoDaAula(arqs, 'mentoria estrategica 14 05 2026') === arqs[0], 'acha a aula pelo título mesmo se o número mudou');
  console.assert(arquivoDaAula(arqs, 'aula que não existe') === null, 'aula ausente = null');
  const mats = urlsDeMaterial({ content: 'veja <a href="https://x/apostila.pdf">aqui</a> e <a href="https://x/site">site</a>', attachments: [{ url: 'https://x/extra.zip' }] });
  console.assert(mats.includes('https://x/apostila.pdf') && mats.includes('https://x/extra.zip') && !mats.some((u) => u.endsWith('/site')), 'extrai só materiais');
  console.log('captura self-check OK');
}
