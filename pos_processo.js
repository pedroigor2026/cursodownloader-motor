const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');

// Lista arquivos de mídia baixados de um curso (recursivo). Vídeo por padrão.
const EXT_VIDEO = ['.mp4', '.mkv', '.webm'];
const EXT_AUDIO = ['.m4a', '.mp3', '.webm', '.opus', '.wav'];
async function listarMidia(destDir, exts) {
  const out = [];
  async function varre(dir) {
    for (const item of await fs.readdir(dir)) {
      const full = path.join(dir, item);
      const st = await fs.stat(full);
      if (st.isDirectory()) { if (path.basename(full) !== '_frames') await varre(full); }
      else if (exts.includes(path.extname(item).toLowerCase())) out.push(full);
    }
  }
  if (await fs.pathExists(destDir)) await varre(destDir);
  return out.sort();
}

// FRAMES: extrai um quadro a cada mudança de cena (pega slides/telas novas).
function extrairFrames(videoPath, ffmpeg, sensibilidade = 0.3) {
  const base = path.basename(videoPath, path.extname(videoPath));
  const dir = path.join(path.dirname(videoPath), '_frames', base);
  fs.ensureDirSync(dir);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-i', videoPath,
    '-vf', `select='gt(scene,${sensibilidade})'`,
    '-vsync', 'vfr', path.join(dir, '%04d.png'),
  ];
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, args);
    p.on('close', async () => {
      const n = (await fs.readdir(dir).catch(() => [])).length;
      resolve({ dir, frames: n });
    });
    p.on('error', (e) => resolve({ dir, frames: 0, erro: e.message }));
  });
}

// TRANSCRIÇÃO: extrai áudio 16kHz e roda whisper.cpp -> .txt e .srt ao lado do vídeo.
async function transcrever(videoPath, ffmpeg, whisperExe, modelo, idioma = 'pt') {
  const base = path.basename(videoPath, path.extname(videoPath));
  const dir = path.dirname(videoPath);
  const wav = path.join(dir, base + '.wav');
  const saidaBase = path.join(dir, base); // whisper adiciona .txt/.srt

  await new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg falhou ao extrair áudio'))));
    p.on('error', reject);
  });

  await new Promise((resolve, reject) => {
    const p = spawn(whisperExe, ['-m', modelo, '-f', wav, '-l', idioma,
      '-t', '8', // 8 das 12 threads (fallback CPU)
      '-nfa', // sem flash-attention: crasha na GPU Turing (GTX 1650); GPU usada automaticamente se disponível
      '-otxt', '-osrt', '-of', saidaBase]);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('whisper falhou'))));
    p.on('error', reject);
  });

  await fs.remove(wav).catch(() => {});
  return { txt: saidaBase + '.txt', srt: saidaBase + '.srt' };
}

module.exports = { listarMidia, extrairFrames, transcrever, EXT_VIDEO, EXT_AUDIO };
