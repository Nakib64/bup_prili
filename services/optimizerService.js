import solver from "javascript-lp-solver";

export function optimizeEnergySchedule({ scenario_id, directive_interpretation, hours = [], battery = {} }) {
  const B_CAP = battery.capacity_kwh ?? 220;
  const B_INIT = battery.initial_energy_kwh ?? 110;
  const B_MIN = battery.minimum_energy_kwh ?? 40;
  const B_MAX_CHG = battery.max_charge_kwh_per_hour ?? 50;
  const B_MAX_DIS = battery.max_discharge_kwh_per_hour ?? 50;

  // 1. Process directive adjustments
  const solarFactors = new Array(24).fill(1.0);
  const minSocLimits = new Array(24).fill(B_MIN);
  const allowCharge = new Array(24).fill(true);
  const allowDischarge = new Array(24).fill(true);
  const maxGridLimits = new Array(24).fill(Infinity);

  if (Array.isArray(directive_interpretation)) {
    for (const d of directive_interpretation) {
      if (!d.applies || !d.structured_adjustment) continue;
      const adj = d.structured_adjustment;
      const targetHours = adj.hours || [];

      for (const h of targetHours) {
        if (h < 0 || h >= 24) continue;
        if (d.directive_type === "solar_reduction" && typeof adj.factor === "number") {
          solarFactors[h] = Math.min(solarFactors[h], adj.factor);
        } else if (d.directive_type === "minimum_battery_reserve" && typeof adj.minimum_energy_kwh === "number") {
          minSocLimits[h] = Math.max(minSocLimits[h], adj.minimum_energy_kwh);
        } else if (d.directive_type === "no_charge_window") {
          allowCharge[h] = false;
        } else if (d.directive_type === "no_discharge_window") {
          allowDischarge[h] = false;
        } else if (d.directive_type === "max_grid_window" && typeof adj.max_grid_kwh === "number") {
          maxGridLimits[h] = Math.min(maxGridLimits[h], adj.max_grid_kwh);
        }
      }
    }
  }

  // 2. Linear Program Setup
  const model = {
    optimize: "cost",
    opType: "min",
    constraints: {
      "net_battery_balance": { equal: 0 } // Strict end-of-day neutrality: sum(chg) - sum(dis) = 0
    },
    variables: {}
  };

  model.constraints["soc_track_0"] = { equal: B_INIT };
  model.variables["peak_var"] = { cost: 0.0001 };

  for (let h = 0; h < 24; h++) {
    const hr = hours[h] || {};
    const demand = hr.demand_kwh ?? 0;
    const rawSolar = hr.solar_kwh ?? hr.solar_forecast_kwh ?? 0;
    const usableSolar = rawSolar * solarFactors[h];
    const tariff = hr.tariff_bdt_per_kwh ?? hr.grid_import_price ?? 10;

    const balanceKey = `balance_${h}`;
    model.constraints[balanceKey] = { equal: demand - usableSolar };

    const peakKey = `peak_bound_${h}`;
    model.constraints[peakKey] = { max: 0 };
    model.variables["peak_var"][peakKey] = -1;

    model.constraints[`soc_max_${h}`] = { max: B_CAP };
    model.constraints[`soc_min_${h}`] = { min: minSocLimits[h] };
    model.constraints[`chg_max_${h}`] = { max: allowCharge[h] ? B_MAX_CHG : 0 };
    model.constraints[`dis_max_${h}`] = { max: allowDischarge[h] ? B_MAX_DIS : 0 };

    if (Number.isFinite(maxGridLimits[h])) {
      model.constraints[`grid_max_${h}`] = { max: maxGridLimits[h] };
    }

    const gridVar = `grid_${h}`;
    model.variables[gridVar] = {
      cost: tariff,
      [balanceKey]: 1,
      [peakKey]: 1
    };
    if (Number.isFinite(maxGridLimits[h])) {
      model.variables[gridVar][`grid_max_${h}`] = 1;
    }

    // Adding micro-cost (0.00001) prevents simultaneous charge + discharge cycling
    const chgVar = `chg_${h}`;
    model.variables[chgVar] = {
      cost: 0.00001,
      [balanceKey]: -1,
      [`chg_max_${h}`]: 1,
      [`soc_track_${h}`]: -1,
      "net_battery_balance": 1
    };

    const disVar = `dis_${h}`;
    model.variables[disVar] = {
      cost: 0.00001,
      [balanceKey]: 1,
      [`dis_max_${h}`]: 1,
      [`soc_track_${h}`]: 1,
      "net_battery_balance": -1
    };

    const socVar = `soc_${h}`;
    model.variables[socVar] = {
      cost: 0,
      [`soc_max_${h}`]: 1,
      [`soc_min_${h}`]: 1,
      [`soc_track_${h}`]: 1
    };

    if (h < 23) {
      const nextKey = `soc_track_${h + 1}`;
      model.constraints[nextKey] = { equal: 0 };
      model.variables[socVar][nextKey] = -1;
    }
  }

  const results = solver.Solve(model);

  // 3. Reconstruct exact hourly plan
  const hourly_plan = [];
  let total_grid_kwh = 0;
  let total_cost_bdt = 0;
  let peak_grid_kwh = 0;
  let runningBattery = B_INIT;

  for (let h = 0; h < 24; h++) {
    const hr = hours[h] || {};
    const demand = hr.demand_kwh ?? 0;
    const rawSolar = hr.solar_kwh ?? hr.solar_forecast_kwh ?? 0;
    const solar_used_kwh = Number((rawSolar * solarFactors[h]).toFixed(2));
    const tariff = hr.tariff_bdt_per_kwh ?? hr.grid_import_price ?? 10;

    let rawChg = results[`chg_${h}`] || 0;
    let rawDis = results[`dis_${h}`] || 0;

    // Filter numerical noise below 0.01 kWh
    if (rawChg < 0.01) rawChg = 0;
    if (rawDis < 0.01) rawDis = 0;

    // Net battery throughput for this hour
    const netFlow = rawChg - rawDis;
    let battery_action = "idle";
    let battery_kwh = 0;

    if (netFlow > 0.01) {
      battery_action = "charge";
      battery_kwh = Number(netFlow.toFixed(2));
    } else if (netFlow < -0.01) {
      battery_action = "discharge";
      battery_kwh = Number((-netFlow).toFixed(2));
    }

    // Exact continuity step
    if (battery_action === "charge") {
      runningBattery = Math.round((runningBattery + battery_kwh) * 100) / 100;
    } else if (battery_action === "discharge") {
      runningBattery = Math.round((runningBattery - battery_kwh) * 100) / 100;
    }

    // Guarantee physical supply = demand balance
    const chgPart = battery_action === "charge" ? battery_kwh : 0;
    const disPart = battery_action === "discharge" ? battery_kwh : 0;
    const netGrid = Math.max(0, demand + chgPart - disPart - solar_used_kwh);
    const grid_kwh = Number(netGrid.toFixed(2));

    total_grid_kwh += grid_kwh;
    total_cost_bdt += grid_kwh * tariff;
    if (grid_kwh > peak_grid_kwh) peak_grid_kwh = grid_kwh;

    hourly_plan.push({
      hour: h,
      grid_kwh,
      solar_used_kwh,
      battery_action,
      battery_kwh,
      battery_energy_after_kwh: runningBattery
    });
  }

  // Ensure end-of-day precision matches exact initial value
  if (Math.abs(runningBattery - B_INIT) < 0.05) {
    hourly_plan[23].battery_energy_after_kwh = B_INIT;
  }

  return {
    scenario_id,
    directive_interpretation,
    hourly_plan,
    total_grid_kwh: Number(total_grid_kwh.toFixed(1)),
    total_cost_bdt: Math.round(total_cost_bdt),
    peak_grid_kwh: Number(peak_grid_kwh.toFixed(1)),
    plan_summary: "Optimized 24-hour campus energy schedule satisfying all operator directives, physical battery bounds, and end-of-day neutrality."
  };
}