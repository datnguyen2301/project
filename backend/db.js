const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/camera_surveillance';
const RETRY_INTERVAL_MS = 5000;

async function connectDB() {
  const attempt = async () => {
    try {
      await mongoose.connect(MONGO_URI);
      console.log(`MongoDB connected: ${MONGO_URI}`);
      return true;
    } catch (err) {
      console.warn(`MongoDB connection failed: ${err.message}. Retrying in ${RETRY_INTERVAL_MS / 1000}s...`);
      return false;
    }
  };

  const ok = await attempt();
  if (!ok) {
    setInterval(async () => {
      if (mongoose.connection.readyState === 0) {
        await attempt();
      }
    }, RETRY_INTERVAL_MS);
  }
}

module.exports = connectDB;
