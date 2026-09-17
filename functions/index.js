const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const Anthropic = require("@anthropic-ai/sdk");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const ffmpegPath = require("ffmpeg-static");

const execFileAsync = promisify(execFile);

// NO se llama initializeApp() aquí a nivel de módulo — ver
// asegurarAdminApp() más abajo, invocada de forma perezosa DENTRO de
// convertirVideoAMp4. Ya nos topamos exactamente con este mismo error una
// vez antes (commit d3722cd, "Corregir timeout de deploy en
// diagnosticoVisualIA"): admin.initializeApp() a nivel de módulo, al
// correr sin credenciales locales (ADC) configuradas, intenta resolver
// contra el metadata server de GCE y se cuelga hasta agotar la ventana de
// 10s que usa firebase-tools para descubrir qué funciones existen en el
// archivo — ANTES de subir nada, sin relación con permisos IAM. En aquel
// caso la solución fue quitar firebase-admin por completo porque
// diagnosticoVisualIA nunca lo necesitó; esta vez sí hace falta (Storage
// real para descargar/subir el video), así que se difiere la
// inicialización al momento de la llamada real en vez de quitarla.
function asegurarAdminApp() {
  if (!getApps().length) initializeApp();
}

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// Debe coincidir con _fbCfg.storageBucket en index.html — se usa para
// verificar que imageUrl apunta a una foto de ESTE proyecto, no a una
// URL arbitraria (evita que el callable se use como proxy gratuito de
// análisis de imágenes con la llave de Anthropic de la empresa).
const BUCKET_ESPERADO = "romsa-industrial.firebasestorage.app";

// Modelo con visión usado para el diagnóstico. Cambiar aquí si se quiere
// otro balance costo/calidad.
const CLAUDE_MODEL = "claude-sonnet-5";

// Se agrega SIEMPRE al final de notaImportante, sin depender de que el
// modelo lo redacte correctamente — es un requisito de negocio, no una
// sugerencia al modelo.
const DISCLAIMER_OBLIGATORIO =
  "Este diagnóstico es apoyo de decisión generado por IA a partir de una fotografía, no es un dictamen técnico definitivo. " +
  "La responsabilidad de garantía del proyecto la sigue asumiendo el dueño/responsable técnico de ROMSA, quien debe validar en sitio antes de comprometerse.";

const SYSTEM_PROMPT = `Eres un asistente de apoyo a la decisión para ROMSA Industrial, especialistas en recubrimientos de pisos industriales. Tu trabajo es dar una primera lectura visual de fotografías de pisos/obras dañadas para ayudar al equipo comercial a decidir si conviene tomar un proyecto, ANTES de una inspección técnica en sitio.

Evalúa el daño mostrado usando este marco de referencia (son las 3 categorías más comunes que ve la empresa; si el daño no encaja claramente en ninguna, descríbelo con tu mejor criterio en tipoDetectado sin forzarlo a una de estas):

1. Agrietamiento por contracción (fisuras finas, típicamente por curado o contracción normal del concreto) → riesgo BAJO. Generalmente SÍ se puede tomar el proyecto.
2. Agrietamiento estructural (grietas anchas, con desnivel, patrón de asentamiento, cruces de losa, etc.) → riesgo ALTO. Recomienda evaluar con cautela; puede requerir reparación estructural previa antes de cualquier recubrimiento.
3. Humedad ascendente (manchas de humedad, eflorescencia, ampollamiento) → riesgo ALTO si no se resuelve el origen de la humedad antes de recubrir.

Responde ÚNICAMENTE llamando a la herramienta "reportar_diagnostico" con el JSON estructurado — no escribas texto libre fuera de la herramienta. Sé conciso, concreto y en español. No inventes certeza que no tienes: si la imagen no permite ver algo con claridad (mala iluminación, ángulo, resolución), dilo en notaImportante.`;

const DIAGNOSTICO_TOOL = {
  name: "reportar_diagnostico",
  description: "Reporta el diagnóstico visual estructurado del daño detectado en la fotografía.",
  input_schema: {
    type: "object",
    properties: {
      tipoDetectado: {
        type: "string",
        description: "Tipo de daño identificado (ej. 'Agrietamiento por contracción', 'Agrietamiento estructural', 'Humedad ascendente', u otro si no encaja en esas 3 categorías)."
      },
      causaProbable: {
        type: "string",
        description: "Explicación breve y técnica de la causa más probable del daño observado."
      },
      consecuenciasPosibles: {
        type: "string",
        description: "Consecuencias posibles si no se atiende antes de recubrir/reparar."
      },
      nivelRiesgo: {
        type: "string",
        enum: ["bajo", "medio", "alto"],
        description: "Nivel de riesgo para tomar el proyecto tal como está."
      },
      recomendacionTomarProyecto: {
        type: "string",
        enum: ["si", "con-reservas", "no"],
        description: "Recomendación sobre si tomar el proyecto."
      },
      notaImportante: {
        type: "string",
        description: "Nota específica de ESTE caso sobre limitaciones del análisis (ej. mala iluminación, ángulo insuficiente, se recomienda inspección adicional en tal zona). NO incluyas aquí un disclaimer general — se agrega aparte automáticamente."
      }
    },
    required: ["tipoDetectado", "causaProbable", "consecuenciasPosibles", "nivelRiesgo", "recomendacionTomarProyecto", "notaImportante"]
  }
};

function validarImageUrl(imageUrl) {
  let u;
  try {
    u = new URL(imageUrl);
  } catch (e) {
    throw new HttpsError("invalid-argument", "imageUrl no es una URL válida.");
  }
  if (u.protocol !== "https:") {
    throw new HttpsError("invalid-argument", "imageUrl debe usar https.");
  }
  const hostPermitido =
    u.hostname === "firebasestorage.googleapis.com" ||
    u.hostname === "storage.googleapis.com" ||
    u.hostname.endsWith(".firebasestorage.app");
  if (!hostPermitido || !imageUrl.includes(BUCKET_ESPERADO)) {
    throw new HttpsError(
      "invalid-argument",
      "imageUrl debe ser una foto de Firebase Storage de este proyecto (romsa-industrial)."
    );
  }
}

const TIPOS_IMAGEN_SOPORTADOS = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_BYTES_IMAGEN = 15 * 1024 * 1024;

async function descargarImagenBase64(imageUrl) {
  let res;
  try {
    res = await fetch(imageUrl);
  } catch (e) {
    throw new HttpsError("failed-precondition", "No se pudo descargar la imagen desde imageUrl.");
  }
  if (!res.ok) {
    throw new HttpsError("failed-precondition", `No se pudo descargar la imagen (HTTP ${res.status}).`);
  }
  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
  if (!TIPOS_IMAGEN_SOPORTADOS.includes(contentType)) {
    throw new HttpsError("invalid-argument", `Formato de imagen no soportado: ${contentType || "desconocido"}.`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES_IMAGEN) {
    throw new HttpsError("invalid-argument", "La imagen es demasiado grande (máx. 15 MB).");
  }
  return { base64: buf.toString("base64"), mediaType: contentType };
}

exports.diagnosticoVisualIA = onCall(
  { secrets: [ANTHROPIC_API_KEY], region: "us-central1", timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión para usar el diagnóstico visual con IA.");
    }

    const { imageUrl, descripcion } = request.data || {};
    if (typeof imageUrl !== "string" || !imageUrl.trim()) {
      throw new HttpsError("invalid-argument", "Falta imageUrl.");
    }
    if (typeof descripcion !== "string" || !descripcion.trim()) {
      throw new HttpsError("invalid-argument", "Falta descripcion.");
    }
    if (descripcion.length > 2000) {
      throw new HttpsError("invalid-argument", "La descripción es demasiado larga (máx. 2000 caracteres).");
    }

    validarImageUrl(imageUrl);
    const { base64, mediaType } = await descargarImagenBase64(imageUrl);

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

    let msg;
    try {
      msg = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [DIAGNOSTICO_TOOL],
        tool_choice: { type: "tool", name: "reportar_diagnostico" },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
              { type: "text", text: `Descripción del problema reportada por el técnico: ${descripcion}` }
            ]
          }
        ]
      });
    } catch (err) {
      logger.error("Error llamando a Anthropic API:", err);
      throw new HttpsError(
        "internal",
        "El servicio de diagnóstico no respondió correctamente. Intenta de nuevo en unos momentos."
      );
    }

    const toolUse = (msg.content || []).find((b) => b.type === "tool_use" && b.name === "reportar_diagnostico");
    if (!toolUse || !toolUse.input) {
      logger.error("Respuesta de Anthropic sin tool_use esperado:", JSON.stringify(msg));
      throw new HttpsError("internal", "No se pudo interpretar la respuesta del diagnóstico.");
    }

    const resultado = toolUse.input;
    resultado.notaImportante =
      (resultado.notaImportante ? String(resultado.notaImportante).trim() + " " : "") + DISCLAIMER_OBLIGATORIO;

    logger.info("Diagnóstico visual IA generado", {
      uid: request.auth.uid,
      nivelRiesgo: resultado.nivelRiesgo,
      recomendacion: resultado.recomendacionTomarProyecto
    });

    return resultado;
  }
);

// ══════════════════════════════════════════════════════════════
// Generador de Video — conversión de .webm (salida real de
// MediaRecorder/canvas.captureStream, sin cambios en ese pipeline) a .mp4
// (H.264 + AAC) con ffmpeg real, para que el video final se reproduzca y
// descargue sin problemas en cualquier celular.
//
// Diseño: trigger de STORAGE (onObjectFinalized), NO callable (onCall).
// Se intentó como callable primero, pero el proyecto tiene una política
// de organización (Domain Restricted Sharing) que bloquea otorgar
// invocación pública (allUsers) a Cloud Run — confirmado directamente por
// Google: "gcloud functions add-invoker-policy-binding" regresó
// HTTP 400 "perhaps due to an organization policy", y los logs reales de
// Cloud Run mostraban el preflight OPTIONS rechazado con 403 antes de que
// el código de la función llegara a correr (0 invocaciones reales, pese a
// que el contenedor arrancaba sano). Un trigger de Storage evita el
// problema de raíz: Eventarc entrega el evento con una identidad de
// servicio interna de Google, no con acceso público, así que la política
// de organización no aplica.
//
// El cliente sube el .webm a Storage exactamente igual que antes
// (storage.ref().child(path).put(...)); esta función se dispara sola al
// terminar esa subida, sin que el navegador la invoque directamente. Como
// ya no hay una respuesta síncrona que devolver, el resultado se escribe
// en Firestore (video_conversions/{uid}/jobs/{ts}) y el cliente lo
// escucha con onSnapshot — mismo patrón que ya usa el resto del CRM para
// datos en tiempo real.
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const MAX_BYTES_VIDEO_WEBM = 300 * 1024 * 1024; // 300 MB — generoso para un reel de pocos minutos, pero acotado.
const VIGENCIA_URL_MP4_MS = 7 * 24 * 60 * 60 * 1000; // 7 días.

// video-exports/{uid}/{timestamp}.webm — mismo patrón que ya usaba el
// callable anterior. Este trigger se dispara para CUALQUIER archivo
// finalizado en el bucket completo (fotos de obras, etc.), así que el
// regex filtra explícitamente y descarta (return temprano, sin costo real
// más allá de la invocación mínima) todo lo que no sea un .webm dentro de
// esta carpeta específica.
const PATRON_STORAGE_PATH = /^video-exports\/([^/]+)\/(\d+)\.webm$/;

exports.convertirVideoAMp4 = onObjectFinalized(
  // El bucket de Storage de este proyecto vive en us-west1, no en
  // us-central1 (donde sigue diagnosticoVisualIA, sin relación con
  // Storage) — un trigger de Storage exige que la función y el bucket
  // estén en la MISMA región, o el deploy falla con "A function in
  // region us-central1 cannot listen to a bucket in region us-west1".
  { region: "us-west1", timeoutSeconds: 300, memory: "1GiB" },
  async (event) => {
    const storagePath = event.data.name || "";
    const match = PATRON_STORAGE_PATH.exec(storagePath);
    if (!match) return; // no es un .webm de video-exports/{uid}/ — no es para nosotros.
    const [, uid, ts] = match;

    asegurarAdminApp();
    const db = getFirestore();
    const jobRef = db.collection("video_conversions").doc(uid).collection("jobs").doc(ts);

    const bucket = getStorage().bucket(event.data.bucket);
    const archivoWebm = bucket.file(storagePath);
    const nombreBase = path.basename(storagePath, ".webm");
    const tmpWebm = path.join(os.tmpdir(), `in_${nombreBase}.webm`);
    const tmpMp4 = path.join(os.tmpdir(), `out_${nombreBase}.mp4`);
    const mp4Path = storagePath.slice(0, -".webm".length) + ".mp4";

    await jobRef.set({
      status: "procesando",
      creadoEn: FieldValue.serverTimestamp(),
    });

    try {
      const bytesEntrada = Number(event.data.size || 0);
      if (bytesEntrada > MAX_BYTES_VIDEO_WEBM) {
        throw new Error("El video es demasiado grande para convertir (máx. 300 MB).");
      }

      await archivoWebm.download({ destination: tmpWebm });

      // H.264 High/yuv420p + AAC + faststart: el combo con mejor compatibilidad
      // conocida en iOS/Android/escritorio (yuv420p en particular es lo que
      // exige Safari/QuickTime para decodificar por hardware).
      //
      // -fps_mode vfr (antes "-r 30 -fps_mode cfr"): el .webm de entrada
      // (canvas.captureStream(30) + MediaRecorder) NUNCA captura 30fps reales
      // parejos — se confirmó con showinfo+mpdecimate sobre .webm reales
      // exportados por el pipeline en vivo que el promedio real va de ~13.6fps
      // (timeline pesado) a ~29.3fps (timeline ligero), nunca 30 parejo.
      // Forzar "-r 30 -fps_mode cfr" (el fix anterior) hacía que ffmpeg
      // RELLENARA el hueco con fotogramas duplicados para completar 30fps
      // parejos — confirmado con mpdecimate: 67% de los fotogramas del mp4
      // resultante en el caso de 13.6fps de entrada eran duplicados
      // bit-a-bit, y 35-48% incluso en el caso "bueno" de ~29.3fps. Eso es
      // EXACTAMENTE lo que se percibía como "pausado" en TODO el video (no
      // solo transiciones pesadas) — cada fotograma real se mantenía en
      // pantalla ~3x más de lo que le tocaba antes de saltar al siguiente.
      // "-fps_mode vfr" (sin "-r" fijo) le dice a ffmpeg que NO rellene: deja
      // el fotograma real el tiempo real que le tomó capturarlo, sin
      // duplicar — confirmado con el mismo par de .webm reales: el mp4 de
      // salida queda con el MISMO número de fotogramas que el .webm de
      // entrada (cero duplicados introducidos) y la MISMA duración total.
      //
      // CRF 20 (antes 23) + preset "faster" (antes "veryfast"): mejor
      // calidad visual perceptible, y con margen de sobra dentro de los 300s
      // de este trigger — probado con un timeline real con transición
      // Deslizar, el mp4 resultante queda MÁS chico que antes (menos
      // fotogramas redundantes que codificar) a pesar de la mejor calidad.
      await execFileAsync(ffmpegPath, [
        "-y",
        "-i", tmpWebm,
        "-fps_mode", "vfr",
        "-c:v", "libx264",
        "-profile:v", "high",
        "-level", "4.1",
        "-pix_fmt", "yuv420p",
        "-preset", "faster",
        "-crf", "20",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        tmpMp4,
      ], { timeout: 270000, maxBuffer: 1024 * 1024 * 20 });

      await bucket.upload(tmpMp4, {
        destination: mp4Path,
        metadata: { contentType: "video/mp4" },
      });

      const [url] = await bucket.file(mp4Path).getSignedUrl({
        action: "read",
        expires: Date.now() + VIGENCIA_URL_MP4_MS,
      });

      // Borra el .webm temporal — ya cumplió su propósito y no debe
      // acumularse sin límite en Storage. Si el borrado falla no se
      // considera un error de la conversión (el usuario ya tiene su mp4).
      archivoWebm.delete().catch((e) => logger.warn("No se pudo borrar el .webm temporal tras convertir:", e));

      await jobRef.set({
        status: "listo",
        url,
        path: mp4Path,
        actualizadoEn: FieldValue.serverTimestamp(),
      }, { merge: true });

      logger.info("Video convertido a MP4", { uid, storagePath, mp4Path, bytesEntrada });
    } catch (err) {
      logger.error("Error convirtiendo video a MP4:", err);
      await jobRef.set({
        status: "error",
        mensajeError: String((err && err.message) || err || "error desconocido"),
        actualizadoEn: FieldValue.serverTimestamp(),
      }, { merge: true }).catch((e) => logger.error("Ademas fallo al escribir el estado de error en Firestore:", e));
    } finally {
      fs.unlink(tmpWebm, () => {});
      fs.unlink(tmpMp4, () => {});
    }
  }
);
