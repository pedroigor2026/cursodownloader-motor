const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');

// Modo DRM: quando a plataforma bloqueia o download (Hotmart/Kiwify), a saída é
// gravar a tela enquanto a aula toca. O usuário loga e vai para a 1ª aula; o app
// grava cada aula, detecta o fim e avança sozinho — aula a aula.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitizar(nome) {
  return (nome || 'aula').replace(/[<>:"/\\|?*\n]/g, '_').trim().substring(0, 60);
}

async function abrirNavegador(dataDir, oculto) {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) { throw new Error('Playwright não instalado.'); }

  const profileDir = path.join(dataDir, 'profiles', 'drm');
  await fs.ensureDir(profileDir);
  // oculto: janela fora da tela (funciona igual, mas não atrapalha o uso do PC).
  const janela = oculto ? ['--window-position=-32000,-32000', '--window-size=1366,900', '--mute-audio'] : ['--start-maximized'];
  const opts = {
    headless: false,
    viewport: oculto ? { width: 1366, height: 900 } : null,
    // A rede do Pedro intercepta TLS (antivírus/proxy) — sem isso, ctx.request.get (usado pra baixar
    // PDFs/materiais) falha com "unable to verify the first certificate". Aplica ao page E ao request.
    ignoreHTTPSErrors: true,
    args: [...janela, '--disable-blink-features=AutomationControlled',
      // some com o balão "restaurar páginas" e barras de aviso ao reabrir
      '--disable-session-crashed-bubble', '--hide-crash-restore-bubble', '--disable-infobars', '--no-first-run'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  for (const channel of ['msedge', 'chrome']) {
    try {
      const ctx = await chromium.launchPersistentContext(profileDir, { ...opts, channel });
      return ctx;
    } catch (_) { /* tenta o próximo */ }
  }
  return chromium.launchPersistentContext(profileDir, opts);
}

async function progressoVideo(page) {
  try {
    return await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      return { current: v.currentTime, duration: v.duration, paused: v.paused, ended: v.ended,
        pct: v.duration > 0 ? (v.currentTime / v.duration) * 100 : 0 };
    });
  } catch (_) { return null; }
}

async function garantirPlay(page) {
  try { await page.evaluate(() => { const v = document.querySelector('video'); if (v && v.paused && !v.ended) v.play(); }); }
  catch (_) {}
}

async function proximaAula(page) {
  const antes = page.url();
  const avancou = () => page.url() !== antes; // só conta como avanço se a URL mudou de aula
  // 1) botão/link por TEXTO explícito (varejoativo/Curseduca e afins usam "Próxima aula")
  for (const t of ['Próxima aula', 'Próxima Aula', 'Próxima', 'Avançar', 'Next lesson', 'Next']) {
    try {
      const loc = page.locator(`a:has-text("${t}"), button:has-text("${t}")`).first();
      if ((await loc.count()) && (await loc.isVisible())) {
        await loc.click({ timeout: 3000 }); await page.waitForTimeout(2500);
        if (avancou()) return true;
      }
    } catch (_) {}
  }
  // 2) seletores por classe/aria
  const seletores = [
    '[class*="next"]', '[aria-label*="próxima"]', '[aria-label*="Próxima"]', '[aria-label*="next"]',
    '[data-testid="next-lesson"]', '[data-purpose="go-to-next"]', '.next-button',
    'button[class*="next"]', 'a[class*="next"]', '[class*="nextLesson"]', '[class*="proxima"]',
  ];
  for (const sel of seletores) {
    try {
      const btn = await page.$(sel);
      if (btn && (await btn.isVisible())) { await btn.click(); await page.waitForTimeout(2500); if (avancou()) return true; }
    } catch (_) {}
  }
  // 3) seta direita (só vale se a URL realmente mudou)
  try { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(2000); } catch (_) {}
  return avancou();
}

function gravarTela(destDir, nomeAula, ffmpeg) {
  const arquivo = path.join(destDir, sanitizar(nomeAula) + '.mp4');
  const proc = spawn(ffmpeg, ['-y', '-f', 'gdigrab', '-framerate', '15', '-i', 'desktop',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', arquivo],
    { stdio: 'ignore' });
  return { proc, arquivo };
}

// Grava o curso inteiro a partir da aba já aberta na 1ª aula.
async function gravarCurso(page, config, nomeCurso, ffmpeg, onEvent, getParar) {
  const destDir = path.join(config.destino, 'gravados', sanitizar(nomeCurso));
  await fs.ensureDir(destDir);
  onEvent({ tipo: 'log', msg: `Gravando em: ${destDir}` });

  let aulaNum = 1;
  const maxAulas = 500;
  while (aulaNum <= maxAulas) {
    if (getParar()) break;
    let titulo = `${String(aulaNum).padStart(3, '0')}`;
    try { const t = await page.title(); if (t) titulo += ' - ' + t.substring(0, 50); } catch (_) {}
    onEvent({ tipo: 'aula', num: aulaNum, titulo });

    await sleep(1500);
    await garantirPlay(page);
    const { proc } = gravarTela(destDir, titulo, ffmpeg);
    let semProgresso = 0, ultimo = -1;

    while (true) {
      if (getParar()) break;
      await sleep(5000);
      const p = await progressoVideo(page);
      if (!p) { onEvent({ tipo: 'log', msg: 'Sem vídeo (texto/quiz?) — avançando.' }); break; }
      onEvent({ tipo: 'progresso', pct: p.pct, aula: aulaNum });
      if (p.ended || p.pct >= 98) break;
      if (p.paused) await garantirPlay(page);
      if (Math.abs(p.current - ultimo) < 1 && !p.paused) { if (++semProgresso > 4) { await garantirPlay(page); semProgresso = 0; } }
      else semProgresso = 0;
      ultimo = p.current;
    }

    try { proc.kill('SIGINT'); } catch (_) {}
    await sleep(1500);
    onEvent({ tipo: 'aula_fim', num: aulaNum });

    if (getParar()) break;
    const avancou = await proximaAula(page);
    if (!avancou) { onEvent({ tipo: 'log', msg: 'Não achei próxima aula — fim do curso.' }); break; }
    aulaNum++;
    await sleep(3000);
  }
  onEvent({ tipo: 'fim', aulas: aulaNum });
  return destDir;
}

module.exports = { abrirNavegador, gravarCurso, proximaAula, garantirPlay };
