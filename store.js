const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { app } = require('electron');

// Caminhos calculados sob demanda: app.getPath() só é seguro após o app ficar pronto.
function dataDir() {
  return app ? app.getPath('userData') : path.join(__dirname, '..', '_data');
}
function configFile() { return path.join(dataDir(), 'config.json'); }
function queueFile() { return path.join(dataDir(), 'queue.json'); }

function configPadrao() {
  const videos = app ? app.getPath('videos') : path.join(os.homedir(), 'Videos');
  return {
    destino: path.join(videos, 'Cursos'),
    qualidade: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    velocidade_maxima: '0',
    downloads_paralelos: 0, // 0 = automático (decide pela banda medida). 1..3 = fixo.
    // Já vem configurado: toda máquina nova aponta pro repo do motor. Aba Atualização usa isso.
    motor_url: 'https://raw.githubusercontent.com/pedroigor2026/cursodownloader-motor/main',
    pausar_entre_videos: 10,
    legendas: true,
    // Chaves independentes do que fazer com cada aula:
    baixar_video: true,     // guardar o vídeo
    transcrever: false,     // gerar texto (.txt/.srt) via whisper
    frames: false,          // extrair imagens dos slides/telas
    modelo_transcricao: 'base',
    idioma: 'pt',
    frames_sensibilidade: 0.3,
    plataformas: {
      hotmart: {
        login_url: 'https://app.hotmart.com/login', detectar: 'hotmart.com',
        dica: 'Login com e-mail/senha (ou Google) no site oficial. Você não digita senha no app.',
        guia: [
          'Clique em "Entrar" — abre o site da Hotmart numa janela.',
          'Faça login com seu e-mail e senha (ou o botão do Google).',
          'Entre no curso que quer baixar e deixe a primeira aula aberta.',
          'Copie o link da barra de endereço do navegador.',
          'Feche a janela de login — o app guarda a sessão sozinho.',
          'Cole o link no campo "URL do curso" e clique em Baixar.',
        ],
      },
      kiwify: {
        login_url: 'https://dashboard.kiwify.com.br/login', detectar: 'kiwify.com',
        dica: 'Login no site da Kiwify (área de membros). Só a sessão é guardada.',
        guia: [
          'Clique em "Entrar" — abre a Kiwify numa janela.',
          'Entre com seu e-mail e senha da área de membros.',
          'Abra o curso e vá até a primeira aula.',
          'Copie o link da aula na barra de endereço.',
          'Feche a janela — a sessão fica salva.',
          'Cole o link e clique em Baixar.',
        ],
      },
      udemy: {
        login_url: 'https://www.udemy.com/join/login-popup/', detectar: 'udemy.com',
        dica: 'Login na sua conta Udemy. Funciona com cursos que você já comprou.',
        guia: [
          'Clique em "Entrar" — abre a Udemy numa janela.',
          'Faça login na sua conta.',
          'Abra o curso comprado e a primeira aula.',
          'Copie o link do curso.',
          'Feche a janela de login.',
          'Cole o link e clique em Baixar.',
        ],
      },
      youtube: {
        login_url: 'https://accounts.google.com', detectar: 'youtube.com',
        dica: 'Playlists públicas não precisam de login. Só entre para vídeos privados/da sua conta.',
        guia: [
          'Playlist pública: pule o login, cole o link direto e baixe.',
          'Vídeo privado/restrito: clique em "Entrar" e logue no Google.',
          'Copie o link da playlist ou do vídeo.',
          'Cole no campo "URL" e clique em Baixar.',
        ],
      },
      generico: {
        login_url: null, detectar: null,
        dica: 'Qualquer site com player de vídeo. O app tenta baixar mesmo sem perfil específico.',
        guia: [
          'Cole o link da página do vídeo/curso no campo "URL".',
          'Se o conteúdo for pago, faça login antes pelo botão "Entrar" da plataforma mais parecida.',
          'Clique em Baixar — o app tenta vários caminhos automaticamente.',
        ],
      },
    },
  };
}

const QUEUE_PADRAO = { fila: [], concluidos: [], erros: [], agendados: [] };

async function lerConfig() {
  await fs.ensureDir(dataDir());
  const padrao = configPadrao();
  if (!(await fs.pathExists(configFile()))) {
    await fs.writeJSON(configFile(), padrao, { spaces: 2 });
    return padrao;
  }
  const salvo = await fs.readJSON(configFile());
  const merged = { ...padrao, ...salvo };
  // Guias/dicas evoluem com o app: sempre usa a versão mais nova do padrão por plataforma.
  merged.plataformas = { ...salvo.plataformas };
  for (const [nome, def] of Object.entries(padrao.plataformas)) {
    merged.plataformas[nome] = { ...(salvo.plataformas?.[nome] || {}), ...def };
  }
  return merged;
}

async function salvarConfig(config) {
  await fs.ensureDir(dataDir());
  await fs.writeJSON(configFile(), config, { spaces: 2 });
  return config;
}

async function lerQueue() {
  await fs.ensureDir(dataDir());
  if (!(await fs.pathExists(queueFile()))) {
    await fs.writeJSON(queueFile(), QUEUE_PADRAO, { spaces: 2 });
    return { ...QUEUE_PADRAO };
  }
  return { ...QUEUE_PADRAO, ...(await fs.readJSON(queueFile())) };
}

async function salvarQueue(queue) {
  await fs.ensureDir(dataDir());
  await fs.writeJSON(queueFile(), queue, { spaces: 2 });
  return queue;
}

// DATA_DIR é usado por outros módulos (cookies/bin); expõe como getter.
module.exports = {
  lerConfig, salvarConfig, lerQueue, salvarQueue,
  get DATA_DIR() { return dataDir(); },
};
