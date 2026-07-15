const { spawn } = require('child_process');

// O yt-dlp.exe é empacotado com PyInstaller: ele roda um processo FILHO que faz o download.
// proc.kill() derruba só o pai — o filho continua baixando (foi o que quebrava o botão Pausar
// e o "Parar gravação"). No Windows a única forma confiável é matar a árvore inteira.
function matarArvore(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
  } else {
    try { proc.kill('SIGTERM'); } catch (_) {}
  }
}

module.exports = { matarArvore };
