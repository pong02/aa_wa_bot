const { createLogger, format, transports } = require('winston');
const path = require('path');

const timestamp = new Date().toISOString().replace(/:/g, '-'); // Replace colons for a valid file name
const logFileName = `bot-${timestamp}.log`;

const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: path.resolve(__dirname, 'logs', logFileName) })
    ]
});

module.exports = logger;
