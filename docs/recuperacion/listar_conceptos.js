// SOLO LECTURA — lista el catálogo de conceptos guardado en Firestore
// (colección cotizacion_catalogo_conceptos), para confirmar qué conceptos
// existen (por ejemplo los de piso estampado) antes y después del arreglo.
// Uso: abre el CRM con tu cuenta, F12 → Console, pega este archivo y Enter.
(async () => {
  const snap = await db.collection("cotizacion_catalogo_conceptos").get({ source: "server" });
  const filas = snap.docs.map(d => { const c = d.data(); return { id: d.id, nombre: c.nombre || "(sin nombre)", categoria: c.categoria || "", activo: c.activo !== false, unidad: c.unidad || "", precioBase: c.precioBase || 0, guardado: c.ts ? new Date(c.ts).toISOString().slice(0, 16).replace("T", " ") : "" }; })
    .sort((a, b) => (a.categoria + a.nombre).localeCompare(b.categoria + b.nombre, "es"));
  console.log("Conceptos en el catálogo: " + filas.length);
  console.table(filas);
  const estampado = filas.filter(f => /estampad/i.test(f.nombre + " " + f.categoria));
  console.log(estampado.length ? "Piso estampado (" + estampado.length + "): " + estampado.map(f => f.nombre + (f.activo ? "" : " [inactivo]")).join(" | ") : "⚠️ No hay ningún concepto de piso estampado en Firestore.");
})();
