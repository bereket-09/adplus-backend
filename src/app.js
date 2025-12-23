const express = require('express');
const cors = require('cors'); 
const v1 = require('./routes/v1');

const app = express();

// Enable CORS
app.use(cors());

// *** IMPORTANT: Restore JSON + URL parsing ***
// These DO NOT break file uploads.
// They simply activate only when the request content-type matches.
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true }));

// API routes
app.use('/api/v1', v1);

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ 
    status: false, 
    error: err.message || 'Internal Error' 
  });
});

module.exports = app;
