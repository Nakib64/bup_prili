const VALID_TYPES = new Set([
  "solar_reduction",
  "minimum_battery_reserve",
  "no_charge_window",
  "no_discharge_window",
  "max_grid_window",
  "no_op",
]);

export function validateAndSanitizeDirectives(rawInterpretations, notesCount, batteryCapacity) {
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
    const item = map.get(i);

    // If missing or unsupported directive type -> safe fallback to no_op
    if (!item || !VALID_TYPES.has(item.directive_type)) {
      sanitized.push({
        note_index: i,
        applies: false,
        directive_type: "no_op",
        structured_adjustment: null,
        explanation: "Defaulted to no_op due to unsupported or missing directive.",
      });
      continue;
    }

    const dtype = item.directive_type;

    if (dtype === "no_op") {
      sanitized.push({
        note_index: i,
        applies: false,
        directive_type: "no_op",
        structured_adjustment: null,
        explanation: String(item.explanation || "No operation required."),
      });
      continue;
    }

    // Process valid directive adjustments
    const rawAdj = item.structured_adjustment || {};
    const rawHours = Array.isArray(rawAdj.hours) ? rawAdj.hours : [];

    // Enforce unique, sorted integers 0 to 23
    const hours = Array.from(
      new Set(rawHours.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))
    ).sort((a, b) => a - b);

    const adj = { hours };

    if (dtype === "solar_reduction") {
      const factor = Number(rawAdj.factor);
      adj.factor = isNaN(factor) ? 1.0 : Math.max(0.0, Math.min(1.0, factor));
    } else if (dtype === "minimum_battery_reserve") {
      const minKwh = Number(rawAdj.minimum_energy_kwh);
      adj.minimum_energy_kwh = isNaN(minKwh) ? 0.0 : Math.max(0.0, Math.min(batteryCapacity, minKwh));
    } else if (dtype === "max_grid_window") {
      const maxGrid = Number(rawAdj.max_grid_kwh);
      adj.max_grid_kwh = isNaN(maxGrid) ? 0.0 : Math.max(0.0, maxGrid);
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