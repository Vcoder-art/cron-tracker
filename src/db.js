// Shared Mongo connection used by the API process and the scripts.
// Each process calls connectDB() once at startup.
const mongoose = require('mongoose');
const { MONGO_URI } = require('./config');

mongoose.set('strictQuery', true); // same choice the main app will need before Mongoose 7

async function connectDB(processName) {
  await mongoose.connect(MONGO_URI);
  console.log(`[${processName}] Mongo connected -> ${MONGO_URI}`);
}

module.exports = { connectDB, mongoose };
