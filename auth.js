const path = require('path');
const fs = require('fs-extra');

// Login guiado: abre um Chromium real, o usuário loga na plataforma, e salvamos os
// cookies em formato Netscape (o que o yt-dlp lê) + o perfil persistente.
async function fazerLogin(plataforma, loginUrl, dataDir, onEvent) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (_) {
    throw new Error('Playwright não instalado. Rode: npm run postinstall');
  }

  const cookiesDir = path.join(dataDir, 'cookies');
  const profileDir = path.join(dataDir, 'profiles', plataforma);
  await fs.ensureDir(cookiesDir);
  await fs.ensureDir(profileDir);

  onEvent && onEvent({ tipo: 'login_abrindo', plataforma });

  const context = await abrirNavegador(chromium, profileDir);

  const page = context.pages()[0] || (await context.newPage());
  if (loginUrl) await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // Espera o usuário fechar o navegador
  await new Promise((resolve) => {
    let feito = false;
    const done = () => { if (!feito) { feito = true; resolve(); } };
    context.on('close', done);
    page.on('close', () => setTimeout(done, 800));
  });

  const cookies = await context.cookies().catch(() => []);
  await fs.writeJSON(path.join(cookiesDir, `${plataforma}.json`), cookies, { spaces: 2 });
  await exportarNetscape(cookies, path.join(cookiesDir, `${plataforma}_cookies.txt`));
  await context.close().catch(() => {});

  onEvent && onEvent({ tipo: 'login_ok', plataforma, cookies: cookies.length });
  return cookies.length;
}

// Usa o Edge/Chrome já instalado na máquina (evita empacotar o Chromium de ~150MB).
// Cai para o Chromium do Playwright só se nenhum navegador do sistema existir.
async function abrirNavegador(chromium, profileDir) {
  const opts = {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  for (const channel of ['msedge', 'chrome']) {
    try { return await chromium.launchPersistentContext(profileDir, { ...opts, channel }); }
    catch (_) { /* tenta o próximo */ }
  }
  return chromium.launchPersistentContext(profileDir, opts); // Chromium empacotado (fallback)
}

async function exportarNetscape(cookies, arquivo) {
  const linhas = ['# Netscape HTTP Cookie File', '# CursoDownloader', ''];
  for (const c of cookies) {
    const expires = c.expires > 0 ? Math.floor(c.expires) : 0;
    linhas.push([c.domain, c.httpOnly ? 'TRUE' : 'FALSE', c.path,
      c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t'));
  }
  await fs.writeFile(arquivo, linhas.join('\n'));
}

async function loginSalvoExiste(plataforma, dataDir) {
  return fs.pathExists(path.join(dataDir, 'cookies', `${plataforma}_cookies.txt`));
}

module.exports = { fazerLogin, loginSalvoExiste };
