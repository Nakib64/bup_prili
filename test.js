const API_URL = process.env.API_URL || "http://localhost:5000/optimize-energy";

const samplePayload = {
  scenario_id: "SAMPLE-01",
  operator_notes: [
    "Facilities will wash the rooftop solar panels from noon until 2 PM. During cleaning, usable solar should be treated as roughly 25% of the forecast.",
    "The sports office moved next month's registration deadline."
  ],
  hours: [
    { hour: 0, demand_kwh: 90, solar_kwh: 0, tariff_bdt_per_kwh: 6 },
    { hour: 1, demand_kwh: 85, solar_kwh: 0, tariff_bdt_per_kwh: 6 },
    { hour: 2, demand_kwh: 80, solar_kwh: 0, tariff_bdt_per_kwh: 5 },
    { hour: 3, demand_kwh: 80, solar_kwh: 0, tariff_bdt_per_kwh: 5 },
    { hour: 4, demand_kwh: 85, solar_kwh: 0, tariff_bdt_per_kwh: 5 },
    { hour: 5, demand_kwh: 95, solar_kwh: 0, tariff_bdt_per_kwh: 6 },
    { hour: 6, demand_kwh: 110, solar_kwh: 5, tariff_bdt_per_kwh: 8 },
    { hour: 7, demand_kwh: 130, solar_kwh: 20, tariff_bdt_per_kwh: 10 },
    { hour: 8, demand_kwh: 150, solar_kwh: 50, tariff_bdt_per_kwh: 12 },
    { hour: 9, demand_kwh: 165, solar_kwh: 90, tariff_bdt_per_kwh: 14 },
    { hour: 10, demand_kwh: 175, solar_kwh: 130, tariff_bdt_per_kwh: 16 },
    { hour: 11, demand_kwh: 180, solar_kwh: 160, tariff_bdt_per_kwh: 16 },
    { hour: 12, demand_kwh: 185, solar_kwh: 180, tariff_bdt_per_kwh: 15 },
    { hour: 13, demand_kwh: 180, solar_kwh: 170, tariff_bdt_per_kwh: 14 },
    { hour: 14, demand_kwh: 170, solar_kwh: 140, tariff_bdt_per_kwh: 13 },
    { hour: 15, demand_kwh: 165, solar_kwh: 90, tariff_bdt_per_kwh: 14 },
    { hour: 16, demand_kwh: 170, solar_kwh: 45, tariff_bdt_per_kwh: 18 },
    { hour: 17, demand_kwh: 185, solar_kwh: 10, tariff_bdt_per_kwh: 22 },
    { hour: 18, demand_kwh: 205, solar_kwh: 0, tariff_bdt_per_kwh: 28 },
    { hour: 19, demand_kwh: 215, solar_kwh: 0, tariff_bdt_per_kwh: 30 },
    { hour: 20, demand_kwh: 205, solar_kwh: 0, tariff_bdt_per_kwh: 26 },
    { hour: 21, demand_kwh: 175, solar_kwh: 0, tariff_bdt_per_kwh: 18 },
    { hour: 22, demand_kwh: 135, solar_kwh: 0, tariff_bdt_per_kwh: 10 },
    { hour: 23, demand_kwh: 105, solar_kwh: 0, tariff_bdt_per_kwh: 7 }
  ],
  battery: {
    capacity_kwh: 220,
    initial_energy_kwh: 110,
    minimum_energy_kwh: 40,
    max_charge_kwh_per_hour: 50,
    max_discharge_kwh_per_hour: 50
  }
};

async function runTest() {
  console.log(`Sending POST to: ${API_URL}`);
  const startTime = Date.now();

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(samplePayload)
    });

    const elapsed = Date.now() - startTime;
    console.log(`Status: ${res.status} ${res.statusText} (took ${elapsed}ms)`);

    const data = await res.json();
    console.log("\n--- Full Response ---");
    console.log(JSON.stringify(data, null, 2));

    console.log("\n--- Validations ---");
    const d0 = data.directive_interpretation?.[0];
    const d1 = data.directive_interpretation?.[1];

    console.log(
      "Directive 0 applies & factor 0.25:",
      d0?.applies === true && d0?.structured_adjustment?.factor === 0.25 ? "PASS" : "FAIL"
    );
    console.log(
      "Directive 1 is no_op:",
      d1?.applies === false && d1?.directive_type === "no_op" ? "PASS" : "FAIL"
    );
    console.log(
      "Hourly plan has 24 hours:",
      Array.isArray(data.hourly_plan) && data.hourly_plan.length === 24 ? "PASS" : "FAIL"
    );
    console.log("Total Grid kWh:", data.total_grid_kwh, "(Expected ~2692.5)");
    console.log("Total Cost BDT:", data.total_cost_bdt, "(Expected ~38365)");
    console.log("Peak Grid kWh:", data.peak_grid_kwh, "(Expected 175)");
  } catch (err) {
    console.error("Test failed:", err.message);
  }
}

runTest();