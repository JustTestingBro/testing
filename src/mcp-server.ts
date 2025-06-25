#!/usr/bin/env node
import dotenv from 'dotenv'
import fs from 'fs/promises'
import mongoose, { Schema, model } from 'mongoose'
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { GoogleGenAI } from '@google/genai'

dotenv.config()

// —— Environment‐variable guards ——
const MONGO_URI = process.env.MONGO_URI
if (!MONGO_URI) {
  throw new Error('Missing MONGO_URI environment variable')
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
if (!GEMINI_API_KEY) {
  throw new Error('Missing GEMINI_API_KEY environment variable')
}

// —— MongoDB setup ——
await mongoose.connect(MONGO_URI, { dbName: 'prescriptions' })
console.log('[MongoDB] Connected')

interface Patient {
  id: string
  name: string
  age: number
  diagnosis: string
  history: string[]
}

const patientSchema = new Schema<Patient>({
  id:        { type: String, required: true },
  name:      { type: String, required: true },
  age:       { type: Number, required: true },
  diagnosis: { type: String, required: true },
  history:   { type: [String], required: true },
})

const PatientModel = model<Patient>('Patient', patientSchema)

// —— Gemini AI setup ——
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY })

function buildPrompt(patient: Patient, symptoms: string, pastData: string): string {
  return `
You are a licensed doctor. Based on the following patient details and symptoms,
write a professional, short, and safe prescription using only generic medicine names.

Patient Details:
- Age: ${patient.age}
- Diagnosis: ${patient.diagnosis}
- History: ${patient.history.join(', ')}

Current Symptoms: ${symptoms}

${pastData ? `Past data:\n${pastData}` : ''}

Write only the prescription—no intros or disclaimers.
`.trim()
}

async function generatePrescription(
  patient_id: string,
  symptoms: string,
  finalPrescription?: string
): Promise<{
  patient: Patient
  generated: string
  prescription: string
}> {
  const patient = await PatientModel.findOne({ id: patient_id }).lean()
  if (!patient) throw new Error('Invalid patient ID')

  const pastData = await fs
    .readFile('past_prescriptions.txt', 'utf-8')
    .catch(() => '')

  const prompt = buildPrompt(patient, symptoms, pastData)
  const res = await ai.models.generateContent({
    model: 'gemini-1.5-flash',
    contents: prompt,
  })
  const generated = res.text?.trim() ?? ''
  const prescription = finalPrescription || generated

  await fs.appendFile(
    'past_prescriptions.txt',
    `\n[${new Date().toISOString()}] Patient:${patient_id} Symptoms:${symptoms} → ${prescription}`,
    'utf-8'
  )

  return { patient, generated, prescription }
}

// —— MCP Server setup ——
const mcp = new MCPServer(
  { name: 'prescription-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_all_patients',
      description: 'List all patients',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_patient_by_id',
      description: 'Get one patient by ID',
      inputSchema: {
        type: 'object',
        properties: {
          patient_id: { type: 'string', description: 'Patient ID' },
        },
        required: ['patient_id'],
      },
    },
    {
      name: 'generate_prescription',
      description: 'Create a prescription based on symptoms',
      inputSchema: {
        type: 'object',
        properties: {
          patient_id:       { type: 'string' },
          symptoms:         { type: 'string' },
          final_prescription:{ type: 'string' },
        },
        required: ['patient_id', 'symptoms'],
      },
    },
    {
      name: 'get_prescription_history',
      description: 'Read the prescription log',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const args = req.params.arguments as Record<string, any> || {}
    switch (req.params.name) {
      case 'get_all_patients': {
        const all = await PatientModel.find().lean()
        return {
          content: [
            {
              type: 'application/json',
              text: JSON.stringify(all, null, 2),
            },
          ],
        }
      }
      case 'get_patient_by_id': {
        const { patient_id } = args
        if (!patient_id) throw new Error('patient_id is required')
        const patient = await PatientModel.findOne({ id: patient_id }).lean()
        if (!patient) throw new Error('Patient not found')
        return {
          content: [
            {
              type: 'application/json',
              text: JSON.stringify(patient, null, 2),
            },
          ],
        }
      }
      case 'generate_prescription': {
        const { patient_id, symptoms, final_prescription } = args
        const result = await generatePrescription(patient_id, symptoms, final_prescription)
        return {
          content: [
            {
              type: 'application/json',
              text: JSON.stringify(result, null, 2),
            },
          ],
        }
      }
      case 'get_prescription_history': {
        const log = await fs.readFile('past_prescriptions.txt', 'utf-8').catch(() => '')
        return {
          content: [{ type: 'text', text: log || 'No history found.' }],
        }
      }
      default:
        throw new Error(`Unknown tool: ${req.params.name}`)
    }
  } catch (e: unknown) {
    // Safely log or return the error
    if (e instanceof Error) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] }
    }
    return { content: [{ type: 'text', text: 'An unknown error occurred.' }] }
  }
})

mcp.onerror = (err: unknown) => {
  if (err instanceof Error) {
    console.error(`[MCP ERROR] ${err.message}`)
  } else {
    console.error('[MCP ERROR]', err)
  }
}

await mcp.connect(new StdioServerTransport())
console.log('[MCP] Server running over stdio')
