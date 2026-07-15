// Modo "Descobrir cursos": abre o navegador logado; conforme você abre cada curso nas
// suas áreas de membros, detecta pela URL e avisa a UI (que lista com checkbox).
const { abrirNavegador } = require('./gravador');

// Identifica um curso a partir da URL de uma aula/página. Retorna {plataforma, chave, url} ou null.
function identificarCurso(u) {
  if (!u) return null;
  let m;
  if ((m = u.match(/hotmart\.com\/[^/]+\/club\/([^/]+)\/products\/(\d+)\/content\/\w+/i)))
    return { plataforma: 'hotmart', chave: `hotmart:${m[2]}`, url: u.split('?')[0] };
  if ((m = u.match(/members\.kiwify\.com\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+/i)))
    return { plataforma: 'kiwify', chave: `kiwify:${u.match(/kiwify\.com\/([0-9a-f-]+)/i)[1]}`, url: u.split('#')[0] };
  if ((m = u.match(/([a-z0-9-]+\.greenn\.club)\/curso\/(\d+)\/modulo\/\d+\/aula\/\d+/i)))
    return { plataforma: 'greenn', chave: `greenn:${m[2]}`, url: u.split('?')[0] };
  return null;
}

async function descobrirCursos(dataDir, onCurso, getParar) {
  const ctx = await abrirNavegador(dataDir);
  // fecha abas restauradas de sessões anteriores (deixa 1 limpa)
  const abertas = ctx.pages();
  for (let i = 1; i < abertas.length; i++) await abertas[i].close().catch(() => {});
  const page = ctx.pages()[0] || (await ctx.newPage());
  const nomes = {}; // chave -> nome do curso (vindo das APIs, mais confiável que o title)
  ctx.on('response', async (res) => {
    const u = res.url();
    try {
      if (/\/v1\/viewer\/courses\/[0-9a-f-]+(\?|$)/i.test(u)) { const j = await res.json(); if (j && j.course) nomes[`kiwify:${j.course.id}`] = j.course.name; }
      else if (/api\.greenn\.club\/course\/\d+\/watch/i.test(u)) { const j = await res.json(); if (j && j.course) nomes[`greenn:${j.course.id}`] = j.course.title; }
    } catch (_) {}
  });

  // barra limpa: começa em branco, o usuário digita o endereço da plataforma
  await page.goto('about:blank').catch(() => {});
  const vistos = new Set();
  const checar = async () => {
    for (const pg of ctx.pages()) {
      try {
        const id = identificarCurso(pg.url());
        if (id && !vistos.has(id.chave)) {
          vistos.add(id.chave);
          let nome = nomes[id.chave];
          if (!nome) { try { nome = (await pg.title()) || ''; } catch (_) { nome = ''; } }
          onCurso({ plataforma: id.plataforma, url: id.url, nome: nome || id.plataforma });
        }
      } catch (_) {}
    }
  };
  const timer = setInterval(() => { if (!(getParar && getParar())) checar(); }, 2000);
  await new Promise((r) => ctx.on('close', r));
  clearInterval(timer);
  return { total: vistos.size };
}

module.exports = { descobrirCursos, identificarCurso };

// self-check: node core/descobrir.js
if (require.main === module) {
  const a = identificarCurso('https://hotmart.com/pt-BR/club/x/products/7938588/content/V73PnJzlO3?y=1');
  console.assert(a && a.plataforma === 'hotmart' && a.chave === 'hotmart:7938588', 'hotmart');
  const b = identificarCurso('https://members.kiwify.com/1cd72ab9-c43c-457a-af81-fa13f9a9231a/b4/e2#x');
  console.assert(b && b.plataforma === 'kiwify' && b.url.indexOf('#') < 0, 'kiwify');
  const c = identificarCurso('https://iaparanegocios.greenn.club/curso/120738/modulo/284365/aula/901756');
  console.assert(c && c.plataforma === 'greenn' && c.chave === 'greenn:120738', 'greenn');
  console.assert(identificarCurso('https://google.com') === null, 'nao-curso = null');
  console.log('descobrir self-check OK');
}
