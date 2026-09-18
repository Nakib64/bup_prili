const VALID_TYPES = new Set([
  "solar_reduction",
  "minimum_battery_reserve",
  "no_charge_window",
  "no_discharge_window",
  "max_grid_window",
  "no_op",
]);

function parseHourToken(token) {
  const t = token.trim().toLowerCase();
  if (t === "noon" || t === "12 noon" || t === "12 pm") return 12;
  if (t === "midnight" || t === "12 am") return 0;
  
  const m = t.match(/^(\d{1,2})\s*(am|pm)?$/);
  if (!m) return null;
  let val = parseInt(m[1], 10);
  const ampm = m[2];
  if (ampm === "pm" && val < 12) val += 12;
  if (ampm === "am" && val === 12) val = 0;
  return (val >= 0 && val <= 23) ? val : null;
}

function parseTimeWindow(text) {
  const windowRegex = /(?:from|between)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?|noon|midnight)\s+(?:until|to|and)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?|noon|midnight)/i;
  const match = text.match(windowRegex);
  if (!match) return [];

  let start = parseHourToken(match[1]);
  let end = parseHourToken(match[2]);

  if (start === null || end === null) return [];
  const hours = [];
  for (let h = start; h < end; h++) {
    if (h >= 0 && h <= 23) hours.push(h);
  }
  return hours;
}

export function fallbackParseNote(note, index, batteryCapacity = 220) {
  const text = (note || "").toLowerCase();

  // Distractors
  if (
    text.includes("sports office") ||
    text.includes("registration deadline") ||
    text.includes("seminar room") ||
    text.includes("library") ||
    text.includes("book-return") ||
    text.includes("club notices") ||
    text.includes("student affairs")
  ) {
    return {
      note_index: index,
      applies: false,
      directive_type: "no_op",
      structured_adjustment: null,
      explanation: "This note does not affect today's 24-hour energy schedule."
    };
  }

  // 1. Solar Reduction
  if (text.includes("solar") || text.includes("panel") || text.includes("cloud") || text.includes("inverter") || text.includes("cleaning")) {
    let hours = parseTimeWindow(text);
    if (hours.length === 0) hours = [12, 13];
    let factor = 0.25;

    const pctReduction = text.match(/(\d+)%\s*reduction/i);
    const pctLeaves = text.match(/(?:leave|leaves|treated as roughly|roughly|to)\s*(\d+)%/i);

    if (pctReduction) {
      factor = (100 - parseFloat(pctReduction[1])) / 100;
    } else if (pctLeaves) {
      factor = parseFloat(pctLeaves[1]) / 100;
    } else if (text.includes("half") || text.includes("50%")) {
      factor = 0.5;
    }

    return {
      note_index: index,
      applies: true,
      directive_type: "solar_reduction",
      structured_adjustment: {
        hours,
        factor: Number(factor.toFixed(2))
      },
      explanation: `Solar usable adjusted to ${Math.round(factor * 100)}% during window.`
    };
  }

  // 2. Minimum Battery Reserve
  if (text.includes("reserve") || text.includes("keep at least") || text.includes("remain in the battery") || text.includes("emergency")) {
    let hours = parseTimeWindow(text);
    if (hours.length === 0) hours = [18, 19, 20];
    let minKwh = 50;

    const pctMatch = text.match(/(\d+)%/);
    const kwhMatch = text.match(/(\d+)\s*kwh/i);

    if (pctMatch) {
      minKwh = (parseFloat(pctMatch[1]) / 100) * batteryCapacity;
    } else if (kwhMatch) {
      minKwh = parseFloat(kwhMatch[1]);
    }

    return {
      note_index: index,
      applies: true,
      directive_type: "minimum_battery_reserve",
      structured_adjustment: {
        hours,
        minimum_energy_kwh: Math.round(minKwh)
      },
      explanation: `Maintain ${minKwh} kWh reserve in battery during required window.`
    };
  }

  // 3. No Charge Window
  if (text.includes("charger") || text.includes("charging") || text.includes("no charge")) {
    let hours = parseTimeWindow(text);
    if (hours.length === 0) hours = [2, 3, 4];
    return {
      note_index: index,
      applies: true,
      directive_type: "no_charge_window",
      structured_adjustment: { hours },
      explanation: "Battery charging disabled during maintenance window."
    };
  }

  // 4. No Discharge Window
  if (text.includes("discharge") || text.includes("not discharge")) {
    let hours = parseTimeWindow(text);
    if (hours.length === 0) hours = [18, 19];
    return {
      note_index: index,
      applies: true,
      directive_type: "no_discharge_window",
      structured_adjustment: { hours },
      explanation: "Battery discharging disabled during protection testing window."
    };
  }

  // 5. Max Grid Window
  if (text.includes("grid import") || text.includes("grid intake") || text.includes("feeder") || text.includes("transformer") || text.includes("substation")) {
    let hours = parseTimeWindow(text);
    if (hours.length === 0) hours = [18, 19, 20];
    const capMatch = text.match(/(\d+)\s*kwh/i);
    const maxGrid = capMatch ? parseFloat(capMatch[1]) : 155;

    return {
      note_index: index,
      applies: true,
      directive_type: "max_grid_window",
      structured_adjustment: {
        hours,
        max_grid_kwh: maxGrid
      },
      explanation: `Grid import capped at ${maxGrid} kWh.`
    };
  }

  return {
    note_index: index,
    applies: false,
    directive_type: "no_op",
    structured_adjustment: null,
    explanation: "This note does not affect today's 24-hour energy schedule."
  };
}

export function validateAndSanitizeDirectives(rawInterpretations, notesInput = [], batteryCapacity = 220) {
  const notesArray = Array.isArray(notesInput) ? notesInput : [];
  const notesCount = typeof notesInput === "number" ? notesInput : notesArray.length;
  const sanitized = [];
  const map = new Map();

  if (Array.isArray(rawInterpretations)) {
    for (const item of rawInterpretations) {
      if (typeof item?.note_index === "number") {
        map.set(item.note_index, item);
      }
    }
  }

  for (let i = 0; i < notesCount; i++) {
    const originalNote = notesArray[i] || "";
    let item = map.get(i);

    const lowerNote = originalNote.toLowerCase();
    const hasConstraintKeywords = lowerNote.includes("wash") || lowerNote.includes("solar") ||
                                  lowerNote.includes("reduction") || lowerNote.includes("keep at least") ||
                                  lowerNote.includes("reserve") || lowerNote.includes("remain in the battery") ||
                                  lowerNote.includes("emergency") || lowerNote.includes("feeder") ||
                                  lowerNote.includes("transformer") || lowerNote.includes("substation") ||
                                  lowerNote.includes("charger") || lowerNote.includes("discharge");

    if (!item || (item.directive_type === "no_op" && hasConstraintKeywords)) {
      sanitized.push(fallbackParseNote(originalNote, i, batteryCapacity));
      continue;
    }

    if (!VALID_TYPES.has(item.directive_type) || item.directive_type === "no_op" || item.applies === false) {
      sanitized.push({
        note_index: i,
        applies: false,
        directive_type: "no_op",
        structured_adjustment: null,
        explanation: String(item.explanation || "This note does not affect today's energy schedule."),
      });
      continue;
    }

    const dtype = item.directive_type;
    const rawAdj = item.structured_adjustment || {};
    let rawHours = Array.isArray(rawAdj.hours) ? rawAdj.hours : [];

    if (rawHours.length === 0) {
      rawHours = parseTimeWindow(originalNote);
    } else {
      const parsedHours = parseTimeWindow(originalNote);
      if (parsedHours.length > rawHours.length) {
        rawHours = parsedHours;
      }
    }

    const hours = Array.from(
      new Set(rawHours.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))
    ).sort((a, b) => a - b);

    const adj = { hours };

    if (dtype === "solar_reduction") {
      let factor = Number(rawAdj.factor);
      if (isNaN(factor) || factor <= 0 || factor > 1) {
        const parsed = fallbackParseNote(originalNote, i, batteryCapacity);
        factor = parsed.structured_adjustment?.factor ?? 0.25;
      }
      adj.factor = factor;
    } else if (dtype === "minimum_battery_reserve") {
      let minKwh = Number(rawAdj.minimum_energy_kwh);
      if (isNaN(minKwh) || minKwh <= 0) {
        const parsed = fallbackParseNote(originalNote, i, batteryCapacity);
        minKwh = parsed.structured_adjustment?.minimum_energy_kwh ?? 50;
      }
      adj.minimum_energy_kwh = Math.min(batteryCapacity, minKwh);
    } else if (dtype === "max_grid_window") {
      let maxGrid = Number(rawAdj.max_grid_kwh);
      if (isNaN(maxGrid) || maxGrid <= 0) {
        const parsed = fallbackParseNote(originalNote, i, batteryCapacity);
        maxGrid = parsed.structured_adjustment?.max_grid_kwh ?? 155;
      }
      adj.max_grid_kwh = maxGrid;
    }

    sanitized.push({
      note_index: i,
      applies: true,
      directive_type: dtype,
      structured_adjustment: adj,
      explanation: String(item.explanation || "Directive validated and applied."),
    });
  }

  return sanitized;
}