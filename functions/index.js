const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const Anthropic = require("@anthropic-ai/sdk");

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
