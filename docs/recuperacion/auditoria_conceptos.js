// AUDITORÍA DE SOLO LECTURA — cotizaciones y costeos posiblemente afectados
// por la pérdida de conceptos / IVA desglosado (ver PR "Guardado de conceptos e IVA HOME").
//
// Cómo usarla: abre el CRM con una cuenta ADMIN, entra a Cotizaciones,
// abre la consola del navegador (F12 → Console), pega TODO este archivo y
// presiona Enter. No escribe nada en Firestore. Al terminar muestra tablas
// y descarga "auditoria_conceptos_<fecha>.json".
(async () => {
  const MERGE_IVA_HOME = Date.parse("2026-10-12T06:14:14Z"); // PR #57 (IVA incluido HOME) en producción
  const cots = (await db.collection("cotizaciones").get()).docs.map(d => d.data());
  const cos = (await db.collection("costeos").get()).docs.map(d => d.data());
  const cosPorId = Object.fromEntries(cos.map(c => [c.id, c]));
  const conContenido = p => p && (String(p.servicio || "").trim() || String(p.tituloCustom || "").trim() || String(p.desc || "").trim() || (+p.qty || 0) > 0 || (+p.precio || 0) > 0);
  const nCon = ps => (ps || []).filter(conContenido).length;
  const lineas = ss => (ss || []).reduce((n, s) => n + ((s && s.partidas) || []).length, 0);
  const fecha = ts => ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "";
  const fila = (c, motivo) => ({ id: c.id, folio: c.folio || "", modalidad: c.modalidad || "industrial", proyecto: c.proyecto || "", ultimoGuardado: fecha(c.ts), estado: c.estado || "", motivo });

  const R = { cotSinConceptos: [], cotSistemasPerdidos: [], costeoSinSistemas: [], costeoSistemasPerdidos: [], cotHomeComoIndustrial: [], cotHomeSinIvaIncluido: [] };
  cots.forEach(c => {
    if (!nCon(c.partidas)) R.cotSinConceptos.push(fila(c, "0 conceptos con contenido (granTotal guardado: " + (c.granTotal || 0) + ")"));
    const co = c.costeoIdOrigen && cosPorId[c.costeoIdOrigen];
    if (co) {
      const ids = new Set((co.sistemas || []).map(s => s.id));
      const vinculadas = (c.partidas || []).filter(p => p.sistemaId !== undefined && p.sistemaId !== null && p.sistemaId !== "");
      if ((co.sistemas || []).length > (c.partidas || []).length) R.cotSistemasPerdidos.push(fila(c, "su costeo " + co.folio + " tiene " + co.sistemas.length + " sistemas y la cotización " + (c.partidas || []).length + " conceptos"));
      const huerfanas = vinculadas.filter(p => !ids.has(p.sistemaId));
      if (huerfanas.length) R.costeoSistemasPerdidos.push(Object.assign(fila(co, huerfanas.length + " concepto(s) de " + c.folio + " apuntan a sistemas que ya no existen en el costeo"), { cotizacion: c.folio }));
      if (co.modalidad === "home" && c.modalidad !== "home") R.cotHomeComoIndustrial.push(fila(c, "generada desde el costeo HOME " + co.folio + " pero guardada como " + (c.modalidad || "industrial")));
    }
    if (c.modalidad === "home" && !c.ivaIncluido && (c.ts || 0) >= MERGE_IVA_HOME) R.cotHomeSinIvaIncluido.push(fila(c, "HOME guardada después del 12-oct sin ivaIncluido (muestra Subtotal + IVA)"));
  });
  cos.forEach(c => {
    if (!(c.sistemas || []).length || !lineas(c.sistemas)) R.costeoSinSistemas.push(fila(c, (c.sistemas || []).length + " sistemas, " + lineas(c.sistemas) + " líneas; precioTotal guardado " + (c.precioTotal || 0) + (c.cotizacionIdGenerada ? "; vinculado a " + (c.folioCotizacionGenerada || c.cotizacionIdGenerada) : "")));
  });
  Object.entries(R).forEach(([k, v]) => { console.log("%c" + k + " (" + v.length + ")", "font-weight:bold"); if (v.length) console.table(v); });
  const blob = new Blob([JSON.stringify({ generado: new Date().toISOString(), totales: { cotizaciones: cots.length, costeos: cos.length }, resultados: R }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "auditoria_conceptos_" + new Date().toISOString().slice(0, 10) + ".json"; a.click();
})();
