const { createLogger, format, transports } = require('winston');
const path = require('path');

// Helper function to format timestamps in a specific timezone
const getTimestampInTimezone = (timezone) => {
    const now = new Date();
    const options = {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    };
    const formattedDate = new Intl.DateTimeFormat('en-US', options).format(now);
    const milliseconds = now.getMilliseconds().toString().padStart(3, '0'); // Ensure 3 digits for milliseconds
    const cleanDate = formattedDate.replace(/[:/]/g, '-').replace(', ', '-');
    return `${cleanDate}-${milliseconds}`;
};

const timezone = 'Asia/Kuala_Lumpur';
const timestamp = getTimestampInTimezone(timezone); // Now includes milliseconds
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
