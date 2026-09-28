// Función serverless (Netlify Function) para el botón "Redactar con IA" en la
// revisión de la consulta: toma texto suelto tal como lo escribió el médico
// (o el que dejó la transcripción) y lo devuelve como prosa clínica prolija,
// sin agregar ni inventar nada. Misma clave de API que las otras funciones.

const SYSTEM_PROMPT = `Redactás en español rioplatense, en prosa clínica breve y profesional para una historia clínica, el texto que te pasa un médico.
Reglas estrictas:
- No agregues ningún dato, síntoma, diagnóstico o dato clínico que no esté explícito en el texto original.
- No cambies el significado clínico de lo que está escrito.
- Solo mejorá la redacción, la claridad y la concisión.
- Si el texto ya está bien redactado, devolvelo casi igual.
Respondé ÚNICAMENTE con el texto redactado final, sin comillas, sin explicaciones, sin markdown, sin texto adicional.`;

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

  const texto = (body.texto || "").trim();
  if (!texto) {
    return { statusCode: 400, body: JSON.stringify({ error: "Texto vacío" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Falta configurar ANTHROPIC_API_KEY en Netlify" }) };
  }

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
        max_tokens: 400,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: texto }],
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

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texto: textBlock.text.trim() }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: "Fallo de red al llamar a la API", detail: String(err) }) };
  }
};
