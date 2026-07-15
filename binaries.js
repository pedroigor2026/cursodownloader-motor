const path = require('path');
const fs = require('fs-extra');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app } = require('electron');

// Confere o SHA256 de um arquivo baixado contra o valor esperado (pinado no código).
// Sem isso, um MITM (proxy/AV comprometido com CA no store do Windows) pode trocar o
// binário no voo e o app executaria malware. Streaming p/ não carregar arquivos grandes na RAM.
function sha256Arquivo(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// Máquinas com antivírus/proxy que intercepta TLS quebram a verificação de certificado
// dos downloads. Usar as CAs instaladas no Windows resolve sem baixar a guarda.
function casDoSistema() {
  try { return tls.getCACertificates('system'); } catch (_) { return undefined; }
}

// O yt-dlp (Python) usa o próprio store de certificados e não enxerga a CA do
// antivírus/proxy. Escrevemos um bundle .pem (CAs do Windows + raízes do Node) e
// apontamos o yt-dlp para ele via SSL_CERT_FILE. Assim o download funciona na rede.
let _caBundle = null;
function caBundlePath() {
  if (_caBundle && fs.pathExistsSync(_caBundle)) return _caBundle;
  const destino = path.join(BIN_USER, 'cacert.pem');
  try {
    const sistema = tls.getCACertificates('system') || [];
    const raizes = tls.rootCertificates || [];
    const todas = [...new Set([...raizes, ...sistema])];
    fs.ensureDirSync(BIN_USER);
    fs.writeFileSync(destino, todas.join('\n') + '\n');
    _caBundle = destino;
    return destino;
  } catch (_) {
    return null;
  }
}

// Binários ficam empacotados no app (resources/bin) OU baixados em userData/bin no 1º uso.
// Assim o app roda em qualquer máquina Windows sem Python, sem instalar nada à mão.
const BIN_EMPACOTADO = process.resourcesPath ? path.join(process.resourcesPath, 'bin') : null;
const BIN_LOCAL = path.join(__dirname, '..', 'bin'); // binários ao lado do código (app rodando da pasta)
const BIN_USER = path.join(app ? app.getPath('userData') : path.join(__dirname, '..'), 'bin');

// Versão PINADA + SHA256 oficial (do SHA2-256SUMS da release). Verificado após baixar.
// Atualizar juntos ao subir de versão: pegar o novo hash em .../releases/download/<versao>/SHA2-256SUMS.
const YTDLP_VERSAO = '2026.07.04';
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSAO}/yt-dlp.exe`;
const YTDLP_SHA256 = '52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8';
// ffmpeg/whisper ainda em `latest` (sem hash pinado). PENDENTE: pinar versão+hash desses dois
// também — enquanto isso, são baixados sem verificação de integridade.
const FFMPEG_URL = 'https://github.com/GyanD/codexffmpeg/releases/latest/download/ffmpeg-release-essentials.zip';
const WHISPER_URL = 'https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip';
const MODELOS_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'; // + /ggml-<modelo>.bin

function baixarArquivo(url, destino, onProgress, hashEsperado) {
  return new Promise((resolve, reject) => {
    fs.ensureDirSync(path.dirname(destino));
    const arquivo = fs.createWriteStream(destino);
    const req = (u) => https.get(u, { headers: { 'User-Agent': 'CursoDownloader' }, ca: casDoSistema() }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return req(res.headers.location); // segue redirect (GitHub usa)
      }
      if (res.statusCode !== 200) {
        res.resume();
        arquivo.close(() => { fs.removeSync(destino); reject(new Error(`HTTP ${res.statusCode} em ${u}`)); });
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let baixado = 0;
      res.on('data', (c) => {
        baixado += c.length;
        if (onProgress && total) onProgress(Math.round((baixado / total) * 100));
      });
      res.pipe(arquivo);
      arquivo.on('finish', () => arquivo.close(async () => {
        // Não aceita arquivo vazio/truncado como sucesso.
        if (fs.statSync(destino).size === 0) { fs.removeSync(destino); return reject(new Error('download vazio')); }
        // Integridade: se há hash pinado, o arquivo baixado TEM que bater — senão foi trocado no caminho.
        if (hashEsperado) {
          const real = await sha256Arquivo(destino).catch(() => null);
          if (real !== hashEsperado) {
            fs.removeSync(destino);
            return reject(new Error(`Integridade FALHOU: hash do arquivo baixado não confere com o esperado (possível adulteração). Esperado ${hashEsperado.slice(0, 12)}…, veio ${real ? real.slice(0, 12) + '…' : 'ilegível'}.`));
          }
        }
        resolve(destino);
      }));
    }).on('error', (e) => { arquivo.close(() => { fs.removeSync(destino); reject(e); }); });
    req(url);
  });
}

function acharEmpacotadoOuUser(nome) {
  for (const dir of [BIN_EMPACOTADO, BIN_LOCAL, BIN_USER].filter(Boolean)) {
    const p = path.join(dir, nome);
    if (fs.pathExistsSync(p)) return p;
  }
  return null;
}

async function garantirYtdlp(onLog) {
  const existente = acharEmpacotadoOuUser('yt-dlp.exe');
  if (existente) return existente;
  const destino = path.join(BIN_USER, 'yt-dlp.exe');
  onLog && onLog({ etapa: 'ytdlp', msg: 'Baixando yt-dlp (motor de download)...' });
  await baixarArquivo(YTDLP_URL, destino, (p) => onLog && onLog({ etapa: 'ytdlp', pct: p }), YTDLP_SHA256);
  onLog && onLog({ etapa: 'ytdlp', msg: 'yt-dlp pronto.' });
  return destino;
}

// Procura ffmpeg empacotado/baixado; senão no PATH; senão baixa e extrai (tar do Windows abre zip).
async function garantirFfmpeg(onLog) {
  const existente = acharEmpacotadoOuUser('ffmpeg.exe');
  if (existente) return existente;

  const noPath = await new Promise((r) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => r(false));
    p.on('close', (code) => r(code === 0));
  });
  if (noPath) return 'ffmpeg'; // usa o do sistema

  onLog && onLog({ etapa: 'ffmpeg', msg: 'Baixando ffmpeg (junta áudio+vídeo)...' });
  const zip = path.join(BIN_USER, 'ffmpeg.zip');
  await baixarArquivo(FFMPEG_URL, zip, (p) => onLog && onLog({ etapa: 'ffmpeg', pct: p }));
  onLog && onLog({ etapa: 'ffmpeg', msg: 'Extraindo ffmpeg...' });
  const extraidoEm = path.join(BIN_USER, 'ffmpeg_tmp');
  await fs.ensureDir(extraidoEm);
  await new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xf', zip, '-C', extraidoEm]); // tar.exe nativo do Win10+ abre zip
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Falha ao extrair ffmpeg'))));
  });
  const achado = acharRecursivo(extraidoEm, 'ffmpeg.exe');
  if (!achado) throw new Error('ffmpeg.exe não encontrado no zip');
  const destino = path.join(BIN_USER, 'ffmpeg.exe');
  await fs.copy(achado, destino);
  await fs.remove(extraidoEm).catch(() => {});
  await fs.remove(zip).catch(() => {});
  onLog && onLog({ etapa: 'ffmpeg', msg: 'ffmpeg pronto.' });
  return destino;
}

function acharRecursivo(dir, nome) {
  if (!fs.pathExistsSync(dir)) return null;
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      const achado = acharRecursivo(full, nome);
      if (achado) return achado;
    } else if (item.toLowerCase() === nome.toLowerCase()) {
      return full;
    }
  }
  return null;
}

async function garantirTudo(onLog) {
  const ytdlp = await garantirYtdlp(onLog);
  const ffmpeg = await garantirFfmpeg(onLog);
  return { ytdlp, ffmpeg };
}

// Whisper.cpp: transcrição local, sem Python. Baixa o binário + o modelo escolhido no 1º uso.
async function garantirWhisper(modelo, onLog) {
  // Usa o whisper já presente (ao lado do código ou baixado em userData); só baixa se faltar.
  let dir = null, exe = null;
  for (const base of [BIN_LOCAL, BIN_USER]) {
    const d = path.join(base, 'whisper');
    // whisper-gpu.exe = build CUDA (muito mais rápido); cai pro CPU se não houver
    const e = acharRecursivo(d, 'whisper-gpu.exe') || acharRecursivo(d, 'whisper-cli.exe') || acharRecursivo(d, 'main.exe');
    if (e) { dir = d; exe = e; break; }
  }
  if (!exe) {
    dir = path.join(BIN_USER, 'whisper');
    onLog && onLog({ etapa: 'whisper', msg: 'Baixando motor de transcrição (whisper)…' });
    const zip = path.join(BIN_USER, 'whisper.zip');
    await baixarArquivo(WHISPER_URL, zip, (p) => onLog && onLog({ etapa: 'whisper', pct: p }));
    onLog && onLog({ etapa: 'whisper', msg: 'Extraindo whisper…' });
    await fs.ensureDir(dir);
    await new Promise((resolve, reject) => {
      const pr = spawn('tar', ['-xf', zip, '-C', dir]);
      pr.on('error', reject);
      pr.on('close', (c) => (c === 0 ? resolve() : reject(new Error('Falha ao extrair whisper'))));
    });
    await fs.remove(zip).catch(() => {});
    exe = acharRecursivo(dir, 'whisper-cli.exe') || acharRecursivo(dir, 'main.exe');
    if (!exe) throw new Error('whisper-cli.exe não encontrado no pacote');
  }

  // Modelo: procura ao lado do código e em userData; só baixa se não existir.
  let modeloPath = null;
  for (const base of [BIN_LOCAL, BIN_USER]) {
    const m = path.join(base, 'whisper', 'models', `ggml-${modelo}.bin`);
    if (await fs.pathExists(m)) { modeloPath = m; break; }
  }
  if (!modeloPath) {
    const modelosDir = path.join(BIN_USER, 'whisper', 'models');
    await fs.ensureDir(modelosDir);
    modeloPath = path.join(modelosDir, `ggml-${modelo}.bin`);
    onLog && onLog({ etapa: 'whisper', msg: `Baixando modelo ${modelo} (pode ser grande, só na 1ª vez)…` });
    await baixarArquivo(`${MODELOS_URL}/ggml-${modelo}.bin`, modeloPath,
      (p) => onLog && onLog({ etapa: 'whisper', pct: p }));
  }
  onLog && onLog({ etapa: 'whisper', msg: 'Transcrição pronta.' });
  return { exe, modelo: modeloPath };
}

// Rebaixa a última versão do yt-dlp — plataformas mudam, o motor precisa acompanhar.
async function atualizarYtdlp(onLog) {
  const destino = path.join(BIN_USER, 'yt-dlp.exe');
  await fs.remove(destino).catch(() => {});
  onLog && onLog({ etapa: 'ytdlp', msg: 'Atualizando motor de download…' });
  await baixarArquivo(YTDLP_URL, destino, (p) => onLog && onLog({ etapa: 'ytdlp', pct: p }), YTDLP_SHA256);
  onLog && onLog({ etapa: 'ytdlp', msg: 'Motor atualizado.' });
  return destino;
}

module.exports = { garantirTudo, garantirYtdlp, garantirFfmpeg, garantirWhisper, atualizarYtdlp, caBundlePath, BIN_USER };
