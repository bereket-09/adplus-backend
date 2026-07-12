const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const v1 = require('./routes/v1');
const logger = require('./utils/logger');

const app = express();

// Behind Vercel / onrender / Nginx: trust the first proxy so req.ip and the
// X-Forwarded-For used by rate limiting + fraud signals reflect the real client.
app.set('trust proxy', 1);

// Security headers (HSTS, no-sniff, frameguard, etc.).
app.use(helmet());

// CORS allowlist. The Next.js proxy calls server-to-server (no Origin) and is
// allowed; real browser origins must be whitelisted via CORS_ORIGINS.
const allowedOrigins = (
  process.env.CORS_ORIGINS || 'https://adlaunch-next.vercel.app,http://localhost:3000'
).split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);            // same-origin / server-to-server
    return cb(null, allowedOrigins.includes(origin));
  },
  credentials: true,
}));

// Body parsing with sane limits — file uploads go through multer, not JSON,
// so a 1mb JSON cap is plenty and blocks large-payload DoS.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Strip $-prefixed / dotted keys from body/params/query to block NoSQL operator
// injection (e.g. { "password": { "$ne": null } }).
app.use(mongoSanitize({ replaceWith: '_' }));

// API routes
app.use('/api/v1', v1);

// Global error handler — log full detail server-side, never leak internals or
// stack traces to clients on 5xx.
app.use((err, req, res, next) => {
  logger.error(`Unhandled - ${req.method} ${req.originalUrl || req.url} - ${err.message}`);
  const status = err.status || 500;
  const message = status < 500 ? (err.message || 'Error') : 'Internal Error';
  res.status(status).json({ status: false, error: message });
});

module.exports = app;
