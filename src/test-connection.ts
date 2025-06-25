import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI!, {
      serverSelectionTimeoutMS: 10000,
    });
    console.log('✅ MongoDB connected successfully');
    await mongoose.disconnect();
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
  }
})();
