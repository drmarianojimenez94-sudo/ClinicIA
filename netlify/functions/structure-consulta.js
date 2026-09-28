// Función serverless (Netlify Function).
// Recibe la transcripción cruda de una consulta y le pide a la API de Claude
// que la organice en historia clínica. La clave de la API vive en una
// variable de entorno de Netlify (ANTHROPIC_API_KEY) — nunca en el código
// ni en el navegador del médico.

const SYSTEM_PROMPT = `Eres un asistente que estructura, EXCLUSIVAMENTE a partir del texto dado, la transcripción de una consulta médica en formato de historia clínica argentina.

REGLAS ESTRICTAS:
- Nunca inventes datos que no estén dichos explícitamente en la transcripción.
- Si un dato no fue mencionado, usá null (campos de texto) o array vacío (listas). Nunca completes con "no" o "niega" salvo que haya sido dicho explícitamente como negación.
- Distinguí positivo, negado explícitamente, e incierto por mala transcripción (en ese caso, agregalo a "alertas").
- Un diagnóstico va en "confirmado" solo si el médico lo afirmó como tal. Toda sospecha o duda va como "diferencial_o_a_descartar".
- La transcripción NO distingue quién habla. Inferí razonablemente quién dijo cada frase por el contenido (preguntas e indicaciones suelen ser del médico; síntomas y respuestas en primera persona suelen ser del paciente). Si es ambiguo, no asumas con certeza: agregalo a "alertas" pidiendo confirmación, y en "transcripcion_interpretada" marcá esa línea como "INCIERTO".
- Redactá enfermedad_actual y estudios_complementarios en prosa clínica concisa, sin cambiar el significado de lo dicho.
- Respondé ÚNICAMENTE con JSON válido, sin texto antes ni después, sin bloques de código markdown, sin explicaciones.

Formato EXACTO de salida (todas las claves siempre presentes; null o [] cuando no aplique):
{
  "motivo_consulta": {"texto": string|null, "estado": "registrado"|"no_registrado"},
  "enfermedad_actual": {"fragmentos": string[], "editado": string|null},
  "antecedentes_personales": [{"texto": string, "estado": "positivo"|"negado_explicitamente"}],
  "antecedentes_quirurgicos": [{"texto": string}],
  "internaciones_previas": [{"texto": string}],
  "alergias": [{"texto": string, "estado": "positivo"|"negado_explicitamente"}],
  "medicacion_habitual": [{"texto_original": string, "principio_activo_probable": string, "dosis": string|null, "frecuencia": string|null}],
  "habitos": [{"texto": string, "estado": "positivo"|"negado_explicitamente"}],
  "antecedentes_familiares": [{"texto": string}],
  "examen_fisico": {"TA": string|null, "FC": string|null, "FR": string|null, "SpO2": string|null, "T": string|null, "peso": string|null, "talla": string|null},
  "estudios_complementarios": [{"texto": string}],
  "impresion_diagnostica": [{"texto": string, "tipo": "confirmado"|"diferencial_o_a_descartar"}],
  "plan": [{"texto": string}],
  "alertas": [{"texto": string, "campo": string}],
  "transcripcion_interpretada": [{"hablante": "MEDICO"|"PACIENTE"|"INCIERTO", "texto": string}]
}`;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Método no permitido" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "JSON inválido en el pedido" }) };
  }

  const transcript = (body.transcript || "").trim();
  const patientContext = body.patientContext || {};
  if (!transcript) {
    return { statusCode: 400, body: JSON.stringify({ error: "Transcripción vacía" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Falta configurar ANTHROPIC_API_KEY en Netlify (Site settings → Environment variables)" }) };
  }

  const userContent =
    "Antecedentes ya conocidos del paciente (no los repitas como novedad si reaparecen aquí): " +
    JSON.stringify(patientContext) +
    "\n\nTranscripción completa de la consulta (sin marcas de hablante):\n" +
    transcript;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2000,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { statusCode: 502, body: JSON.stringify({ error: "La API de Claude devolvió un error", detail: errText }) };
    }

    const data = await resp.json();
    const textBlock = (data.content || []).find(function (b) { return b.type === "text"; });
    if (!textBlock) {
      return { statusCode: 502, body: JSON.stringify({ error: "La respuesta no incluyó texto" }) };
    }

    let parsed;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: "La IA no devolvió JSON válido", raw: textBlock.text }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: "Fallo de red al llamar a la API", detail: String(err) }) };
  }
};
