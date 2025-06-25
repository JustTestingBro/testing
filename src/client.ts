#!/usr/bin/env tsx
import dotenv from "dotenv";
dotenv.config();

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GoogleGenAI } from "@google/genai";

async function main() {
  const { GEMINI_API_KEY } = process.env;
  if (!GEMINI_API_KEY) {
    console.error("⚠️ Missing GEMINI_API_KEY in .env");
    process.exit(1);
  }

  // 1) Parse args
  const [patientId, ...symptomParts] = process.argv.slice(2);
  const symptoms = symptomParts.join(" ");
  if (!patientId || !symptoms) {
    console.error("Usage: npx tsx client.ts <patient_id> \"<symptoms>\"");
    process.exit(1);
  }

  // 2) Spawn MCP server over stdio
const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/server.ts"],
});

  const mcp = new McpClient(
    { name: "prescription-client", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  await mcp.connect(transport);

  // 3) Fetch patient record
  const pResp = await mcp.callTool({
    name:      "get_patient_by_id",
    arguments: { patient_id: patientId },
  });
  const pContent = pResp.content as Array<{ type: string; text: string }>;
  const patient = JSON.parse(pContent[0].text);

  // 4) Fetch prescription history
  const hResp = await mcp.callTool({
    name:      "get_prescription_history",
    arguments: {},
  });
  const hContent   = hResp.content as Array<{ type: string; text: string }>;
  const historyText = hContent[0].text.trim();

  // 5) Build the “licensed doctor” prompt
  const prompt = `
You are a licensed doctor. Based on the following patient details and symptoms, write a professional, short, and safe prescription using only generic medicine names.

Patient Details:
- Age: ${patient.age}
- Diagnosis: ${patient.diagnosis}
- History: ${patient.history.join(", ")}

Current Symptoms: ${symptoms}

${historyText ? `Past data:\n${historyText}` : ""}

Start the prescription directly. Do not include disclaimers or introductions.
  `.trim();

  // 6) Call Gemini to generate the prescription
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const gen = await ai.models.generateContent({
    model:    "gemini-1.5-flash",
    contents: prompt,
  });
  const prescription = gen.text?.trim() ?? "";

  // 7) Print it out
  console.log("\n=== Prescription ===\n");
  console.log(prescription);

  // 8) Log it back into history
  await mcp.callTool({
    name:      "add_prescription",
    arguments: {
      patient_id:   patientId,
      symptoms,
      prescription,
    },
  });
}

main().catch((e) => {
  console.error("❌ Error:", e);
  process.exit(1);
});
