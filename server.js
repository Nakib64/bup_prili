import express from "express";
import dotenv from "dotenv";
import { interpretOperatorNotes } from "./services/aiServices.js";
import { validateAndSanitizeDirectives } from "./services/guardrails.js";

dotenv.config();

const app = express();
app.use(express.json());

// 1. Mandatory Health Endpoint
app.get("/health", (req, res) => {
  return res.status(200).json({ status: "ok" });
});

// 2. Main Optimization Endpoint (AI test implementation)
app.post("/optimize-energy", async (req, res) => {
  try {
    const { scenario_id, operator_notes, hours, battery } = req.body;

    // Basic request validation
    if (!scenario_id || !Array.isArray(operator_notes) || !Array.isArray(hours) || !battery) {
      return res.status(400).json({ error: "Invalid request payload schema." });
    }

    // Step 1: LLM interpretation via OpenRouter
    const rawInterpretations = await interpretOperatorNotes(operator_notes);

    // Step 2: Deterministic Guardrails
    const validatedDirectives = validateAndSanitizeDirectives(
      rawInterpretations,
      operator_notes.length,
      battery.capacity_kwh
    );

    // Return the interpretation stage for testing
    return res.status(200).json({
      scenario_id,
      directive_interpretation: validatedDirectives,
      message: "AI interpretation and guardrails passed. Ready for optimizer step.",
    });
  } catch (error) {
    console.error("Error processing request:", error);
    return res.status(500).json({ error: "Internal server error occurred." });
  }
});

const PORT = process.env.PORT || 3000;
// Critical: Bind to 0.0.0.0 for Docker and remote evaluation
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});