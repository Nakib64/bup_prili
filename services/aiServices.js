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

function buildSystemPrompt(batteryCapacity = 220) {
  return `You are an expert energy grid assistant for a 24-hour smart campus microgrid (hours 0 to 23).
Campus Battery Capacity: ${batteryCapacity} kWh.

Your task is to analyze natural language operator notes and translate each note into a structured operational directive.

Return ONLY a valid JSON object matching this schema:
{
  "directive_interpretation": [
    {
      "note_index": 0,
      "applies": true | false,
      "directive_type": "solar_reduction" | "minimum_battery_reserve" | "no_charge_window" | "no_discharge_window" | "max_grid_window" | "no_op",
      "structured_adjustment": { ... } | null,
      "explanation": "Brief explanation under 15 words"
    }
  ]
}

### Supported Directive Types & exact structured_adjustment schema:
1. "solar_reduction":
   - applies: true
   - structured_adjustment: {"hours": [int, ...], "factor": number}
   - CRITICAL: "factor" is the USABLE FRACTION REMAINING (0.0 to 1.0).
     * "usable solar should be treated as roughly 25% of the forecast" -> factor = 0.25
     * "80% reduction in solar" -> factor = 0.20 (since 1.0 - 0.80 = 0.20)
     * "leave about half of the forecast" -> factor = 0.50
     * "cut by 40%" -> factor = 0.60 (since 1.0 - 0.40 = 0.60)

2. "minimum_battery_reserve":
   - applies: true
   - structured_adjustment: {"hours": [int, ...], "minimum_energy_kwh": number}
   - CRITICAL: If note specifies a percentage (e.g. 50% of battery capacity), calculate exact kWh = (percentage / 100) * ${batteryCapacity}. For example, 50% of ${batteryCapacity} kWh = ${(batteryCapacity * 0.5)}.
   - If note specifies exact kWh (e.g. 90 kWh), use that number.
   - "minimum_energy_kwh" MUST be a number. NEVER null, string, or placeholders like ???.

3. "no_charge_window":
   - applies: true
   - structured_adjustment: {"hours": [int, ...]}
   - Applicable for charger isolation, charger inspection, charging circuit outages.

4. "no_discharge_window":
   - applies: true
   - structured_adjustment: {"hours": [int, ...]}
   - Applicable for protection testing, relay testing, disabling discharge.

5. "max_grid_window":
   - applies: true
   - structured_adjustment: {"hours": [int, ...], "max_grid_kwh": number}
   - Applicable for feeder limits, transformer limits, substation constraints.

6. "no_op":
   - applies: false
   - structured_adjustment: null
   - Applicable for any distractor, cafeteria news, registration deadlines, library book return, sports office, seminar rooms, student affairs, or future dates.

### Hour Indexing Rules:
- Whole-hour intervals (0 to 23). Start-inclusive, end-exclusive.
- "noon until 2 PM" -> [12, 13]
- "10 AM until noon" -> [10, 11]
- "11 AM until 1 PM" -> [11, 12]
- "11 AM and 2 PM" -> [11, 12, 13]
- "2 AM until 5 AM" -> [2, 3, 4]
- "2 PM until 4 PM" -> [14, 15]
- "5 PM until 7 PM" -> [17, 18]
- "6 PM until 8 PM" -> [18, 19]
- "6 PM until 9 PM" -> [18, 19, 20]
- "6 PM until 10 PM" -> [18, 19, 20, 21]
- "7 PM until 9 PM" -> [19, 20]
- "7 PM until 10 PM" -> [19, 20, 21]
- "hours" MUST be sorted unique integers.

CRITICAL INSTRUCTIONS:
- Output MUST be valid, raw JSON only.
- Do NOT output preamble, thoughts, reasoning, markdown fences, or safety labels.
- Start immediately with "{" and end with "}".`;
}

export async function interpretOperatorNotes(operatorNotes, batteryCapacity = 220) {
  if (!Array.isArray(operatorNotes) || operatorNotes.length === 0) {
    return [];
  }

  const formattedNotes = operatorNotes.map((note, index) => ({
    note_index: index,
    note: String(note || ""),
  }));

  try {
    const response = await openrouter.chat.completions.create({
      model: process.env.OPENROUTER_MODEL || "openrouter/auto",
      temperature: 0.0,
      max_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(batteryCapacity) },
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
      console.warn("No JSON payload detected in LLM response:", rawContent);
      return [];
    }

    const cleanJson = rawContent.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(cleanJson);
    return Array.isArray(parsed.directive_interpretation) ? parsed.directive_interpretation : [];
  } catch (err) {
    console.warn("LLM Extraction Error (falling back safely):", err?.message || err);
    return [];
  }
}