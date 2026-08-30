// Secure proxy between the DataPass bookmarklet and OpenAI.
// The bookmarklet (public, client-side JS) NEVER sees the API key — it only
// talks to this endpoint, which reads the key from a Netlify environment
// variable (server-side only, never shipped to the browser).

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server misconfigured: missing OPENAI_API_KEY' }), { status: 500 });
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }

  const { message, fieldsContext } = body;
  if (!message || typeof message !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing "message" string' }), { status: 400 });
  }

  const systemPrompt = `You are DataPass, an AI copilot embedded inside a live CRM (Atomic CRM / RevenueStack).
You have access to the CRM's governance knowledge graph (field definitions, PII levels, owners, lineage) provided below as context.

Two things you can do:
1. Answer questions about the data/governance in plain, concise language.
2. Propose a CRM action when the user asks to create or fill something (e.g. "add a contact named X", "create a company called Y"). Only propose actions for the "contacts" or "companies" entities, using their real, simple text form field names — do NOT invent fields outside this list:
   - contacts -> first_name, last_name, title (job title), background (free-text notes)
   - companies -> name
   (email and phone are NOT supported yet — they use a different, more complex form widget. If asked to fill them, mention this limitation in "reply" and fill only the fields you can.)

Known governance context (JSON, may be partial):
${JSON.stringify(fieldsContext || [], null, 0).slice(0, 6000)}

Respond ONLY with a JSON object matching this exact shape, no prose outside the JSON:
{
  "reply": "short natural language answer to show the user",
  "action": null | { "entity": "contact" | "company", "fields": { "first_name": "...", "last_name": "..." } | { "name": "..." } }
}
Set "action" to null unless the user is clearly asking to create/add a record. Never fabricate governance facts not present in the provided context — if you don't know, say so in "reply".`;

  try {
    const llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
      }),
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text();
      return new Response(JSON.stringify({ error: `OpenAI API error: ${errText}` }), { status: 502 });
    }

    const llmData = await llmRes.json();
    const rawText = llmData.choices?.[0]?.message?.content || '{}';

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { reply: rawText, action: null };
    }

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
