import express from "express";
import dotenv from "dotenv";
import { interpretOperatorNotes } from "./services/aiServices.js";
import { validateAndSanitizeDirectives } from "./services/guardrails.js";
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
    const { scenario_id, operator_notes = [], hours = [], battery = {} } = req.body;

    // 1. Directives parsing & guardrail sanitization
    const rawDirectives = await interpretOperatorNotes(operator_notes);
    const validatedDirectives = validateAndSanitizeDirectives(rawDirectives, operator_notes, battery?.capacity_kwh ?? 220);

    // 2. Run Optimization Solver
    const plan = optimizeEnergySchedule({
      scenario_id,
      directive_interpretation: validatedDirectives,
      hours,
      battery,
    });

    return res.json(plan);
  } catch (err) {
    console.error("Optimization endpoint failed:", err);
    return res.status(500).json({ error: "Internal server error occurred." });
  }
});

const PORT = process.env.PORT || 5000;
// Critical: Bind to 0.0.0.0 for Docker and remote evaluation
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});