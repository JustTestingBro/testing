#!/usr/bin/env tsx
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

type ToolResponse = {
  content: { type: string; text: string }[];
};

const app = express();
app.use(cors());
app.use(bodyParser.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/server.ts"],
});

const mcp = new Client(
  { name: "frontend-client", version: "1.0.0" },
  { capabilities: { tools: {} } }
);
await mcp.connect(transport);

app.use(express.static("public"));

// GET all patients
app.get("/api/patients", async (req, res) => {
  try {
    const raw = await mcp.callTool({ name: "get_all_patients", arguments: {} });
    const resp = raw as unknown as ToolResponse;
    res.json(JSON.parse(resp.content[0].text));
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to fetch patients");
  }
});

// GET single patient by ID
app.get("/api/patients/:id", async (req, res) => {
  try {
    const raw = await mcp.callTool({
      name: "get_patient_by_id",
      arguments: { patient_id: req.params.id },
    });
    const resp = raw as unknown as ToolResponse;
    res.json(JSON.parse(resp.content[0].text));
  } catch (err) {
    console.error(err);
    res.status(404).send("Patient not found");
  }
});

// POST generate prescription
app.post("/api/generate_prescription", async (req, res) => {
  const { patient_id, symptoms, final_prescription } = req.body;
  if (!patient_id || !symptoms) return res.status(400).send("Missing inputs");

  try {
    let prescription = final_prescription;

    if (!prescription) {
      const rawPatient = await mcp.callTool({
        name: "get_patient_by_id",
        arguments: { patient_id },
      });
      const patientResp = rawPatient as unknown as ToolResponse;
      const patient = JSON.parse(patientResp.content[0].text);

      const ragResp = await mcp.callTool({
        name: "get_similar_prescriptions",
        arguments: { patient_id, symptoms },
      });
      const similarText = (ragResp as unknown as ToolResponse).content[0].text.trim();

      const prompt = `
You are a licensed doctor. Based on the following patient details and symptoms, write a professional, short, and safe prescription using only generic medicine names.

Patient Details:
- Age: ${patient.age}
- Diagnosis: ${patient.diagnosis}
- History: ${patient.history.join(", ")}

Current Symptoms: ${symptoms}

Relevant Past Prescriptions:
${similarText || "No similar prescriptions found."}

Start the prescription directly. Do not include disclaimers or introductions.
`.trim();

      // ✅ Log the prompt to console
      console.log("\n=== Final Prompt Sent to Gemini ===\n");
      console.log(prompt);
      console.log("\n==================================\n");

      const aiResp = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: prompt,
      });
      prescription = aiResp.text?.trim() ?? "";
    }

    await mcp.callTool({
      name: "add_prescription",
      arguments: { patient_id, symptoms, prescription },
    });

    res.json({ generated: prescription, prescription });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error generating prescription");
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Doctor Dashboard running at http://localhost:${PORT}`);
});
