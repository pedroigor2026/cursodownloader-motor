// Quem manda na banda, nesta ordem: 1) aula AO VIVO (Zoom/Meet/Teams — não volta atrás),
// 2) live agendada (também é ao vivo), 3) downloads de curso (podem esperar; retomam de onde
// pararam). A decisão é tomada com a BANDA REAL medida nos downloads, não no chute.
//
// Gravar a tela não gasta banda — quem gasta é a videochamada em si. Por isso "priorizar a aula"
// significa segurar os downloads pra a chamada não engasgar.

// MEDIDO com uma chamada do Meet no ar (14/07): a chamada consome ~0,01 MB/s e o curso continuou
// baixando a 9,5 MB/s sem atrapalhar. Ou seja: parar os cursos é exagero em rede boa — basta
// baixar com 1 conexão e teto de verdade. Só em rede fraca (2 MB/s, tipo 4G/café) o curso PARA,
// porque aí ele realmente disputaria a banda da chamada — e aula ao vivo não tem segunda chance.
const BANDA_FRACA = 2; // MB/s medidos sem teto

let aoVivo = false;        // gravando Zoom/Meet/Teams agora
let liveAgendada = false;  // gravando live agendada agora
const banda = [];          // MB/s das últimas aulas baixadas

function registrarBanda(mbs) {
  if (!mbs || mbs <= 0) return;
  banda.push(mbs);
  if (banda.length > 5) banda.shift();
}

function bandaMedia() {
  if (!banda.length) return null; // ainda não sabemos: assume o pior e é conservador
  return banda.reduce((a, b) => a + b, 0) / banda.length;
}

// Quantos downloads de curso podem rodar agora. 0 = fila segura (a chamada tem prioridade).
function paralelasPermitidas() {
  const media = bandaMedia();
  const redeFraca = media != null && media < BANDA_FRACA;
  // Aula ao vivo (Zoom/Meet/Teams) e live agendada: 1 download com teto. Só para de vez se a rede
  // for fraca — aí o curso pode esperar, a aula não.
  if (aoVivo || liveAgendada) return redeFraca ? 0 : 1;
  if (media == null) return 1;        // 1ª aula: é ela que mede a banda
  return media >= 5 ? 2 : 1;          // medido: 2 juntas = 11,4 MB/s; 1 sozinha = 7,2 MB/s
}

// Teto de velocidade por download (formato do yt-dlp) enquanto tem gente ao vivo. null = sem teto.
function limiteRate() {
  if (aoVivo) return '3M';
  if (liveAgendada) return '5M';
  return null;
}

const setAoVivo = (v) => { aoVivo = !!v; };
const setLiveAgendada = (v) => { liveAgendada = !!v; };
const estado = () => ({ aoVivo, liveAgendada, bandaMedia: bandaMedia(), paralelas: paralelasPermitidas() });

module.exports = { registrarBanda, bandaMedia, paralelasPermitidas, limiteRate, setAoVivo, setLiveAgendada, estado, BANDA_FRACA };
