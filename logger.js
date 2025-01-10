const { createLogger, format, transports } = require('winston');
const path = require('path');

// Helper function to format timestamps in a specific timezone
const getTimestampInTimezone = (timezone) => {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).format(new Date());
};

// Replace `America/New_York` with your desired timezone
const timezone = 'Asia/Kuala_Lumpur';
const timestamp = getTimestampInTimezone(timezone).replace(/[:/]/g, '-'); // Replace colons and slashes for valid filename
const logFileName = `bot-${timestamp}.log`;

const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp({ format: () => getTimestampInTimezone(timezone) }),
        format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: path.resolve(__dirname, 'logs', logFileName) })
    ]
});

module.exports = logger;
