const express = require('express');
const cors = require('cors'); // <-- add this
// const helmet = require('helmet');
// const morgan = require('morgan');
const bodyParser = require('body-parser');
const v1 = require('./routes/v1');

const app = express();

// Enable CORS for all origins
app.use(cors());

// app.use(helmet());
// app.use(morgan('combined'));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use('/api/v1', v1);

// global error handler - always return json
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ status: false, error: err.message || 'Internal Error' });
});

module.exports = app;
