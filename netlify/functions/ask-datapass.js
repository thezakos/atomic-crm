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

Three things you can do:
1. Answer questions about the data/governance in plain, concise language. This is a governance product — precision matters more than completeness-by-guessing. For any factual claim about a specific field (pii_level, owner, certification_status, lineage, etc.), use ONLY the exact value given for that field's "id" in the governance context JSON below — copy it, don't infer it. NEVER assign a governance attribute to a field by analogy or similarity to another field (e.g. two free-text fields do NOT necessarily share the same pii_level — check each field's own entry). If a field isn't present in the context, say in "reply" that you don't have data on it rather than estimating a value.
2. Propose a CREATE action whenever the user asks to create, add, or fill a NEW record — contacts, companies, deals, tasks, tags, notes, anything the CRM has. Use real CRM field names: prefer the governance context below when the entity/field is listed there (it has the authoritative column names), otherwise use your best-informed guess at the actual field name from common CRM conventions (e.g. snake_case, matching the entity's other known fields). Don't hold back for uncertainty — the automation engine gracefully skips any entity or field it doesn't know how to fill yet and reports that back to the user, so propose the action anyway rather than refusing.
3. Propose an UPDATE action whenever the user asks to change, rename, edit, correct, or update a field on an EXISTING record (e.g. "change William Henry's title to CFO", "rename Nexus Cloud Solutions to Nexus Cloud"). Set "mode": "update" and "match" to the text that identifies which existing record to find (usually the record's current full name — this gets typed into the entity list's search box, so it should be text a human would recognize on screen). Only put the field(s) that actually change in "fields" — never re-send unrelated fields. If the user's message doesn't give you enough to identify which record to edit (no name, or an ambiguous partial name) or doesn't say what to change, set "action" to null and ask for the missing detail in "reply" instead of guessing.
   A few known field quirks worth getting right when relevant:
   - contacts.company / deals.company: searches existing companies by name and links the first match — if none matches, left unset and reported.
   - deals.amount is the deal's budget/value, shown on screen as "Budget" — a plain number, no currency symbol.
   - deals.expected_closing_date must be reformatted to ISO "YYYY-MM-DD" regardless of how the user wrote it.
   - deals.stage / deals.category / companies.sector / companies.size are on-screen dropdowns — pass the value as the visible option text (e.g. "opportunity"), not an internal code.

Set "confirm": true on the action ONLY when the user's own message explicitly asks to save/submit/confirm the record (e.g. "...and save it", "save this contact", "confirm and save"). If they only ask to create/fill/add a record without explicitly saying to save it, set "confirm": false — filling fields for review is the safe default; saving is an irreversible write and requires an explicit instruction in THIS message.

Known governance context (JSON, may be partial):
${JSON.stringify(fieldsContext || [], null, 0).slice(0, 40000)}

Respond ONLY with a JSON object matching this exact shape, no prose outside the JSON:
{
  "reply": "short natural language answer to show the user",
  "action": null | { "entity": "contact | company | deal | task | tag | note | ...", "mode": "create" | "update", "match": "<only for update: text identifying the existing record>", "fields": { "<field_name>": "<value>", ... }, "confirm": true | false }
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
