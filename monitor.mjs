// Monitor externo (roda no GitHub Actions, de fora das nossas VPS).
// Alvos vêm do segredo MONITOR_ALVOS (JSON). Duas falhas seguidas (3 tentativas na mesma rodada) antes de avisar.
// Avisa no WhatsApp quando cai e quando volta; o estado fica no arquivo estado.json (branch "estado").
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";

const alvos = JSON.parse(process.env.MONITOR_ALVOS || "[]");
if (process.env.SIMULAR_QUEDA === "1") alvos.push({ nome: "TESTE do monitor (queda simulada)", tipo: "http", url: "https://monitor-teste-queda.invalid/" });
const ESTADO = "estado.json";
const estado = fs.existsSync(ESTADO) ? JSON.parse(fs.readFileSync(ESTADO, "utf8")) : {};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const hora = (d = new Date()) => new Date(d).toLocaleString("pt-BR", { timeZone: "America/Fortaleza", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

async function http(a) {
  const r = await fetch(a.url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "monitor-externo-rstech" } });
  const ok = a.codigos || [200];
  if (!ok.includes(r.status)) throw new Error(`HTTP ${r.status}`);
  if (a.palavra) { const t = await r.text(); if (!t.includes(a.palavra)) throw new Error(`palavra "${a.palavra}" sumiu`); }
}
function porta(a) {
  return new Promise((res, rej) => {
    const s = net.connect({ host: a.host, port: a.porta, timeout: 10000 });
    s.on("connect", () => { s.destroy(); res(); });
    s.on("timeout", () => { s.destroy(); rej(new Error("porta sem resposta")); });
    s.on("error", (e) => rej(new Error(e.code || e.message)));
  });
}
function certificado(host) {
  return new Promise((res, rej) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const dias = Math.floor((new Date(s.getPeerCertificate().valid_to) - Date.now()) / 864e5);
      s.destroy(); dias < 14 ? rej(new Error(`certificado vence em ${dias} dias`)) : res();
    });
    s.on("timeout", () => { s.destroy(); rej(new Error("TLS sem resposta")); });
    s.on("error", (e) => rej(new Error(e.code || e.message)));
  });
}
async function checar(fn) {
  let erro;
  for (let i = 0; i < 3; i++) { try { await fn(); return null; } catch (e) { erro = e.cause?.code || e.message; if (i < 2) await espera(20000); } }
  return erro;
}

async function whatsapp(texto) {
  const { WHATSAPP_TOKEN: t, WHATSAPP_PHONE_NUMBER_ID: p, WHATSAPP_DESTINO: d } = process.env;
  const r = await fetch(`https://graph.facebook.com/v21.0/${p}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: d, type: "text", text: { body: texto } }),
  });
  const j = await r.json();
  console.log(r.ok ? `WhatsApp aceito pela Meta: ${j.messages?.[0]?.id}` : `WhatsApp RECUSADO: ${JSON.stringify(j.error)}`);
  return r.ok;
}

// Monta a lista de verificações: o alvo em si e, para cada site https, o certificado.
const itens = [];
for (const a of alvos) {
  const fn = a.tipo === "porta" ? () => porta(a) : () => http(a);
  itens.push({ chave: a.nome, nome: a.nome, fn });
  if (a.tipo !== "porta" && a.url.startsWith("https://") && !a.url.includes(".invalid") && !a.semCert)
    itens.push({ chave: `cert:${new URL(a.url).host}`, nome: `Certificado de ${new URL(a.url).host}`, fn: () => certificado(new URL(a.url).host) });
}
const vistos = new Set();
const unicos = itens.filter((i) => !vistos.has(i.chave) && vistos.add(i.chave));
const resultados = await Promise.all(unicos.map(async (i) => ({ ...i, erro: await checar(i.fn) })));

let caiu = 0;
for (const r of resultados) {
  const antes = estado[r.chave];
  if (r.erro) {
    caiu++;
    console.log(`FORA  ${r.nome}: ${r.erro}`);
    if (!antes) { estado[r.chave] = { desde: new Date().toISOString() }; await whatsapp(`🚨 *${r.nome}* fora do ar desde ${hora()} (${r.erro}). Duas checagens seguidas falharam. — Argos (monitor externo)`); }
  } else {
    console.log(`ok    ${r.nome}`);
    if (antes) { const min = Math.max(1, Math.round((Date.now() - new Date(antes.desde)) / 60000)); delete estado[r.chave]; await whatsapp(`✅ *${r.nome}* voltou às ${hora()} (ficou fora cerca de ${min} min). — Argos (monitor externo)`); }
  }
}
// Entradas de alvos removidos não ficam presas no estado.
for (const k of Object.keys(estado)) if (!unicos.some((i) => i.chave === k)) delete estado[k];
fs.writeFileSync(ESTADO, JSON.stringify(estado, null, 1));
console.log(`${unicos.length} verificações, ${caiu} com falha.`);
// Falha da rodada = e-mail automático do GitHub ao dono do repositório.
process.exit(caiu ? 1 : 0);
