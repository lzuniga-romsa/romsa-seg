// LECTURA DE VERSIONES ANTERIORES (solo lectura, no restaura nada).
// Lee cotizaciones/costeos tal como estaban en una fecha pasada usando
// lecturas con readTime de Firestore (point-in-time):
//   • Sin PITR: Firestore solo permite leer hasta ~1 hora atrás.
//   • Con PITR activado (Consola Firebase → Firestore → Recuperación ante
//     desastres → Point-in-time recovery): hasta 7 días atrás, en minutos exactos.
//
// Uso (en una computadora con Node 18+):
//   npm i firebase-admin
//   GOOGLE_APPLICATION_CREDENTIALS=cuenta-de-servicio.json \
//     node leer_version_anterior.js 2026-10-24T15:00:00Z cotizaciones:ID1 costeos:ID2 ...
// Guarda cada documento en ./versiones/<coleccion>_<id>_<fecha>.json para
// compararlo con el actual. Nada se escribe en Firestore.
const admin = require("firebase-admin");
const fs = require("fs");
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const [, , cuando, ...docs] = process.argv;
if (!cuando || !docs.length) { console.error("Uso: node leer_version_anterior.js <fecha ISO> coleccion:id ..."); process.exit(1); }
const readTime = admin.firestore.Timestamp.fromDate(new Date(cuando));
(async () => {
  fs.mkdirSync("versiones", { recursive: true });
  await db.runTransaction(async (tx) => {
    for (const d of docs) {
      const [col, id] = d.split(":");
      const snap = await tx.get(db.collection(col).doc(id));
      const archivo = "versiones/" + col + "_" + id + "_" + cuando.replace(/[:]/g, "") + ".json";
      fs.writeFileSync(archivo, JSON.stringify(snap.exists ? snap.data() : null, null, 2));
      const x = snap.exists ? snap.data() : {};
      console.log(col + "/" + id + " @ " + cuando + ": " + (snap.exists ? ((x.partidas || []).length + " conceptos, " + (x.sistemas || []).length + " sistemas") : "no existía") + " → " + archivo);
    }
  }, { readOnly: true, readTime });
})().catch(e => { console.error(e.message || e); process.exit(1); });
