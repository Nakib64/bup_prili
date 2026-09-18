import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "http://localhost:5000",
    "X-Title": "GridWise Energy Optimizer",
  },
});

const SYSTEM_PROMPT = `
You are an expert energy grid assistant. Your task is to analyze natural language operator notes for a 24-hour smart campus microgrid (hours 0 to 23) and translate each note into a structured operational directive.

CRITICAL INSTRUCTION:
- Output MUST be valid, raw JSON only.
- Do NOT output preamble, thoughts, reasoning, markdown fences, or safety labels (e.g. NEVER write "User Safety: safe").
- Start immediately with "{" and end with "}".
- Keep each "explanation" string under 10 words.

Return a JSON object with key "directive_interpretation" containing an array matching the exact input order (note_index 0, 1, ... N-1).

### Supported Directive Types & Adjustments:
1. "solar_reduction":
   - Applicable for: Panel cleaning, dust, maintenance, cloud cover.
   - structured_adjustment: {"hours": [int, ...], "factor": number}
   - CRITICAL: "factor" is the USABLE FRACTION REMAINING (0.0 to 1.0).
     * "solar drops to 20%" -> factor = 0.20
     * "80% reduction in solar" -> factor = 0.20 (1.0 - 0.80 = 0.20)
     * "cut by half" -> factor = 0.50
     * "one-fourth output" -> factor = 0.25
2. "minimum_battery_reserve":
   - structured_adjustment: {"hours": [int, ...], "minimum_energy_kwh": number}
3. "no_charge_window":
   - structured_adjustment: {"hours": [int, ...]}
4. "no_discharge_window":
   - structured_adjustment: {"hours": [int, ...]}
5. "max_grid_window":
   - structured_adjustment: {"hours": [int, ...], "max_grid_kwh": number}
6. "no_op":
   - Applicable for: Any distractor, cafeteria news, unrelated maintenance, or notes that do not place an energy constraint on today's schedule.
   - applies: false
   - structured_adjustment: null

### Hour Indexing Rules:
- Whole-hour intervals (0 to 23). Start-inclusive, end-exclusive.
- "noon until 2 PM" -> [12, 13]
- "1 PM to 3 PM" -> [13, 14]
- "between 2 PM and 4 PM" -> [14, 15]
- "6 PM until 9 PM" -> [18, 19, 20]
- "hours" must be sorted unique integers.

### Applies Semantics:
- "no_op": applies = false, structured_adjustment = null
- All others: applies = true, structured_adjustment = {...}
`;

export async function interpretOperatorNotes(operatorNotes) {
  const formattedNotes = operatorNotes.map((note, index) => ({
    note_index: index,
    note: note,
  }));

  try {
    const response = await openrouter.chat.completions.create({
      model: process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash-0731:free",
      temperature: 0.0,
      max_tokens: 450,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Interpret these operator notes:\n${JSON.stringify(formattedNotes)}`,
        },
      ],
    });

    const rawContent = response.choices[0]?.message?.content || "";

    // Robust extraction: slice from first '{' to last '}'
    const jsonStart = rawContent.indexOf("{");
    const jsonEnd = rawContent.lastIndexOf("}");

    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
      console.error("No JSON payload detected in response:", rawContent);
      return [];
    }

    const cleanJson = rawContent.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(cleanJson);
    return parsed.directive_interpretation || [];
  } catch (err) {
    console.error("LLM Extraction Error:", err?.message || err);
    return [];
  }
}