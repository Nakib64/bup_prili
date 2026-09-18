import fs from "fs";
import path from "path";

const API_URL = process.env.API_URL || "http://localhost:5000/optimize-energy";
const DATA_FILE = path.resolve("./BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json");

if (!fs.existsSync(DATA_FILE)) {
  console.error(`File not found: ${DATA_FILE}`);
  process.exit(1);
}

const fileContent = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
const cases = fileContent.cases || [];

function arraysEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function evaluateTestCase(testCase, actual) {
  const errors = [];
  const exp = testCase.expected_output;
  const input = testCase.input;

  // 1. Directives validation
  const actDirs = actual.directive_interpretation || [];
  const expDirs = exp.directive_interpretation || [];

  if (actDirs.length !== expDirs.length) {
    errors.push(`Directive count mismatch (expected ${expDirs.length}, got ${actDirs.length})`);
  } else {
    for (let i = 0; i < expDirs.length; i++) {
      const eD = expDirs[i];
      const aD = actDirs[i];

      if (!aD) {
        errors.push(`Directive [${i}] is missing`);
        continue;
      }
      if (aD.applies !== eD.applies) {
        errors.push(`Directive [${i}] applies mismatch: expected ${eD.applies}, got ${aD.applies}`);
      }
      if (aD.directive_type !== eD.directive_type) {
        errors.push(`Directive [${i}] type mismatch: expected "${eD.directive_type}", got "${aD.directive_type}"`);
      }

      if (eD.structured_adjustment) {
        if (!aD.structured_adjustment) {
          errors.push(`Directive [${i}] missing structured_adjustment`);
        } else {
          if (eD.structured_adjustment.hours && !arraysEqual(aD.structured_adjustment.hours, eD.structured_adjustment.hours)) {
            errors.push(`Directive [${i}] hours mismatch: expected [${eD.structured_adjustment.hours}], got [${aD.structured_adjustment.hours}]`);
          }
          if (typeof eD.structured_adjustment.factor === "number") {
            if (Math.abs(aD.structured_adjustment.factor - eD.structured_adjustment.factor) > 0.01) {
              errors.push(`Directive [${i}] factor mismatch: expected ${eD.structured_adjustment.factor}, got ${aD.structured_adjustment.factor}`);
            }
          }
          if (typeof eD.structured_adjustment.minimum_energy_kwh === "number") {
            if (aD.structured_adjustment.minimum_energy_kwh !== eD.structured_adjustment.minimum_energy_kwh) {
              errors.push(`Directive [${i}] min kWh mismatch: expected ${eD.structured_adjustment.minimum_energy_kwh}, got ${aD.structured_adjustment.minimum_energy_kwh}`);
            }
          }
          if (typeof eD.structured_adjustment.max_grid_kwh === "number") {
            if (aD.structured_adjustment.max_grid_kwh !== eD.structured_adjustment.max_grid_kwh) {
              errors.push(`Directive [${i}] max grid mismatch: expected ${eD.structured_adjustment.max_grid_kwh}, got ${aD.structured_adjustment.max_grid_kwh}`);
            }
          }
        }
      } else if (aD.structured_adjustment !== null) {
        errors.push(`Directive [${i}] structured_adjustment should be null for no_op`);
      }
    }
  }

  // 2. Hourly Plan Check
  const plan = actual.hourly_plan || [];
  if (!Array.isArray(plan) || plan.length !== 24) {
    errors.push(`hourly_plan must contain 24 hours, received: ${plan.length}`);
    return errors;
  }

  let currentBattery = input.battery.initial_energy_kwh;

  for (let h = 0; h < 24; h++) {
    const p = plan[h];
    const hrIn = input.hours[h];

    if (!p) {
      errors.push(`Hour ${h} is missing from hourly_plan`);
      continue;
    }

    const grid = p.grid_kwh ?? 0;
    const solar = p.solar_used_kwh ?? 0;
    const act = p.battery_action;
    const bkwh = p.battery_kwh ?? 0;
    const bAfter = p.battery_energy_after_kwh ?? 0;

    const chg = act === "charge" ? bkwh : 0;
    const dis = act === "discharge" ? bkwh : 0;

    // Power balance check
    const supplied = grid + solar + dis;
    const consumed = hrIn.demand_kwh + chg;
    if (Math.abs(supplied - consumed) > 0.05) {
      errors.push(`Hour ${h} power balance error: supply ${supplied.toFixed(1)} != demand ${consumed.toFixed(1)}`);
    }

    // Battery continuity check
    const expectedBattery = currentBattery + chg - dis;
    if (Math.abs(bAfter - expectedBattery) > 0.05) {
      errors.push(`Hour ${h} battery continuity error: expected ${expectedBattery.toFixed(1)}, got ${bAfter}`);
    }
    currentBattery = bAfter;
  }

  // 3. End-of-day Neutrality
  if (Math.abs(currentBattery - input.battery.initial_energy_kwh) > 0.05) {
    errors.push(`End of day battery neutrality failed: started with ${input.battery.initial_energy_kwh} kWh, ended with ${currentBattery} kWh`);
  }

  // 4. Totals and metrics within tolerance
  const costDiff = Math.abs((actual.total_cost_bdt ?? 0) - exp.total_cost_bdt);
  if (costDiff > 50) {
    errors.push(`total_cost_bdt mismatch: expected ~${exp.total_cost_bdt}, got ${actual.total_cost_bdt} (diff: ${costDiff})`);
  }

  const gridDiff = Math.abs((actual.total_grid_kwh ?? 0) - exp.total_grid_kwh);
  if (gridDiff > 2.0) {
    errors.push(`total_grid_kwh mismatch: expected ~${exp.total_grid_kwh}, got ${actual.total_grid_kwh} (diff: ${gridDiff})`);
  }

  if (typeof actual.peak_grid_kwh === "number" && actual.peak_grid_kwh > exp.peak_grid_kwh + 0.5) {
    errors.push(`peak_grid_kwh exceeded expected peak: expected <= ${exp.peak_grid_kwh}, got ${actual.peak_grid_kwh}`);
  }

  return errors;
}

async function runTests() {
  console.log(`\nStarting execution across ${cases.length} benchmark test cases...\n`);
  let passCount = 0;

  for (const c of cases) {
    process.stdout.write(`• [${c.id}] ${c.label.padEnd(36)} `);
    const start = Date.now();

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(c.input)
      });

      const latency = Date.now() - start;

      if (!response.ok) {
        console.log(`\x1b[31mFAIL (HTTP ${response.status})\x1b[0m [${latency}ms]`);
        continue;
      }

      const json = await response.json();
      const errs = evaluateTestCase(c, json);

      if (errs.length === 0) {
        console.log(`\x1b[32mPASS\x1b[0m [${latency}ms] | Cost: ${json.total_cost_bdt} BDT | Grid: ${json.total_grid_kwh} kWh`);
        passCount++;
      } else {
        console.log(`\x1b[31mFAIL\x1b[0m [${latency}ms]`);
        errs.forEach((e) => console.log(`    \x1b[33m↳ ${e}\x1b[0m`));
      }
    } catch (err) {
      console.log(`\x1b[31mERROR\x1b[0m: ${err.message}`);
    }
  }

  console.log(`\n======================================================`);
  console.log(`Summary: ${passCount} / ${cases.length} cases passed.`);
  console.log(`======================================================\n`);

  if (passCount !== cases.length) process.exit(1);
}

runTests();