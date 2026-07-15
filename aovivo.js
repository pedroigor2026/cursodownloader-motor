// Gravação de aula AO VIVO (Zoom / Meet / Teams) por captura de tela.
// Não existe stream pra baixar nessas plataformas — a única forma é gravar o que aparece na tela.
// Quem captura é o Chromium do Electron (desktopCapturer + MediaRecorder, no renderer); aqui fica
// o lado do disco: escrever os pedaços que chegam e, no fim, converter pra mp4.
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');

const sanitizar = (s) => (s || 'aula').replace(/[<>:"/\\|?*\n]/g, '_').trim().substring(0, 80);

// Uma janela "é reunião" enquanto o título parecer de reunião. Quando o Zoom/Teams encerra, a
// janela some; no Meet (aba do Chrome) a janela continua, mas o título deixa de ser o da chamada.
// \bmeet\b pega "Meet - abc-defg-hij - Google Chrome" (título real de uma chamada do Meet), que
// não casava com "meet.google" e fazia a gravação encerrar achando que a aula tinha acabado.
const TITULO_REUNIAO = /zoom|\bmeet\b|meet\.google|teams|reuni[ãa]o|meeting|\bcall\b/i;
const ehReuniao = (titulo) => TITULO_REUNIAO.test(titulo || '');

function novoArquivo(destino, nome) {
  const dir = path.join(destino, 'Aulas ao vivo');
  fs.ensureDirSync(dir);
  const carimbo = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
  return path.join(dir, `${sanitizar(nome)} - ${carimbo}.webm`);
}

// O MediaRecorder entrega webm (h264/vp9 + opus). Converte pra mp4 copiando o VÍDEO (rápido, sem
// perder qualidade) e passando o áudio pra AAC — opus dentro de mp4 emperra em vários players.
// Se a conversão falhar, o .webm fica lá e é assistível do mesmo jeito: a aula não se perde.
function paraMp4(ffmpeg, webm) {
  const mp4 = webm.replace(/\.webm$/i, '.mp4');
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-y', '-i', webm, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', mp4]);
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(mp4) && fs.statSync(mp4).size > 0) {
        fs.removeSync(webm);
        resolve(mp4);
      } else {
        resolve(webm); // deu ruim na conversão: entrega o webm mesmo (a gravação está salva)
      }
    });
    p.on('error', () => resolve(webm));
  });
}

module.exports = { novoArquivo, paraMp4, ehReuniao, sanitizar };
