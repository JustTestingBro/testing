#!/usr/bin/env ts-node
import path from 'path'
import express from 'express'
import cors from 'cors'

// —— MCP CLIENT imports ——
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

dotenv.config()

// MCP client must know where the server entrypoint is:
const serverEntry = path.join(__dirname, 'mcp-server.ts')

// 1) create & connect the client, spawning your server
const client = new MCPClient(
  { name: 'prescription-mcp-client', version: '1.0.0' },
  { capabilities: {} }
)

await client.connect(
  new StdioClientTransport({
    command: 'npx',             // use npx to launch ts-node
    args:    ['ts-node', serverEntry],
  })
)

// helper to proxy tool calls
async function callTool(name: string, args: Record<string, any> = {}) {
  const resp = await client.callTool({ name, arguments: args })
  const arr  = resp.content as Array<{ text: string }>
  const txt  = arr[0].text!
  return name === 'get_prescription_history' ? txt : JSON.parse(txt)
}

// 2) spin up Express
const app = express()
app.use(cors())
app.use(express.json())
app.use('/', express.static(path.join(__dirname, 'public')))

// REST endpoints that proxy into MCP
app.get('/api/patients',           (_,res) => callTool('get_all_patients').then(json=>res.json(json)))
app.get('/api/patients/:id',       (req,res)=> callTool('get_patient_by_id',{patient_id:req.params.id})
                                      .then(json=>res.json(json))
                                      .catch(err=>res.status(404).json({error:err.message})))
app.post('/api/generate_prescription',(req,res)=> {
  const { patient_id, symptoms, final_prescription } = req.body
  return callTool('generate_prescription',{patient_id,symptoms,final_prescription})
    .then(json=>res.json(json))
    .catch(err=>res.status(400).json({error:err.message}))
})
app.get('/api/history',            (_,res)=> callTool('get_prescription_history').then(txt=>res.type('text').send(txt)))

const HTTP_PORT = process.env.HTTP_PORT || 4000
app.listen(HTTP_PORT, () => console.log(`[HTTP] UI on http://localhost:${HTTP_PORT}/`))
