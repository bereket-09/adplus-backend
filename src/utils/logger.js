// utils/logger.js
const { createLogger, format, transports } = require('winston');
const os = require('os');

const { combine, timestamp, printf } = format;

// Custom log format
const logFormat = printf(({ level, message, timestamp }) => {
    return `${timestamp} - [${os.hostname()}] [${process.pid}] - ${level.toUpperCase()} - ${message}`;
});

const logger = createLogger({
    level: 'debug', // capture debug, info, error
    format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })),
    transports: [
        new transports.Console({
            format: logFormat
        }),
        // Optional file logs
        // new transports.File({ filename: 'logs/error.log', level: 'error', format: logFormat }),
        // new transports.File({ filename: 'logs/combined.log', format: logFormat })
    ],
    exitOnError: false
});

module.exports = logger;
