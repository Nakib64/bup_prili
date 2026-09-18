import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "http://localhost:3000",
    "X-Title": "GridWise Energy Optimizer",
  },
});

const SYSTEM_PROMPT = `
You are an expert energy grid assistant. Your task is to analyze natural language operator notes for a 24-hour smart campus microgrid (hours 0 to 23) and translate each note into a structured operational directive.

Return ONLY a valid JSON object with the key "directive_interpretation" containing an array matching the exact order of the input notes (note_index 0, 1, ... N-1).

### Supported Directive Types & Adjustments:
1. "solar_reduction":
   - Applicable for: Panel cleaning, dust, maintenance, cloud cover.
   - structured_adjustment: {"hours": [int, ...], "factor": number}
   - CRITICAL: "factor" is the USABLE FRACTION REMAINING (0.0 to 1.0).
     * "solar drops to 20%" -> factor = 0.20
     * "80% reduction in solar" -> factor = 0.20 (since 1.0 - 0.80 = 0.20)
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
- hours must be sorted unique integers.

### Applies Semantics:
- "no_op": applies = false, structured_adjustment = null
- All others: applies = true, structured_adjustment = {...}
`;

export async function interpretOperatorNotes(operatorNotes) {
  const formattedNotes = operatorNotes.map((note, index) => ({
    note_index: index,
    note: note,
  }));

  const response = await openrouter.chat.completions.create({
    model: process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
    temperature: 0.0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Interpret these operator notes:\n${JSON.stringify(formattedNotes)}`,
      },
    ],
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content);
    return parsed.directive_interpretation || [];
  } catch (err) {
    console.error("Failed to parse LLM response JSON:", err);
    return [];
  }
}