// src/import-patients.ts

import mongoose from 'mongoose';
import fs from 'fs/promises';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI!;
if (!MONGO_URI) throw new Error('MONGO_URI not found in .env');

const patientSchema = new mongoose.Schema({
  id: String,
  name: String,
  age: Number,
  diagnosis: String,
  history: [String],
});

const PatientModel = mongoose.model('Patient', patientSchema);

const importData = async () => {
  await mongoose.connect(MONGO_URI, {
    dbName: 'prescriptions',
  });
  console.log('[MongoDB] Connected');

  const data = await fs.readFile('app/data/patients.json', 'utf-8');
  const patients = JSON.parse(data);

  await PatientModel.deleteMany(); // Optional: clear existing data
  await PatientModel.insertMany(patients);
  console.log('[MongoDB] Patients imported:', patients.length);

  await mongoose.disconnect();
};

importData().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
