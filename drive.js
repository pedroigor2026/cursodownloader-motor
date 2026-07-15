// "Baixar do Google Drive" = copiar uma pasta do Drive montado (G:\Meu Drive\...) ou de
// qualquer pasta do PC para o destino, com progresso. Simples e robusto: sem API, sem token.
const path = require('path');
const fs = require('fs-extra');

const sanitizar = (n) => (n || 'curso').replace(/[<>:"/\\|?*\n\r]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 70);

// url do "curso" aqui é um CAMINHO de pasta (ex.: G:\Meu Drive\Curso X). Detecta isso.
function ehCaminhoLocal(u) {
  return /^[A-Za-z]:[\\/]/.test(u || '') || (u || '').startsWith('\\\\');
}

async function baixarDoDrive(curso, config, onEvent, getCancelado) {
  const origem = curso.url;
  if (!(await fs.pathExists(origem))) {
    return { sucesso: false, erro: `Pasta não encontrada: ${origem}` };
  }
  const destDir = path.join(config.destino, sanitizar(curso.nome));
  await fs.ensureDir(destDir);
  onEvent({ tipo: 'inicio', destino: destDir });

  const arquivos = [];
  async function varre(dir) {
    for (const it of await fs.readdir(dir)) {
      if (getCancelado && getCancelado()) return;
      const full = path.join(dir, it);
      const st = await fs.stat(full);
      if (st.isDirectory()) await varre(full);
      else arquivos.push(full);
    }
  }
  await varre(origem);
  onEvent({ tipo: 'log', msg: `${arquivos.length} arquivo(s) na pasta do Drive.` });

  let feitos = 0;
  for (const arq of arquivos) {
    if (getCancelado && getCancelado()) return { sucesso: feitos > 0, cancelado: true, destino: destDir, concluidas: feitos };
    const rel = path.relative(origem, arq);
    const dest = path.join(destDir, rel);
    await fs.ensureDir(path.dirname(dest));
    try { await fs.copy(arq, dest, { overwrite: false, errorOnExist: false }); } catch (_) {}
    feitos++;
    const pct = Math.round((feitos / arquivos.length) * 100);
    onEvent({ tipo: 'progresso', pct, speed: 'copiando', eta: `${feitos}/${arquivos.length}`, aulaAtual: feitos, totalAulas: arquivos.length, pctCurso: pct });
  }
  onEvent({ tipo: 'aula_ok', concluidas: feitos });
  return { sucesso: feitos > 0, destino: destDir, concluidas: feitos, erro: feitos === 0 ? 'Pasta vazia.' : undefined };
}

module.exports = { baixarDoDrive, ehCaminhoLocal };

// self-check: node core/drive.js
if (require.main === module) {
  console.assert(ehCaminhoLocal('G:\\Meu Drive\\Curso'), 'detecta G:');
  console.assert(ehCaminhoLocal('C:/pasta'), 'detecta C:/');
  console.assert(ehCaminhoLocal('\\\\rede\\share'), 'detecta UNC');
  console.assert(!ehCaminhoLocal('https://hotmart.com/x'), 'url http não é local');
  console.log('drive self-check OK');
}
