const assert = require("assert");
const crypto = require("crypto");
const M = require("../metaLeads.js");

// ── Firestore falso en memoria ──
function fakeDb(){
  const store = {};
  const mkSnap = (id, data) => ({ id, exists: !!data, data: () => data && JSON.parse(JSON.stringify(data)), get: k => data && data[k], ref: mkRef(id) });
  function mkRef(id){ return { id, _kind:"doc" }; }
  function query(filters, lim){
    return { _kind:"q", where:(f,op,v)=>query(filters.concat([[f,op,v]]),lim), limit:n=>query(filters,n), _run(){
      let docs = Object.keys(store).filter(id => filters.every(([f,op,v]) => op==="==" ? store[id][f]===v : v.includes(store[id][f]))).map(id=>mkSnap(id,store[id]));
      if(lim) docs = docs.slice(0,lim);
      return { empty: !docs.length, docs };
    }};
  }
  const col = { doc: id => mkRef(id), where:(f,op,v)=>query([[f,op,v]]) };
  return { store, collection: () => col,
    runTransaction: async fn => { const w=[]; const tx = {
      get: async r => r._kind==="q" ? r._run() : mkSnap(r.id, store[r.id]),
      set: (r,d) => w.push(()=>{ store[r.id]=JSON.parse(JSON.stringify(d)); }),
      update: (r,d) => w.push(()=>{ Object.assign(store[r.id], JSON.parse(JSON.stringify(d))); }) };
      const out = await fn(tx); w.forEach(f=>f()); return out; } };
}
const log = { warn(){}, info(){}, error(){} };

(async () => {
  // Utilidades
  assert.strictEqual(M._t.telefonoLocal("5216861234567"), "6861234567");
  assert.strictEqual(M._t.telefonoLocal("526861234567"), "6861234567");
  assert.strictEqual(M._t.adivinarServicio("Pisos epóxicos para tu cochera"), "Piso epóxico residencial");
  assert.strictEqual(M._t.adivinarServicio("", "quiero colar mi patio"), "Colado");
  assert.strictEqual(M._t.fechaLocal("2026-10-23T05:30:00Z"), "2026-10-22"); // 22:30 Mexicali

  // Firma
  const raw = Buffer.from('{"a":1}');
  const sig = "sha256=" + crypto.createHmac("sha256","s3cr3t").update(raw).digest("hex");
  assert.ok(M.firmaValida(raw, sig, "s3cr3t"));
  assert.ok(!M.firmaValida(raw, sig, "otro"));
  assert.ok(!M.firmaValida(raw, undefined, "s3cr3t"));

  const db = fakeDb();
  // Lead manual previo con el mismo teléfono (capturado a mano)
  db.store["manual1"] = { nombre:"Laura Méndez", telefono:"6861234567", canal:"WhatsApp", etapa:"Info enviada", creadoEn:"2026-10-01T00:00:00Z", historial:[] };

  // 1) WhatsApp desde anuncio CTWA, cliente nuevo
  const wa = { object:"whatsapp_business_account", entry:[{ changes:[{ field:"messages", value:{
    contacts:[{ wa_id:"5216869998877", profile:{ name:"Jorge Ruiz" } }],
    messages:[{ from:"5216869998877", id:"wamid.A1", timestamp:"1792560000", type:"text", text:{ body:"Hola, info del piso" },
      referral:{ source_url:"https://fb.me/x", source_id:"120001", source_type:"ad", headline:"Pisos epóxicos residenciales", body:"Cochera nueva", ctwa_clid:"clid1" } }] } }] }] };
  let evs = M.extraerEventos(wa);
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(await M.procesarEvento(db, evs[0], { log }), "creado");
  const idJ = M._t.docIdPara("wa:6869998877");
  let J = db.store[idJ];
  assert.strictEqual(J.nombre, "Jorge Ruiz");
  assert.strictEqual(J.telefono, "6869998877");
  assert.strictEqual(J.servicio, "Piso epóxico residencial");
  assert.strictEqual(J.anuncio.adId, "120001");
  assert.strictEqual(J.pendienteRespuesta, true);
  assert.strictEqual(J.etapa, "Nuevo");

  // 1b) Reintento de Meta: no duplica
  assert.strictEqual(await M.procesarEvento(db, evs[0], { log }), "duplicado");
  assert.strictEqual(db.store[idJ].conversacion.length, 1);

  // 2) Respuesta desde la app WA Business (coexistencia)
  const eco = { object:"whatsapp_business_account", entry:[{ changes:[{ field:"smb_message_echoes", value:{
    message_echoes:[{ from:"5216860000000", to:"5216869998877", id:"wamid.B1", timestamp:"1792560300", type:"text", text:{ body:"Claro, ¿cuántos m2?" } }] } }] }] };
  evs = M.extraerEventos(eco);
  assert.strictEqual(await M.procesarEvento(db, evs[0], { log }), "actualizado");
  J = db.store[idJ];
  assert.strictEqual(J.pendienteRespuesta, false);
  assert.strictEqual(J.conversacion[1].dir, "out");

  // 3) Respuesta a un número que no es lead → se ignora
  const eco2 = JSON.parse(JSON.stringify(eco)); eco2.entry[0].changes[0].value.message_echoes[0].to = "5216861112222"; eco2.entry[0].changes[0].value.message_echoes[0].id="x";
  assert.strictEqual(await M.procesarEvento(db, M.extraerEventos(eco2)[0], { log }), "ignorado");

  // 4) Mensaje del número del lead manual → se pega al manual, no crea otro
  const wa2 = JSON.parse(JSON.stringify(wa)); const m2 = wa2.entry[0].changes[0].value;
  m2.contacts[0].wa_id = m2.messages[0].from = "5216861234567"; m2.messages[0].id = "wamid.C1"; delete m2.messages[0].referral;
  assert.strictEqual(await M.procesarEvento(db, M.extraerEventos(wa2)[0], { log }), "actualizado");
  assert.strictEqual(db.store["manual1"].metaClave, "wa:6861234567");
  assert.strictEqual(db.store["manual1"].pendienteRespuesta, true);
  assert.strictEqual(db.store["manual1"].nombre, "Laura Méndez"); // no pisa el nombre real
  assert.ok(!db.store[M._t.docIdPara("wa:6861234567")]);

  // 5) Lead perdido que vuelve a escribir → regresa a Nuevo
  db.store["manual1"].etapa = "Perdido"; db.store["manual1"].motivoPerdida = "Precio";
  m2.messages[0].id = "wamid.C2";
  await M.procesarEvento(db, M.extraerEventos(wa2)[0], { log });
  assert.strictEqual(db.store["manual1"].etapa, "Nuevo");
  assert.strictEqual(db.store["manual1"].motivoPerdida, "");

  // 6) Messenger con anuncio + eco (sin token: nombre provisional)
  const fb = { object:"page", entry:[{ id:"PAGE", messaging:[
    { sender:{ id:"PSID123456" }, recipient:{ id:"PAGE" }, timestamp:1792560000000, message:{ mid:"m_1", text:"¿Hacen estampado?" },
      referral:{ source:"ADS", type:"OPEN_THREAD", ad_id:"777", ads_context_data:{ ad_title:"Piso estampado HOME" } } },
    { sender:{ id:"PAGE" }, recipient:{ id:"PSID123456" }, timestamp:1792560100000, message:{ mid:"m_2", is_echo:true, text:"¡Sí! ¿De qué tamaño?" } },
    { sender:{ id:"PSID123456" }, recipient:{ id:"PAGE" }, timestamp:1792560200000, read:{ watermark:1 } } ] }] };
  evs = M.extraerEventos(fb);
  assert.strictEqual(evs.length, 2);
  for (const e of evs) await M.procesarEvento(db, e, { log });
  const F = db.store[M._t.docIdPara("fb:PSID123456")];
  assert.strictEqual(F.canal, "Messenger");
  assert.strictEqual(F.servicio, "Piso estampado");
  assert.strictEqual(F.anuncio.titulo, "Piso estampado HOME");
  assert.strictEqual(F.pendienteRespuesta, false);
  assert.ok(F.nombre.startsWith("Cliente Messenger"));

  // 7) Instagram
  const ig = { object:"instagram", entry:[{ id:"IGACC", messaging:[{ sender:{ id:"IGSID9" }, recipient:{ id:"IGACC" }, timestamp:1792560000000, message:{ mid:"ig_1", text:"precio banqueta" } }] }] };
  evs = M.extraerEventos(ig);
  await M.procesarEvento(db, evs[0], { log });
  assert.strictEqual(db.store[M._t.docIdPara("ig:IGSID9")].servicio, "Restauración de banquetas");

  // 8) Formulario de Lead Ads (Graph simulado)
  global.fetch = async (url) => ({ ok:true, json: async () => ({ created_time:"2026-10-22T20:00:00+0000", ad_id:"888", ad_name:"Colados HOME · Form", campaign_name:"Colados Oct",
    field_data:[ { name:"full_name", values:["Ana Torres"] }, { name:"phone_number", values:["+526865554433"] }, { name:"city", values:["Mexicali"] }, { name:"¿cuántos_m2?", values:["40"] } ] }) });
  const lg = { object:"page", entry:[{ id:"PAGE", changes:[{ field:"leadgen", value:{ leadgen_id:"LG1", form_id:"F1", ad_id:"888", created_time:1792560000 } }] }] };
  evs = M.extraerEventos(lg);
  assert.strictEqual(await M.procesarEvento(db, evs[0], { pageToken:"tok", log }), "creado");
  const A = db.store[M._t.docIdPara("wa:6865554433")];
  assert.strictEqual(A.nombre, "Ana Torres");
  assert.strictEqual(A.canal, "Formulario");
  assert.strictEqual(A.servicio, "Colado");
  assert.strictEqual(A.direccion, "Mexicali");
  assert.ok(A.primerMensaje.includes("40"));
  assert.strictEqual(A.anuncio.campana, "Colados Oct");

  // 9) Payload basura
  assert.deepStrictEqual(M.extraerEventos(null), []);
  assert.deepStrictEqual(M.extraerEventos({ object:"user", entry:[{}] }), []);
  console.log("TODAS LAS PRUEBAS PASAN");
})().catch(e => { console.error(e); process.exit(1); });
