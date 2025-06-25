#!/usr/bin/env tsx
import dotenv from "dotenv";
dotenv.config();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import mongoose, { Schema, model } from "mongoose";
import { GoogleGenAI } from "@google/genai";
import fs from "fs/promises";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const MONGO_URI      = process.env.MONGO_URI!;
if (!GEMINI_API_KEY || !MONGO_URI) {
  console.error("⚠️  Set GEMINI_API_KEY and MONGO_URI in .env");
  process.exit(1);
}

// Decide mode based on first CLI argument
const mode = process.argv[2];
if (mode === "server-mode") {
  await runServer();
} else {
  await runClient();
}

async function runServer() {
  // —— MongoDB & Model
  await mongoose.connect(MONGO_URI, { dbName: "prescriptions" });
  interface Patient {
    id: string;
    name: string;
    age: number;
    diagnosis: string;
    history: string[];
  }
  const PatientModel = model<Patient>(
    "Patient",
    new Schema<Patient>({
      id: { type: String, required: true },
      name: { type: String, required: true },
      age: { type: Number, required: true },
      diagnosis: { type: String, required: true },
      history: { type: [String], required: true },
    })
  );

  // —— Helper to call Gemini for prescriptions
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  async function draftPrescription(p: Patient, symptoms: string, hist: string) {
    const prompt = `
You are a licensed doctor. Based on the following patient details and symptoms, write a professional, short, and safe prescription using only generic medicine names.

Patient Details:
- Age: ${p.age}
- Diagnosis: ${p.diagnosis}
- History: ${p.history.join(", ")}

Current Symptoms: ${symptoms}

${hist ? `Past data:\n${hist}` : ""}

Start the prescription directly. Do not include disclaimers or introductions.
    `.trim();

    const res = await ai.models.generateContent({
      model:    "gemini-1.5-flash",
      contents: prompt
    });
    return res.text?.trim() ?? "";
  }

  // —— MCP server & tool registration
  const server = new McpServer({ name: "prescription-mcp", version: "1.0.0" });

  // 1) get_all_patients
  server.registerTool(
    "get_all_patients",
    {
      title:       "Get All Patients",
      description: "List every patient in the database",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await PatientModel.find().lean(), null, 2),
        },
      ],
    })
  );

  // 2) get_patient_by_id
  server.registerTool(
    "get_patient_by_id",
    {
      title:       "Get Patient by ID",
      description: "Fetch a single patient record",
      inputSchema: { patient_id: z.string() },
    },
    async ({ patient_id }: { patient_id: string }) => {
      const p = await PatientModel.findOne({ id: patient_id }).lean();
      if (!p) throw new Error("Patient not found");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(p, null, 2),
          },
        ],
      };
    }
  );

  // 3) get_prescription_history
  server.registerTool(
    "get_prescription_history",
    {
      title:       "Get Prescription History",
      description: "Read the past_prescriptions.txt log",
      inputSchema: {},
    },
    async () => {
      const hist = await fs.readFile("past_prescriptions.txt", "utf-8").catch(() => "");
      return {
        content: [
          {
            type: "text",
            text: hist || "No history available.",
          },
        ],
      };
    }
  );

  // 4) generate_prescription
  server.registerTool(
    "generate_prescription",
    {
      title:       "Generate Prescription",
      description: "Use Gemini to generate a new prescription",
      inputSchema: {
        patient_id:        z.string(),
        symptoms:          z.string(),
        final_prescription: z.string().optional(),
      },
    },
    async ({
      patient_id,
      symptoms,
      final_prescription,
    }: {
      patient_id: string;
      symptoms: string;
      final_prescription?: string;
    }) => {
      const p = await PatientModel.findOne({ id: patient_id }).lean();
      if (!p) throw new Error("Invalid patient ID");

      const hist = await fs.readFile("past_prescriptions.txt", "utf-8").catch(() => "");
      const draft = await draftPrescription(p as Patient, symptoms, hist);
      const prescription = final_prescription || draft;

      await fs.appendFile(
        "past_prescriptions.txt",
        `\nPatient: ${patient_id} | Symptoms: ${symptoms} | Rx: ${prescription}\n`,
        "utf-8"
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ generated: draft, prescription, patient: p }, null, 2),
          },
        ],
      };
    }
  );

  // —— Start listening on stdio
  await server.connect(new StdioServerTransport());
  console.log("[MCP] server-mode listening on stdio");
}

async function runClient() {
  // Read CLI args
  const patientId = process.argv[2];
  const symptoms  = process.argv.slice(3).join(" ");

  if (!patientId || !symptoms) {
    console.error("Usage: npx tsx index.ts <patient_id> \"<symptoms>\"");
    process.exit(1);
  }

  // —— Spawn the MCP server in server-mode
  const transport = new StdioClientTransport({
    command: "npx",
    args:    ["tsx", "index.ts", "server-mode"],
  });
  const client = new McpClient(
    { name: "prescription-client", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  await client.connect(transport);

  // —— Fetch patient record
  const pResp = await client.callTool({
    name:      "get_patient_by_id",
    arguments: { patient_id: patientId },
  });
  const pContent = pResp.content as Array<{ type: string; text: string }>;
  const patient  = JSON.parse(pContent[0].text);

  // —— Fetch history
  const hResp = await client.callTool({
    name:      "get_prescription_history",
    arguments: {},
  });
  const hContent   = hResp.content as Array<{ type: string; text: string }>;
  const historyText = hContent[0].text.trim();

  // —— Build the prompt
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

  // —— Call Gemini
  const ai   = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const gem  = await ai.models.generateContent({
    model:    "gemini-1.5-flash",
    contents: prompt,
  });

  // —— Print the result
  console.log("\n=== Prescription ===\n");
  console.log(gem.text?.trim());
}
