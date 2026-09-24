// Función serverless (Netlify Function) para el dictado de datos del paciente
// en la pantalla "Nuevo paciente". Misma lógica que structure-consulta.js:
// la clave de API vive solo en la variable de entorno de Netlify.

const SYSTEM_PROMPT = `Extraés datos de un paciente a partir de un dictado libre en español rioplatense, para precargar un formulario. Nunca inventes un dato que no esté dicho. Si algo no se mencionó, usá null.
No separes nombre/apellido adivinando si el dictado es ambiguo: hacelo solo cuando sea razonablemente claro.
La fecha de nacimiento: si se dice una fecha explícita, usala tal cual (YYYY-MM-DD). Si solo se dice la edad, calculá una fecha aproximada usando la fecha de hoy que te paso, y marcá fechaEsAproximada true.
Respondé ÚNICAMENTE con este JSON, sin texto adicional ni markdown:
{
  "nombre": string|null,
  "apellido": string|null,
  "dni": string|null,
  "telefono": string|null,
  "sexo": "Masculino"|"Femenino"|null,
  "obraSocial": string|null,
  "nroAfiliado": string|null,
  "domicilio": string|null,
  "fechaNacimiento": string|null,
  "fechaEsAproximada": boolean
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
  if (!transcript) {
    return { statusCode: 400, body: JSON.stringify({ error: "Transcripción vacía" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Falta configurar ANTHROPIC_API_KEY en Netlify" }) };
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const userContent = "Fecha de hoy: " + hoy + "\nDictado: " + transcript;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        temperature: 0.1,
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
