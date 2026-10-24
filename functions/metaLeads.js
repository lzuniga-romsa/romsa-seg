// ═══════════════════════════════════════════════════════════════════════
// LEADS HOME automáticos desde Meta → colección `home_leads`
//
// Un solo webhook (metaLeadsWebhook en index.js) recibe de la app de Meta:
//   • WhatsApp Cloud API ("whatsapp_business_account"):
//       - messages            → mensaje del cliente (incluye `referral` cuando
//                               llega por un anuncio Click-to-WhatsApp)
//       - statuses "sent"     → respuesta enviada por la API
//       - smb_message_echoes  → respuesta enviada desde la app WhatsApp
//                               Business (modo coexistencia)
//   • Messenger ("page") y Instagram ("instagram"):
//       - messaging[].message → mensaje del cliente (con referral de anuncio)
//       - message.is_echo     → respuesta enviada desde la página / cuenta
//   • Formularios de Lead Ads ("page", changes field "leadgen")
//
// Reglas de negocio:
//   - Un cliente = un lead. Se identifica por `metaClave` ("wa:6861234567",
//     "fb:<PSID>", "ig:<IGSID>") y, para teléfonos, también se busca un lead
//     capturado a mano con el mismo número (últimos 10 dígitos).
//   - Mensaje entrante → pendienteRespuesta = true (alerta "Sin responder").
//     Respuesta saliente → pendienteRespuesta = false y cuenta como
//     movimiento (actualizadoEn), igual que un cambio manual.
//   - Si el lead estaba "Perdido" y vuelve a escribir, regresa a "Nuevo"
//     con nota en el historial. Si estaba "Ganado" se queda en Ganado.
//   - Los ecos/respuestas nunca crean leads; solo actualizan existentes.
//   - Cada mensaje guarda su id de Meta: si Meta reintenta el webhook no se
//     duplica en la conversación.
// ═══════════════════════════════════════════════════════════════════════
const crypto = require("crypto");

const GRAPH = "https://graph.facebook.com/v23.0";
const ZONA = "America/Tijuana";
const USUARIO_AUTO = "Meta (automático)";
const MAX_CONVERSACION = 30;
const MAX_TEXTO = 600;
const ETAPAS_CERRADAS = ["Ganado", "Perdido"];

// Palabras clave → servicio (mismos valores que LH_SERVICIOS en index.html).
// Se evalúa primero el texto del anuncio y luego el mensaje del cliente.
const REGLAS_SERVICIO = [
  [/ep[oó]xic|epoxy/i, "Piso epóxico residencial"],
  [/estampad/i, "Piso estampado"],
  [/banquet/i, "Restauración de banquetas"],
  [/grind|pulid|poliuretan/i, "Grind and Seal / Poliuretano"],
  [/colad|concreto|losa|firme|cochera|patio/i, "Colado"],
];

// ── Utilidades puras ────────────────────────────────────────────────────
function fechaLocal(iso) {
  // YYYY-MM-DD en hora de Mexicali (en-CA da ese formato)
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(iso ? new Date(iso) : new Date());
}

function isoDesdeSegundos(ts) {
  const n = Number(ts);
  if (!n) return new Date().toISOString();
  // Meta manda segundos en WhatsApp/leadgen y milisegundos en Messenger/IG
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

function soloDigitos(t) { return String(t || "").replace(/\D/g, ""); }

// WhatsApp manda "5216861234567" o "526861234567": para México se guarda en
// 10 dígitos, igual que la captura manual. Otros países, completo.
function telefonoLocal(waId) {
  const d = soloDigitos(waId);
  if (d.startsWith("521") && d.length === 13) return d.slice(3);
  if (d.startsWith("52") && d.length === 12) return d.slice(2);
  return d;
}

function variantesTelefono(tel) {
  const d = soloDigitos(tel);
  if (d.length !== 10) return d ? [d] : [];
  return [d, "52" + d, "521" + d];
}

function recortar(t) {
  const s = String(t || "").trim();
  return s.length > MAX_TEXTO ? s.slice(0, MAX_TEXTO - 1) + "…" : s;
}

function adivinarServicio(...textos) {
  for (const t of textos) {
    if (!t) continue;
    for (const [re, servicio] of REGLAS_SERVICIO) if (re.test(t)) return servicio;
  }
  return "";
}

function docIdPara(clave) { return "meta_" + String(clave).replace(/[^a-zA-Z0-9_-]/g, "_"); }

function textoWhatsApp(m) {
  if (!m) return "";
  switch (m.type) {
    case "text": return m.text && m.text.body;
    case "button": return m.button && m.button.text;
    case "interactive": {
      const i = m.interactive || {};
      return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || "[Respuesta interactiva]";
    }
    case "image": return "[Imagen]" + (m.image && m.image.caption ? " " + m.image.caption : "");
    case "video": return "[Video]" + (m.video && m.video.caption ? " " + m.video.caption : "");
    case "audio": return "[Audio]";
    case "document": return "[Documento]";
    case "location": return "[Ubicación]";
    case "sticker": return "[Sticker]";
    case "contacts": return "[Contacto]";
    case "reaction": return null; // las reacciones no son conversación
    default: return "[" + (m.type || "Mensaje") + "]";
  }
}

function textoMessenger(msg) {
  if (!msg) return "";
  if (msg.text) return msg.text;
  const a = Array.isArray(msg.attachments) && msg.attachments[0];
  if (a) return "[" + ({ image: "Imagen", video: "Video", audio: "Audio", file: "Archivo", location: "Ubicación" }[a.type] || "Adjunto") + "]";
  return "[Mensaje]";
}

function anuncioDesdeReferralWA(r) {
  if (!r) return null;
  return {
    adId: r.source_id || "",
    titulo: r.headline || "",
    cuerpo: recortar(r.body || ""),
    url: r.source_url || "",
    tipo: r.source_type || "",
    ctwaClid: r.ctwa_clid || "",
  };
}

function anuncioDesdeReferralFB(r) {
  if (!r) return null;
  if (r.source && String(r.source).toUpperCase() !== "ADS" && !r.ad_id) return null;
  return {
    adId: r.ad_id || "",
    titulo: (r.ads_context_data && r.ads_context_data.ad_title) || "",
    cuerpo: "",
    url: (r.ads_context_data && (r.ads_context_data.photo_url || r.ads_context_data.video_url)) || "",
    tipo: r.type || r.source || "",
    ctwaClid: "",
  };
}

// ── Payload de Meta → lista de eventos normalizados ─────────────────────
// Cada evento: { tipo: "mensaje"|"respuesta"|"formulario", canal, clave,
//   telefono, nombre, metaUserId, texto, fecha, mid, anuncio, leadgen }
function extraerEventos(body) {
  const eventos = [];
  if (!body || !Array.isArray(body.entry)) return eventos;

  if (body.object === "whatsapp_business_account") {
    for (const entry of body.entry) {
      for (const ch of entry.changes || []) {
        const v = ch.value || {};
        if (ch.field === "messages") {
          const nombres = {};
          for (const c of v.contacts || []) nombres[c.wa_id] = c.profile && c.profile.name;
          for (const m of v.messages || []) {
            const texto = textoWhatsApp(m);
            if (texto === null) continue;
            const tel = telefonoLocal(m.from);
            eventos.push({
              tipo: "mensaje", canal: "WhatsApp", clave: "wa:" + tel, telefono: tel,
              nombre: nombres[m.from] || "", metaUserId: m.from,
              texto: recortar(texto), fecha: isoDesdeSegundos(m.timestamp), mid: m.id || "",
              anuncio: anuncioDesdeReferralWA(m.referral),
            });
          }
          for (const s of v.statuses || []) {
            if (s.status !== "sent" || !s.recipient_id) continue;
            const tel = telefonoLocal(s.recipient_id);
            eventos.push({
              tipo: "respuesta", canal: "WhatsApp", clave: "wa:" + tel, telefono: tel,
              texto: "[Respuesta enviada]", fecha: isoDesdeSegundos(s.timestamp), mid: s.id || "",
            });
          }
        } else if (ch.field === "smb_message_echoes") {
          for (const m of v.message_echoes || []) {
            const texto = textoWhatsApp(m);
            if (texto === null || !m.to) continue;
            const tel = telefonoLocal(m.to);
            eventos.push({
              tipo: "respuesta", canal: "WhatsApp", clave: "wa:" + tel, telefono: tel,
              texto: recortar(texto), fecha: isoDesdeSegundos(m.timestamp), mid: m.id || "",
            });
          }
        }
      }
    }
    return eventos;
  }

  if (body.object === "page" || body.object === "instagram") {
    const canal = body.object === "page" ? "Messenger" : "Instagram";
    const pref = body.object === "page" ? "fb:" : "ig:";
    for (const entry of body.entry) {
      for (const ev of entry.messaging || []) {
        const msg = ev.message;
        if (!msg) continue; // delivery, read, postback sin texto, etc.
        if (msg.is_deleted || msg.is_unsupported) continue;
        const esEco = !!msg.is_echo;
        const usuario = esEco ? (ev.recipient && ev.recipient.id) : (ev.sender && ev.sender.id);
        if (!usuario) continue;
        eventos.push({
          tipo: esEco ? "respuesta" : "mensaje", canal, clave: pref + usuario, telefono: "",
          nombre: "", metaUserId: usuario,
          texto: recortar(textoMessenger(msg)), fecha: isoDesdeSegundos(ev.timestamp), mid: msg.mid || "",
          anuncio: esEco ? null : anuncioDesdeReferralFB(ev.referral || msg.referral),
        });
      }
      for (const ch of entry.changes || []) {
        if (ch.field !== "leadgen" || !ch.value || !ch.value.leadgen_id) continue;
        eventos.push({
          tipo: "formulario", canal: "Formulario", clave: "", telefono: "", nombre: "",
          texto: "", fecha: isoDesdeSegundos(ch.value.created_time), mid: "lg:" + ch.value.leadgen_id,
          leadgen: { id: String(ch.value.leadgen_id), adId: String(ch.value.ad_id || ""), formId: String(ch.value.form_id || "") },
        });
      }
    }
  }
  return eventos;
}

// ── Firma de Meta (X-Hub-Signature-256) ─────────────────────────────────
function firmaValida(rawBody, cabecera, appSecret) {
  if (!rawBody || !cabecera || !appSecret) return false;
  const esperada = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(String(cabecera));
  const b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Graph API (nombres de perfil y datos del formulario) ────────────────
async function graphGet(ruta, campos, token) {
  if (!token) return null;
  const url = `${GRAPH}/${encodeURIComponent(ruta)}?fields=${encodeURIComponent(campos)}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Graph ${ruta} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function nombrePerfil(ev, token, log) {
  try {
    if (ev.canal === "Messenger") {
      const p = await graphGet(ev.metaUserId, "first_name,last_name", token);
      return p ? [p.first_name, p.last_name].filter(Boolean).join(" ") : "";
    }
    if (ev.canal === "Instagram") {
      const p = await graphGet(ev.metaUserId, "name,username", token);
      return p ? (p.name || (p.username ? "@" + p.username : "")) : "";
    }
  } catch (e) {
    log.warn("[metaLeads] No se pudo leer el perfil", { canal: ev.canal, error: e.message });
  }
  return "";
}

// Convierte la respuesta de /{leadgen_id} en un evento de alta normal.
function eventoDesdeFormulario(ev, lead) {
  const campos = {};
  for (const f of (lead && lead.field_data) || []) campos[f.name] = (f.values || []).join(", ");
  const tomar = (...ks) => { for (const k of ks) if (campos[k]) { const v = campos[k]; ks.forEach(x => delete campos[x]); return v; } return ""; };
  const nombre = tomar("full_name", "nombre_completo", "nombre") || [tomar("first_name"), tomar("last_name")].filter(Boolean).join(" ");
  const tel = telefonoLocal(tomar("phone_number", "telefono", "teléfono", "celular"));
  const email = tomar("email", "correo");
  const dir = [tomar("street_address", "direccion", "dirección"), tomar("city", "ciudad")].filter(Boolean).join(", ");
  const extras = Object.keys(campos).map(k => `${k.replace(/_/g, " ")}: ${campos[k]}`);
  const anuncio = { adId: (lead && lead.ad_id) || ev.leadgen.adId, titulo: (lead && lead.ad_name) || "", cuerpo: "", url: "", tipo: "lead_form", ctwaClid: "", campana: (lead && lead.campaign_name) || "", formId: ev.leadgen.formId };
  return Object.assign({}, ev, {
    clave: tel ? "wa:" + tel : "lead:" + ev.leadgen.id,
    telefono: tel, nombre, metaUserId: "",
    fecha: lead && lead.created_time ? new Date(lead.created_time).toISOString() : ev.fecha,
    texto: recortar(["Formulario de anuncio", email && "Correo: " + email].concat(extras).filter(Boolean).join(" · ")),
    anuncio, email, direccion: dir,
  });
}

// ── Escritura en Firestore ──────────────────────────────────────────────
function entradaConversacion(ev) {
  return { dir: ev.tipo === "respuesta" ? "out" : "in", texto: ev.texto || "", fecha: ev.fecha, mid: ev.mid || "" };
}

function nombreProvisional(ev) {
  if (ev.canal === "WhatsApp" && ev.telefono) return "WhatsApp " + ev.telefono.slice(-4);
  return "Cliente " + ev.canal + " " + String(ev.metaUserId || "").slice(-4);
}

function leadNuevo(ev, nombre) {
  const ahora = new Date().toISOString();
  return {
    nombre: nombre || nombreProvisional(ev),
    telefono: ev.telefono || "",
    canal: ev.canal,
    servicio: adivinarServicio(ev.anuncio && ev.anuncio.titulo, ev.anuncio && ev.anuncio.cuerpo, ev.texto),
    direccion: ev.direccion || "",
    notas: ev.email ? "Correo: " + ev.email : "",
    fechaContacto: fechaLocal(ev.fecha),
    etapa: "Nuevo", fechaVisita: "", proximoSeguimiento: "", cotizacionId: "", cotizacionFolio: "", motivoPerdida: "",
    historial: [{ etapa: "Nuevo", fecha: ahora, usuario: USUARIO_AUTO }],
    creadoPor: USUARIO_AUTO, creadoPorUid: "", creadoEn: ahora, actualizadoEn: ahora,
    // Campos del flujo automático
    origen: "meta",
    metaClave: ev.clave,
    metaUserId: ev.metaUserId || "",
    anuncio: ev.anuncio || null,
    primerMensaje: ev.texto || "",
    ultimoMensaje: ev.texto || "",
    ultimoEntranteEn: ev.fecha,
    ultimaRespuestaEn: "",
    pendienteRespuesta: true, // formularios también: hay que contactarlos
    pendienteDesde: ev.fecha,
    mensajesEntrantes: 1,
    conversacion: [entradaConversacion(ev)],
  };
}

// Busca el lead del cliente: id determinista → metaClave → mismo teléfono
// (prefiere uno abierto). Todo dentro de la transacción.
async function buscarLead(tx, col, ev) {
  const refDet = col.doc(docIdPara(ev.clave));
  const det = await tx.get(refDet);
  if (det.exists) return det;
  const porClave = await tx.get(col.where("metaClave", "==", ev.clave).limit(1));
  if (!porClave.empty) return porClave.docs[0];
  const vars = variantesTelefono(ev.telefono);
  if (vars.length) {
    const porTel = await tx.get(col.where("telefono", "in", vars).limit(10));
    if (!porTel.empty) {
      const docs = porTel.docs.slice().sort((a, b) => String(b.get("creadoEn") || "").localeCompare(String(a.get("creadoEn") || "")));
      return docs.find(d => ETAPAS_CERRADAS.indexOf(d.get("etapa")) === -1) || docs[0];
    }
  }
  return null;
}

// Aplica un evento ya normalizado. `nombreExtra` es el nombre de perfil ya
// resuelto (fuera de la transacción, porque es una llamada de red).
async function aplicarEvento(db, ev, nombreExtra) {
  const col = db.collection("home_leads");
  return db.runTransaction(async (tx) => {
    const snap = await buscarLead(tx, col, ev);

    if (!snap) {
      if (ev.tipo === "respuesta") return "ignorado";
      tx.set(col.doc(docIdPara(ev.clave)), leadNuevo(ev, ev.nombre || nombreExtra));
      return "creado";
    }

    const l = snap.data() || {};
    const conv = Array.isArray(l.conversacion) ? l.conversacion : [];
    if (ev.mid && conv.some(c => c.mid === ev.mid)) return "duplicado";
    const nuevaConv = conv.concat([entradaConversacion(ev)]).slice(-MAX_CONVERSACION);
    const cambios = { conversacion: nuevaConv };
    if (!l.metaClave) cambios.metaClave = ev.clave;
    if (!l.origen) cambios.origen = "meta";

    if (ev.tipo === "respuesta") {
      cambios.ultimaRespuestaEn = ev.fecha;
      cambios.pendienteRespuesta = false;
      cambios.pendienteDesde = "";
      cambios.actualizadoEn = new Date().toISOString();
    } else {
      cambios.ultimoMensaje = ev.texto || "";
      cambios.ultimoEntranteEn = ev.fecha;
      cambios.mensajesEntrantes = (Number(l.mensajesEntrantes) || 0) + 1;
      if (!l.pendienteRespuesta) { cambios.pendienteRespuesta = true; cambios.pendienteDesde = ev.fecha; }
      if (!l.primerMensaje) cambios.primerMensaje = ev.texto || "";
      if (ev.anuncio) { if (!l.anuncio) cambios.anuncio = ev.anuncio; cambios.ultimoAnuncio = ev.anuncio; }
      if (!l.servicio) { const s = adivinarServicio(ev.anuncio && ev.anuncio.titulo, ev.texto); if (s) cambios.servicio = s; }
      if (ev.telefono && !l.telefono) cambios.telefono = ev.telefono;
      const mejorNombre = ev.nombre || nombreExtra;
      if (mejorNombre && /^(WhatsApp \d{4}|Cliente (Messenger|Instagram|Formulario) )/.test(String(l.nombre || ""))) cambios.nombre = mejorNombre;
      if (l.etapa === "Perdido") {
        const ahora = new Date().toISOString();
        cambios.etapa = "Nuevo";
        cambios.motivoPerdida = "";
        cambios.historial = (Array.isArray(l.historial) ? l.historial : []).concat([{ etapa: "Nuevo", fecha: ahora, usuario: USUARIO_AUTO, nota: "Volvió a escribir" }]);
        cambios.actualizadoEn = ahora;
      }
    }
    tx.update(snap.ref, cambios);
    return "actualizado";
  });
}

// Punto de entrada por evento: resuelve formulario/perfil y aplica.
async function procesarEvento(db, ev, { pageToken, log }) {
  let e = ev;
  if (ev.tipo === "formulario") {
    const lead = await graphGet(ev.leadgen.id, "field_data,created_time,ad_id,ad_name,campaign_name,form_id", pageToken);
    if (!lead) throw new Error("Falta META_PAGE_TOKEN para leer el formulario " + ev.leadgen.id);
    e = eventoDesdeFormulario(ev, lead);
  }
  let nombreExtra = "";
  if (e.tipo === "mensaje" && !e.nombre && (e.canal === "Messenger" || e.canal === "Instagram")) {
    nombreExtra = await nombrePerfil(e, pageToken, log);
  }
  return aplicarEvento(db, e, nombreExtra);
}

module.exports = {
  extraerEventos, firmaValida, procesarEvento, aplicarEvento,
  // expuestas para pruebas
  _t: { telefonoLocal, variantesTelefono, adivinarServicio, fechaLocal, eventoDesdeFormulario, leadNuevo, docIdPara },
};
