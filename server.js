require('dotenv').config();
const app = require('./src/app');
const mongoose = require('mongoose');
const logger = require('./src/utils/logger'); // Import your Winston logger

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/video_ads';

mongoose.set('strictQuery', false);

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    logger.info(`Server startup - MongoDB connected`);
    app.listen(PORT, () => logger.info(`Server listening on port ${PORT}`));
  })
  .catch(err => {
    logger.error(`MongoDB connection error - ${err.message}`);
    process.exit(1);
  });
