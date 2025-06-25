#!/usr/bin/env tsx
import dotenv from "dotenv";
dotenv.config();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mongoose, { Schema, model } from "mongoose";
import fs from "fs/promises";
import { InferenceClient } from "@huggingface/inference";

// ——— Env check ———
const { MONGO_URI, HF_API_TOKEN } = process.env;
if (!MONGO_URI || !HF_API_TOKEN) {
  console.error("⚠️ Missing MONGO_URI or HF_API_TOKEN in .env");
  process.exit(1);
}

// ——— MongoDB & Patient model ———
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

// ——— Hugging Face Client for Embedding ———
const hf = new InferenceClient(HF_API_TOKEN);

async function embed(text: string): Promise<number[]> {
  const res = await hf.featureExtraction({
    model: "sentence-transformers/all-MiniLM-L6-v2",
    inputs: text,
  });
  if (!Array.isArray(res)) throw new Error("Failed to get embedding");
  return res as number[];
}

function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val ** 2, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val ** 2, 0));
  return dot / (magA * magB);
}

// ——— MCP server & tool registration ———
const server = new McpServer({ name: "prescription-mcp", version: "1.0.0" });

// 1) List all patients
server.registerTool(
  "get_all_patients",
  {
    title: "Get All Patients",
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

// 2) Fetch one patient by ID
server.registerTool(
  "get_patient_by_id",
  {
    title: "Get Patient by ID",
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

// 3) Read prescription history
server.registerTool(
  "get_prescription_history",
  {
    title: "Get Prescription History",
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

// 4) Record a new prescription entry with full details
server.registerTool(
  "add_prescription",
  {
    title: "Add Prescription",
    description: "Append a new prescription entry to the history log",
    inputSchema: {
      patient_id: z.string(),
      symptoms: z.string(),
      prescription: z.string(),
    },
  },
  async ({ patient_id, symptoms, prescription }) => {
    const patient = await PatientModel.findOne({ id: patient_id }).lean();
    if (!patient) throw new Error("Patient not found");

    const entry = `Patient: ${patient_id} | Age: ${patient.age} | Diagnosis: ${patient.diagnosis} | History: ${patient.history.join(", ")} | Symptoms: ${symptoms} | Prescription: ${prescription}\n`;
    await fs.appendFile("past_prescriptions.txt", entry, "utf-8");
    return {
      content: [
        {
          type: "text",
          text: "Prescription logged.",
        },
      ],
    };
  }
);

// 5) RAG Tool: Get Similar Prescriptions
server.registerTool(
  "get_similar_prescriptions",
  {
    title: "Get Similar Prescriptions",
    description: "Retrieve top similar past prescriptions using RAG",
    inputSchema: {
      patient_id: z.string(),
      symptoms: z.string(),
    },
  },
  async ({ patient_id, symptoms }) => {
    const patient = await PatientModel.findOne({ id: patient_id }).lean();
    if (!patient) throw new Error("Patient not found");

    const histText = await fs.readFile("past_prescriptions.txt", "utf-8").catch(() => "");
    if (!histText) return { content: [{ type: "text", text: "No history available." }] };

    const records = histText.split("\n").filter(Boolean).map(line => {
      const parts = line.split("|").map(p => p.trim());
      const age = parts[1]?.split(":")[1]?.trim() ?? "";
      const diagnosis = parts[2]?.split(":")[1]?.trim() ?? "";
      const history = parts[3]?.split(":")[1]?.trim() ?? "";
      const symptoms = parts[4]?.split(":")[1]?.trim() ?? "";
      const prescription = parts[5]?.split(":")[1]?.trim() ?? "";
      return {
        raw: line,
        age,
        diagnosis,
        history,
        symptoms,
        prescription,
        vector: [] as number[],
      };
    });

    await Promise.all(records.map(async r => {
      r.vector = await embed(`${r.age} ${r.diagnosis} ${r.history} ${r.symptoms} ${r.prescription}`);
    }));

    const queryVector = await embed(`${patient.age} ${patient.diagnosis} ${patient.history.join(" ")} ${symptoms}`);

    const ranked = records.map(r => ({
      ...r,
      score: cosine(r.vector, queryVector),
    })).sort((a, b) => b.score - a.score);

    const topRecords = ranked.slice(0, 2).map(r => r.raw).join("\n");

    return {
      content: [
        {
          type: "text",
          text: topRecords || "No similar prescriptions found.",
        },
      ],
    };
  }
);

// ——— Start MCP server ———
await server.connect(new StdioServerTransport());
console.log("[MCP] prescription-mcp server running on stdio");
