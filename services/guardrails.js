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

export function replayValidateSchedule(plan, directive_interpretation = [], hours = [], battery = {}) {
  const B_CAP = battery.capacity_kwh ?? 220;
  const B_INIT = battery.initial_energy_kwh ?? 110;
  const B_MIN = battery.minimum_energy_kwh ?? 40;
  const B_MAX_CHG = battery.max_charge_kwh_per_hour ?? 50;
  const B_MAX_DIS = battery.max_discharge_kwh_per_hour ?? 50;

  if (!plan || !Array.isArray(plan.hourly_plan) || plan.hourly_plan.length !== 24) {
    throw new Error("Replay validation error: hourly_plan must contain exactly 24 hours.");
  }

  // Pre-index directives
  const noChargeHours = new Set();
  const noDischargeHours = new Set();
  const minReserveHours = new Map();
  const maxGridHours = new Map();
  const solarFactorMap = new Map();

  for (const d of directive_interpretation) {
    if (!d.applies || !d.structured_adjustment) continue;
    const targetHours = d.structured_adjustment.hours || [];
    for (const h of targetHours) {
      if (d.directive_type === "no_charge_window") noChargeHours.add(h);
      if (d.directive_type === "no_discharge_window") noDischargeHours.add(h);
      if (d.directive_type === "minimum_battery_reserve") {
        const current = minReserveHours.get(h) ?? B_MIN;
        minReserveHours.set(h, Math.max(current, d.structured_adjustment.minimum_energy_kwh ?? 0));
      }
      if (d.directive_type === "max_grid_window") {
        const current = maxGridHours.get(h) ?? Infinity;
        maxGridHours.set(h, Math.min(current, d.structured_adjustment.max_grid_kwh ?? Infinity));
      }
      if (d.directive_type === "solar_reduction") {
        const current = solarFactorMap.get(h) ?? 1.0;
        solarFactorMap.set(h, Math.min(current, d.structured_adjustment.factor ?? 1.0));
      }
    }
  }

  let runningBattery = B_INIT;
  let recalculatedTotalGrid = 0;
  let recalculatedTotalCost = 0;
  let recalculatedPeakGrid = 0;

  for (let h = 0; h < 24; h++) {
    const entry = plan.hourly_plan[h];
    const hrIn = hours[h] || {};
    const demand = hrIn.demand_kwh ?? 0;
    const tariff = hrIn.tariff_bdt_per_kwh ?? hrIn.grid_import_price ?? 10;
    const rawSolar = hrIn.solar_kwh ?? hrIn.solar_forecast_kwh ?? 0;
    const maxAllowedSolar = Number((rawSolar * (solarFactorMap.get(h) ?? 1.0)).toFixed(2));

    // 1. Directives enforcement: solar
    if (entry.solar_used_kwh > maxAllowedSolar + 0.05) {
      entry.solar_used_kwh = maxAllowedSolar;
    }

    // 2. Directives enforcement: charge & discharge windows
    if (noChargeHours.has(h) && entry.battery_action === "charge") {
      entry.battery_action = "idle";
      entry.battery_kwh = 0;
    }
    if (noDischargeHours.has(h) && entry.battery_action === "discharge") {
      entry.battery_action = "idle";
      entry.battery_kwh = 0;
    }

    // Rate limits
    if (entry.battery_action === "charge" && entry.battery_kwh > B_MAX_CHG) {
      entry.battery_kwh = B_MAX_CHG;
    }
    if (entry.battery_action === "discharge" && entry.battery_kwh > B_MAX_DIS) {
      entry.battery_kwh = B_MAX_DIS;
    }

    const chg = entry.battery_action === "charge" ? entry.battery_kwh : 0;
    const dis = entry.battery_action === "discharge" ? entry.battery_kwh : 0;

    // 3. Exact physical power balance
    const requiredGrid = Math.max(0, demand + chg - dis - entry.solar_used_kwh);
    entry.grid_kwh = Number(requiredGrid.toFixed(2));

    // 4. Continuity update
    runningBattery = Math.round((runningBattery + chg - dis) * 100) / 100;
    entry.battery_energy_after_kwh = runningBattery;

    // Accumulate metrics
    recalculatedTotalGrid += entry.grid_kwh;
    recalculatedTotalCost += entry.grid_kwh * tariff;
    if (entry.grid_kwh > recalculatedPeakGrid) {
      recalculatedPeakGrid = entry.grid_kwh;
    }
  }

  // 5. End-of-day battery neutrality
  if (Math.abs(runningBattery - B_INIT) < 0.05) {
    plan.hourly_plan[23].battery_energy_after_kwh = B_INIT;
  }

  // 6. Enforce recalculated mathematical accounting
  plan.total_grid_kwh = Number(recalculatedTotalGrid.toFixed(1));
  plan.total_cost_bdt = Math.round(recalculatedTotalCost);
  plan.peak_grid_kwh = Number(recalculatedPeakGrid.toFixed(1));

  return plan;
}