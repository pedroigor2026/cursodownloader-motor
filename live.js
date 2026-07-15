// Grava lives agendadas (YouTube e afins). O yt-dlp faz o trabalho: espera a live começar
// (--wait-for-video), grava desde o início (--live-from-start) e encerra sozinho quando a
// transmissão acaba. Roda fora da fila de cursos, pra não perder a hora marcada.
const path = require('path');
const fs = require('fs-extra');
const readline = require('readline');
const { spawn } = require('child_process');
const { garantirTudo, caBundlePath } = require('./binaries');
const { matarArvore } = require('./proc');

const sanitizar = (s) => (s || 'live').replace(/[<>:"/\\|?*\n]/g, '_').trim().substring(0, 80);

// Grava uma live. Volta { code, arquivo }. code 0 = terminou de gravar a transmissão inteira.
async function gravarLive(agendado, config, onEvent, onProc) {
  const { ytdlp, ffmpeg } = await garantirTudo((e) => onEvent({ tipo: 'setup', ...e }));
  const destDir = path.join(config.destino, 'Lives');
  await fs.ensureDir(destDir);
  const saida = path.join(destDir, `${sanitizar(agendado.nome)} - %(upload_date>%Y-%m-%d)s.%(ext)s`);

  const env = { ...process.env };
  const bundle = caBundlePath();
  if (bundle) { env.SSL_CERT_FILE = bundle; env.REQUESTS_CA_BUNDLE = bundle; }

  const args = [
    '--no-warnings', '--newline', '--no-check-certificates',
    '--wait-for-video', '60',     // live ainda não no ar? espera, checando a cada 60s
    '--no-part',                  // escreve direto no arquivo final (sobrevive a queda)
    // Stream HLS único (áudio junto do vídeo, até 1080p): grava do momento em que entra e o
    // arquivo já fica assistível se a gravação for interrompida. Faixas separadas (DASH) só
    // viram um mp4 quando o yt-dlp termina sozinho — um "parar" no meio deixaria os pedaços
    // soltos. Como a gravação é AGENDADA para a hora da live, entrar "agora" = entrar no início.
    // (--live-from-start não funciona com esses formatos HLS.)
    '-f', 'best[protocol^=m3u8]/best',
    '--retries', 'infinite', '--fragment-retries', 'infinite',
    '--ffmpeg-location', ffmpeg, '-o', saida,
    '--progress-template', 'PROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress.downloaded_bytes)s',
  ];
  args.push(agendado.url);

  return new Promise((resolve) => {
    const proc = spawn(ytdlp, args, { env });
    if (onProc) onProc(proc);
    let arquivo = null;
    const linha = (l) => {
      const m = l.match(/\[download\] Destination: (.+)/);
      if (m) arquivo = m[1].trim();
      if (l.startsWith('PROG|')) {
        const [, , speed, bytes] = l.split('|');
        onEvent({ tipo: 'live_progresso', id: agendado.id, speed: (speed || '').trim(), mb: Math.round((parseInt(bytes, 10) || 0) / 1048576) });
      } else if (/Waiting for video|is not currently live|Remaining time/i.test(l)) {
        onEvent({ tipo: 'live_log', id: agendado.id, msg: 'Aguardando a live começar…' });
      }
    };
    readline.createInterface({ input: proc.stdout }).on('line', linha);
    readline.createInterface({ input: proc.stderr }).on('line', linha);
    proc.on('close', (code) => resolve({ code, arquivo }));
    proc.on('error', (e) => resolve({ code: -1, erro: e.message }));
  });
}

module.exports = { gravarLive, pararLive: matarArvore };
