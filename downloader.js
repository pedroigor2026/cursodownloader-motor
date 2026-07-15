const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const readline = require('readline');
const { garantirTudo, caBundlePath } = require('./binaries');
const { baixarCursoViaCaptura } = require('./captura');
const { baixarDoDrive, ehCaminhoLocal } = require('./drive');

// Plataformas cujo player o yt-dlp não entende sozinho: baixamos capturando o HLS
// real pelo navegador logado (ver captura.js).
const PLATAFORMAS_CAPTURA = ['hotmart', 'kiwify', 'greenn'];
// varejoativo.online = Curseduca + SmartPlayer (vídeo HLS em iframe) — captura por navegação.
const URL_CAPTURA = /hotmart\.com|kiwify|greenn\.club|varejoativo\.online|vivapositivamente\.com\.br/i; // detecta por URL também

function detectarPlataforma(url, config) {
  for (const [nome, info] of Object.entries(config.plataformas)) {
    if (info.detectar && url.includes(info.detectar)) return nome;
  }
  return 'generico';
}

function sanitizar(nome) {
  return (nome || 'curso').replace(/[<>:"/\\|?*\n]/g, '_').trim().substring(0, 80);
}

// Caminho do cookies.txt salvo pelo login (auth.js).
function cookieFileDe(plataforma, dataDir) {
  return path.join(dataDir, 'cookies', `${plataforma}_cookies.txt`);
}

// Baixa um curso inteiro. Chama onEvent({tipo, ...}) para a UI acompanhar ao vivo.
async function baixarCurso(curso, config, dataDir, onEvent, getCancelado) {
  const plataforma = curso.plataforma || detectarPlataforma(curso.url, config);

  // Google Drive / pasta do PC: copia os arquivos (a "url" é um caminho de pasta).
  if (plataforma === 'drive' || ehCaminhoLocal(curso.url)) {
    return baixarDoDrive(curso, config, onEvent, getCancelado);
  }

  // Hotmart/Kiwify/Greenn: yt-dlp não lê a página. Captura o vídeo real pelo navegador logado.
  if (PLATAFORMAS_CAPTURA.includes(plataforma) || URL_CAPTURA.test(curso.url || '')) {
    return baixarCursoViaCaptura({ ...curso, plataforma }, config, dataDir, onEvent, getCancelado);
  }

  const { ytdlp, ffmpeg } = await garantirTudo((e) => onEvent({ tipo: 'setup', ...e }));

  const destDir = path.join(config.destino, sanitizar(plataforma), sanitizar(curso.nome));
  await fs.ensureDir(destDir);

  const outputTemplate = path.join(destDir, '%(playlist_index)03d - %(title)s.%(ext)s');
  const cookieFile = cookieFileDe(plataforma, dataDir);
  const temCookies = await fs.pathExists(cookieFile);

  // Modo áudio: quando o objetivo é só transcrever, baixa só o áudio (leve) de cada aula.
  const soAudio = config.baixar_video === false;

  const baseArgs = [
    '--newline', '--ignore-errors', '--no-warnings', '--restrict-filenames',
    '-o', outputTemplate,
    '--sleep-interval', String(config.pausar_entre_videos || 3),
    '--retries', '10', '--fragment-retries', '10',
    '--continue', '--no-overwrites',
    '--ffmpeg-location', ffmpeg,
    '--progress-template', 'PROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.playlist_index)s|%(info.playlist_count)s|%(info.title)s',
  ];
  if (soAudio) {
    baseArgs.push('-x', '--audio-format', 'm4a'); // extrai áudio
  } else {
    baseArgs.push('--merge-output-format', 'mp4');
  }
  if (config.legendas && !soAudio) {
    baseArgs.push('--write-subs', '--write-auto-subs', '--sub-langs', 'pt.*,en.*', '--embed-subs');
  }
  if (config.velocidade_maxima && config.velocidade_maxima !== '0') {
    baseArgs.push('--limit-rate', config.velocidade_maxima);
  }
  if (temCookies) {
    baseArgs.push('--cookies', cookieFile);
    onEvent({ tipo: 'log', msg: `Usando login salvo de ${plataforma}` });
  } else {
    onEvent({ tipo: 'log', msg: `Sem login salvo para ${plataforma} — só aulas públicas` });
  }

  onEvent({ tipo: 'inicio', destino: destDir });

  // Camaleão: tenta caminhos do mais exigente ao mais permissivo até conseguir baixar algo.
  const estrategias = soAudio
    ? [{ rotulo: 'melhor áudio', fmt: 'bestaudio/best' }]
    : [
        { rotulo: 'qualidade escolhida', fmt: config.qualidade },
        { rotulo: 'melhor combinação disponível', fmt: 'bestvideo+bestaudio/best' },
        { rotulo: 'formato único (mais compatível)', fmt: 'best' },
      ];

  let ultimoErro = '';
  let inseguro = false; // vira true se a rede intercepta TLS (antivírus/proxy)
  for (let i = 0; i < estrategias.length; i++) {
    if (getCancelado && getCancelado()) return { sucesso: false, cancelado: true };
    const est = estrategias[i];
    if (i > 0) onEvent({ tipo: 'log', msg: `Não deu no caminho anterior — tentando ${est.rotulo}…` });

    let r = await rodarYtdlp(ytdlp, [...baseArgs, '-f', est.fmt, curso.url], onEvent, getCancelado, inseguro);
    if (r.cancelado) return { sucesso: false, cancelado: true };

    // Erro de certificado (antivírus/proxy interceptando): refaz confiando na rede local.
    if (r.concluidas === 0 && r.certErro && !inseguro) {
      inseguro = true;
      onEvent({ tipo: 'log', msg: 'Rede intercepta o certificado — reconectando pelo caminho seguro da máquina…' });
      r = await rodarYtdlp(ytdlp, [...baseArgs, '-f', est.fmt, curso.url], onEvent, getCancelado, true);
      if (r.cancelado) return { sucesso: false, cancelado: true };
    }

    if (r.concluidas > 0) {
      return { sucesso: true, destino: destDir, concluidas: r.concluidas, parcial: r.code !== 0 };
    }
    ultimoErro = r.erro || `código ${r.code}`;
  }

  return {
    sucesso: false, destino: destDir, concluidas: 0,
    erro: `Não consegui baixar (${ultimoErro}). Caminhos a tentar: 1) refazer o login da plataforma; ` +
          `2) atualizar o motor (botão "Atualizar motor"); 3) conferir se a URL é da primeira aula/curso; ` +
          `4) se for DRM, usar o modo Gravar tela.`,
  };
}

// Executa uma tentativa do yt-dlp; resolve com { code, concluidas, erro, cancelado }.
function rodarYtdlp(ytdlp, args, onEvent, getCancelado, inseguro) {
  return new Promise((resolve) => {
    // 1ª linha de defesa: fazer o yt-dlp confiar na CA do sistema (rede com proxy/antivírus).
    const bundle = caBundlePath();
    const env = { ...process.env };
    if (bundle) { env.SSL_CERT_FILE = bundle; env.REQUESTS_CA_BUNDLE = bundle; }
    // 2ª linha (só se a 1ª falhou): desliga a verificação — a rede já é interceptada localmente.
    const finalArgs = inseguro ? [...args, '--no-check-certificates'] : args;
    const proc = spawn(ytdlp, finalArgs, { env });
    let concluidas = 0;
    let cancelado = false;
    let certErro = false;

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (linha) => {
      if (linha.startsWith('PROG|')) {
        const [, pct, speed, eta, idx, count, ...titulo] = linha.split('|');
        onEvent({
          tipo: 'progresso',
          pct: parseFloat(pct) || 0,
          speed: (speed || '').trim(),
          eta: (eta || '').trim(),
          aulaAtual: parseInt(idx, 10) || null,
          totalAulas: parseInt(count, 10) || null,
          aulaTitulo: titulo.join('|').trim(),
        });
      } else if (linha.includes('[download] Destination:') || linha.includes('has already been downloaded')) {
        concluidas++;
        onEvent({ tipo: 'aula_ok', concluidas });
      }
    });

    const rlErr = readline.createInterface({ input: proc.stderr });
    rlErr.on('line', (linha) => {
      if (!linha.trim()) return;
      if (/CERTIFICATE_VERIFY|certificate verify failed|SSLError/i.test(linha)) certErro = true;
      onEvent({ tipo: 'log', msg: linha.trim() });
    });

    const timer = setInterval(() => {
      if (getCancelado && getCancelado()) { cancelado = true; try { proc.kill(); } catch (_) {} clearInterval(timer); }
    }, 500);

    proc.on('close', (code) => { clearInterval(timer); resolve({ code, concluidas, cancelado, certErro }); });
    proc.on('error', (err) => { clearInterval(timer); resolve({ code: -1, concluidas, erro: err.message, cancelado, certErro }); });
  });
}

module.exports = { baixarCurso, detectarPlataforma, sanitizar };
