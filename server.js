import express from "express";
import dotenv from "dotenv";
import { interpretOperatorNotes } from "./services/aiServices.js";
import { validateAndSanitizeDirectives, replayValidateSchedule } from "./services/guardrails.js";
import { optimizeEnergySchedule } from "./services/optimizerService.js";

dotenv.config();

const app = express();
app.use(express.json());

// 1. Mandatory Health Endpoint
app.get("/health", (req, res) => {
  return res.status(200).json({ status: "ok" });
});

// 2. Main Optimization Endpoint
app.post("/optimize-energy", async (req, res) => {
  try {
    const { scenario_id, operator_notes, hours, battery } = req.body || {};

    // Strict HTTP 400 validation as required by Section 06
    if (!scenario_id || typeof scenario_id !== "string" || scenario_id.trim() === "") {
      return res.status(400).json({
        error: "Invalid request payload: 'scenario_id' is required and must be a non-empty string.",
      });
    }

    if (!Array.isArray(operator_notes)) {
      return res.status(400).json({
        error: "Invalid request payload: 'operator_notes' must be an array of strings.",
      });
    }

    if (!Array.isArray(hours) || hours.length !== 24) {
      return res.status(400).json({
        error: "Invalid request payload: 'hours' must contain exactly 24 records corresponding to hours 0 to 23.",
      });
    }

    for (let i = 0; i < 24; i++) {
      const hr = hours[i];
      if (!hr || typeof hr !== "object") {
        return res.status(400).json({
          error: `Invalid request payload: 'hours[${i}]' is missing or invalid.`,
        });
      }
      const demand = hr.demand_kwh;
      const solar = hr.solar_kwh ?? hr.solar_forecast_kwh;
      const tariff = hr.tariff_bdt_per_kwh ?? hr.grid_import_price;
      if (typeof demand !== "number" || typeof solar !== "number" || typeof tariff !== "number") {
        return res.status(400).json({
          error: `Invalid request payload: 'hours[${i}]' must have numeric demand_kwh, solar_kwh, and tariff_bdt_per_kwh.`,
        });
      }
    }

    if (!battery || typeof battery !== "object") {
      return res.status(400).json({
        error: "Invalid request payload: 'battery' object is required.",
      });
    }

    const {
      capacity_kwh,
      initial_energy_kwh,
      minimum_energy_kwh,
      max_charge_kwh_per_hour,
      max_discharge_kwh_per_hour,
    } = battery;

    if (
      typeof capacity_kwh !== "number" ||
      typeof initial_energy_kwh !== "number" ||
      typeof minimum_energy_kwh !== "number" ||
      typeof max_charge_kwh_per_hour !== "number" ||
      typeof max_discharge_kwh_per_hour !== "number"
    ) {
      return res.status(400).json({
        error: "Invalid request payload: 'battery' must contain numeric capacity_kwh, initial_energy_kwh, minimum_energy_kwh, max_charge_kwh_per_hour, and max_discharge_kwh_per_hour.",
      });
    }

    // Step 1: LLM interpretation via OpenRouter (with battery capacity context)
    const rawDirectives = await interpretOperatorNotes(operator_notes, capacity_kwh);

    // Step 2: Deterministic Guardrails
    const validatedDirectives = validateAndSanitizeDirectives(
      rawDirectives,
      operator_notes,
      capacity_kwh
    );

    // Step 3: Run Optimization Solver
    const rawPlan = optimizeEnergySchedule({
      scenario_id,
      directive_interpretation: validatedDirectives,
      hours,
      battery,
    });

    // Step 4: Final Replay & Verification (Section 08 post-optimization check)
    const finalPlan = replayValidateSchedule(rawPlan, validatedDirectives, hours, battery);

    return res.status(200).json(finalPlan);
  } catch (err) {
    console.error("Optimization endpoint error:", err?.message || err);
    return res.status(500).json({ error: "Internal server error occurred." });
  }
});

const PORT = process.env.PORT || 5000;
// Critical: Bind to 0.0.0.0 for Docker and remote evaluation
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});