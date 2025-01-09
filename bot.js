const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const inventoryPath = path.resolve(__dirname, 'storage/envelope_inventory.json');
const stampInventoryPath = path.resolve(__dirname, 'storage/stamp_inventory.json');
const stampConfigPath = path.resolve(__dirname, 'storage/envelope_stamp.json');
const pricesPath = path.resolve(__dirname, 'storage/prices.json');
const groupsFilePath = path.resolve(__dirname, 'settings/groups.json');
const googleApiKey = path.resolve(__dirname, 'auth/service-account-key.json');
const ocrConfig = path.resolve(__dirname, 'settings/ocr-config.json');
const authDir = './auth';
const logger = require('./logger');
const vision = require('@google-cloud/vision');
const stringSimilarity = require('string-similarity');
const csv = require('csv-parser');
const dataStorePath = './datastore.json';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// globals 
let threshold = 0.75; //default

// Set up the Vision API client
const visionClient = new vision.ImageAnnotatorClient({
    keyFilename: googleApiKey
});

// Reference data (to be set by /ocr-reference)
let referenceData = [];

// Load CSV reference data
function loadReference(filePath) {
    logger.info('Loading reference data from CSV.');
    return new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => rows.push(data))
            .on('end', () => {
                logger.info(`Loaded ${rows.length} rows of reference data.`);
                resolve(rows);
            })
            .on('error', (err) => {
                logger.error('Error loading reference data:', err);
                reject(err);
            });
    });
}

// Ensure required files exist
if (!fs.existsSync(dataStorePath)) fs.writeFileSync(dataStorePath, JSON.stringify({}));
if (!fs.existsSync(groupsFilePath)) fs.writeFileSync(groupsFilePath, JSON.stringify([]));
if (!fs.existsSync(pricesPath)) fs.writeFileSync(pricesPath, JSON.stringify({}, null, 2));
if (fs.existsSync(ocrConfig)) {
    config = JSON.parse(fs.readFileSync(ocrConfig, 'utf-8'));
    threshold = config.threshold;
} else {
    logger.warn('Config file not found. Falling back to default threshold.');
}

logger.info(`OCR initialised with threshold of ${threshold}`);
// Utility functions for file storage
function loadAllowedGroups() {
    return JSON.parse(fs.readFileSync(groupsFilePath, 'utf-8'));
}

function saveAllowedGroups(groups) {
    fs.writeFileSync(groupsFilePath, JSON.stringify(groups, null, 2));
}

function loadPrices() {
    if (fs.existsSync(pricesPath)) {
        return JSON.parse(fs.readFileSync(pricesPath, 'utf-8'));
    }
    return {};
}

function savePrices(prices) {
    fs.writeFileSync(pricesPath, JSON.stringify(prices, null, 2));
}

function addPrices(rawString) {
    const prices = loadPrices();

    const lines = rawString.split('\n').slice(1); // Remove the command line
    let response = 'Price Updates:\n';

    lines.forEach((line) => {
        logger.debug("Now checking price.json: ", line)
        const [envelopeType, price] = line.split(':').map((s) => s.trim());
        if (envelopeType && price && !isNaN(price)) {
            const existingKey = Object.keys(prices).find(
                (key) => key.toUpperCase() === envelopeType.toUpperCase()
            );

            const normalizedKey = existingKey || envelopeType;
            prices[normalizedKey] = parseFloat(price);
            if (existingKey) {
                response += `${normalizedKey}: Updated to ${parseFloat(price)}\n`;
                logger.debug(response);
            }
            else {
                response += `${normalizedKey}: Added new price for ${envelopeType} at ${parseFloat(price)}\n`;
            }
        } else {
            response += `Invalid entry: ${line}\n`;
        }
    });

    savePrices(prices); // Save updated prices
    return response;
}

function listPrices() {
    const prices = loadPrices();
    if (Object.keys(prices).length === 0) return 'No prices found.';

    let response = 'Prices:\n';
    for (const [envelopeType, price] of Object.entries(prices)) {
        response += `${envelopeType}: ${price}\n`;
    }

    return response;
}

async function loadDatastore() {
    const data = fs.readFileSync(dataStorePath);
    return JSON.parse(data);
}

async function saveDatastore(datastore) {
    fs.writeFileSync(dataStorePath, JSON.stringify(datastore, null, 2));
}

// Utility functions for inventory and usage
function parseUsage(rawString) {
    const lines = rawString.replace(/pcs/g, '').replace(/pc/g, '').split('\n').slice(1);
    const usageMap = new Map();

    lines.forEach((line) => {
        const [key, value] = line.split(':').map((s) => s.trim());
        if (key && value && !isNaN(value)) {
            usageMap.set(key.toUpperCase(), parseInt(value, 10));
        }
    });

    return usageMap;
}

function computeUsage(usageMap) {
    let inventory = fs.existsSync(inventoryPath) ? JSON.parse(fs.readFileSync(inventoryPath, 'utf-8')) : {};
    const normalizedInventory = Object.keys(inventory).reduce((acc, key) => {
        acc[key.toLowerCase()] = inventory[key];
        return acc;
    }, {});
    const updatedInventory = { ...normalizedInventory }; //clone inveentory for edit

    let response = '';
    usageMap.forEach((quantity, itemCode) => {
        const normalizedKey = itemCode.toLowerCase();
        if (updatedInventory[normalizedKey] !== undefined) {
            updatedInventory[normalizedKey] -= quantity;
            response += `${itemCode}: Updated balance to ${updatedInventory[normalizedKey]}\n`;
        } else {
            response += `Item ${itemCode} not found in inventory.\n`;
        }
    });

    const finalInventory = Object.keys(inventory).reduce((acc, key) => {
        acc[key] = updatedInventory[key.toLowerCase()] || 0;
        return acc;
    }, {});

    fs.writeFileSync(inventoryPath, JSON.stringify(finalInventory, null, 2));
    console.log('Inventory updated:', finalInventory);

    return response;
}

function printInventory() {
    const inventory = fs.existsSync(inventoryPath) ? JSON.parse(fs.readFileSync(inventoryPath, 'utf-8')) : {};
    return Object.entries(inventory).reduce((acc, [itemCode, quantity]) => `${acc}${itemCode}: ${quantity}\n`, 'Inventory:\n');
}

function calculateStampUsage(usageMap) {
    const stampConfigurations = JSON.parse(fs.readFileSync(stampConfigPath, 'utf-8'));
    const stampInventory = fs.existsSync(stampInventoryPath)
        ? JSON.parse(fs.readFileSync(stampInventoryPath, 'utf-8'))
        : {};

    const normalizedStampInventory = Object.keys(stampInventory).reduce((acc, key) => {
        acc[key.toLowerCase()] = stampInventory[key];
        return acc;
    }, {});
    const normalizedStampConfigurations = Object.keys(stampConfigurations).reduce((acc, key) => {
        acc[key.toLowerCase()] = Object.entries(stampConfigurations[key]).reduce((innerAcc, [stampType, stampCount]) => {
            innerAcc[stampType.toLowerCase()] = stampCount;
            return innerAcc;
        }, {});
        return acc;
    }, {});

    let response = 'Stamp Usage Calculation:\n';
    usageMap.forEach((quantity, envelopeType) => {
        const normalizedEnvelopeType = envelopeType.toLowerCase();
        const requiredStamps = normalizedStampConfigurations[normalizedEnvelopeType];

        if (requiredStamps) {
            Object.entries(requiredStamps).forEach(([stampType, stampCount]) => {
                const totalStampsNeeded = stampCount * quantity;
                if (normalizedStampInventory[stampType] !== undefined) {
                    normalizedStampInventory[stampType] -= totalStampsNeeded;
                    response += `${stampType}: ${totalStampsNeeded} used for ${envelopeType}\n`;
                } else {
                    response += `Stamp type ${stampType} not found in inventory.\n`;
                }
            });
        } else {
            response += `No stamp configuration found for ${envelopeType}.\n`;
        }
    });

    const finalStampInventory = Object.keys(stampInventory).reduce((acc, key) => {
        acc[key] = normalizedStampInventory[key.toLowerCase()] || 0;
        return acc;
    }, {});

    fs.writeFileSync(stampInventoryPath, JSON.stringify(finalStampInventory, null, 2));
    return response;
}

function printStampInventory() {
    const stampInventory = fs.existsSync(stampInventoryPath) ? JSON.parse(fs.readFileSync(stampInventoryPath, 'utf-8')) : {};
    return Object.entries(stampInventory).reduce((acc, [stampType, quantity]) => `${acc}${stampType}: ${quantity}\n`, 'Stamp Inventory Status:\n');
}

async function listGroups(sock, sender) {
    const groups = await sock.groupFetchAllParticipating();
    const groupList = Object.entries(groups).map(([id, metadata], index) => ({
        number: index + 1,
        id,
        name: metadata.subject,
    }));

    let response = 'Groups the bot is added to:\n';
    groupList.forEach((group) => {
        response += `${group.number}. ${group.name}\n`;
    });

    await sock.sendMessage(sender, { text: response });
    return groupList;
}

async function registerGroups(sock, sender, text, groupList) {
    const registeredGroups = loadAllowedGroups();
    const numbers = text.replace('/register', '').split(',').map((num) => parseInt(num.trim(), 10)).filter((num) => !isNaN(num));

    let response = 'Registered Groups:\n';
    numbers.forEach((num) => {
        const group = groupList.find((g) => g.number === num);
        if (group && !registeredGroups.includes(group.id)) {
            registeredGroups.push(group.id);
            response += `${group.name}\n`;
        }
    });

    saveAllowedGroups(registeredGroups);
    await sock.sendMessage(sender, { text: response });
}

async function listRegisteredGroups(sock, sender) {
    const registeredGroups = loadAllowedGroups();

    if (registeredGroups.length === 0) {
        await sock.sendMessage(sender, { text: 'No groups are currently registered.' });
        return;
    }

    let response = 'Registered Groups:\n';
    for (const groupId of registeredGroups) {
        try {
            const groupMetadata = await sock.groupMetadata(groupId);
            response += `- ${groupMetadata.subject}\n`;
        } catch (error) {
            console.error(`Error fetching metadata for group ID: ${groupId}`, error);
            response += `- Unknown Group (ID: ${groupId})\n`;
        }
    }

    await sock.sendMessage(sender, { text: response });
}

function addEnvelopes(rawString) {
    // Load the inventory from file
    let inventory = fs.existsSync(inventoryPath) ? JSON.parse(fs.readFileSync(inventoryPath, 'utf-8')) : {};

    // Normalize inventory keys to lowercase for case insensitivity
    const normalizedInventory = Object.keys(inventory).reduce((acc, key) => {
        acc[key.toLowerCase()] = inventory[key];
        return acc;
    }, {});

    // Parse the input string
    const lines = rawString.replace(/pcs/g, '').split('\n').slice(1); // Remove "pcs" and split lines
    const additionMap = new Map();

    lines.forEach((line) => {
        const [key, value] = line.split(':').map((s) => s.trim());
        if (key && value && !isNaN(value)) {
            additionMap.set(key.toLowerCase(), parseInt(value, 10)); // Store in lowercase
        }
    });

    // Add the parsed quantities to the inventory
    let response = 'Envelope Addition Results:\n';
    additionMap.forEach((quantity, envelopeType) => {
        if (normalizedInventory[envelopeType] !== undefined) {
            normalizedInventory[envelopeType] += quantity;
            response += `${envelopeType}: Added ${quantity}, New Total: ${normalizedInventory[envelopeType]}\n`;
        } else {
            response += `Envelope type ${envelopeType} not found in inventory. Creating new entry.\n`;
            normalizedInventory[envelopeType] = quantity;
        }
    });

    // Save updated inventory, preserving original case for keys
    const finalInventory = Object.keys(inventory).reduce((acc, key) => {
        acc[key] = normalizedInventory[key.toLowerCase()] || 0;
        return acc;
    }, {});

    fs.writeFileSync(inventoryPath, JSON.stringify(finalInventory, null, 2));
    console.log('Envelope inventory updated:', finalInventory);

    return response;
}

function addStamps(rawString) {
    // Load the stamp inventory from file
    let stampInventory = fs.existsSync(stampInventoryPath) ? JSON.parse(fs.readFileSync(stampInventoryPath, 'utf-8')) : {};

    // Normalize inventory keys to lowercase for case insensitivity
    const normalizedStampInventory = Object.keys(stampInventory).reduce((acc, key) => {
        acc[key.toLowerCase()] = stampInventory[key];
        return acc;
    }, {});

    // Parse the input string
    const lines = rawString.replace(/pcs/g, '').split('\n').slice(1); // Remove "pcs" and split lines
    const additionMap = new Map();

    lines.forEach((line) => {
        const [key, value] = line.split(':').map((s) => s.trim());
        if (key && value && !isNaN(value)) {
            additionMap.set(key.toLowerCase(), parseInt(value, 10)); // Store in lowercase
        }
    });

    // Add the parsed quantities to the stamp inventory
    let response = 'Stamp Addition Results:\n';
    additionMap.forEach((quantity, stampType) => {
        if (normalizedStampInventory[stampType] !== undefined) {
            normalizedStampInventory[stampType] += quantity;
            response += `${stampType}: Added ${quantity}, New Total: ${normalizedStampInventory[stampType]}\n`;
        } else {
            response += `Stamp type ${stampType} not found in inventory. Creating new entry.\n`;
            normalizedStampInventory[stampType] = quantity;
        }
    });

    // Save updated inventory, preserving original case for keys
    const finalStampInventory = Object.keys(stampInventory).reduce((acc, key) => {
        acc[key] = normalizedStampInventory[key.toLowerCase()] || 0;
        return acc;
    }, {});

    fs.writeFileSync(stampInventoryPath, JSON.stringify(finalStampInventory, null, 2));
    console.log('Stamp inventory updated:', finalStampInventory);

    return response;
}

function calculateTotalCost(rawString) {
    // Load existing prices
    const prices = loadPrices();

    const lines = rawString.split('\n').slice(1); // Remove the command line
    let response = 'Purchase Summary:\n';
    let totalCost = 0;

    lines.forEach((line) => {
        const [envelopeType, quantity] = line.split(':').map((s) => s.trim());
        if (envelopeType && quantity && !isNaN(quantity)) {
            // Find existing match ignoring case
            const existingKey = Object.keys(prices).find(
                (key) => key.toUpperCase() === envelopeType.toUpperCase()
            );

            if (existingKey) {
                const price = prices[existingKey];
                const cost = price * parseInt(quantity, 10);
                totalCost += cost;
                response += `${existingKey}: ${quantity} * ${price} = ${cost.toFixed(2)}\n`;
            } else {
                response += `${envelopeType}: Not found\n`;
            }
        } else {
            response += `Invalid entry: ${line}\n`;
        }
    });

    response += `Total: ${totalCost.toFixed(2)}`;
    return response;
}

function printMatch(rowStr, similarity, caption) {
    let indicator = '🔴';
    if (similarity > threshold){
        indicator = '🟢';
    } else if (similarity > 0.5){
        indicator = '🟠';
    }
    let row = rowStr.join(', ').trim(" ").trim("*").replace('*', 'x');
    let reviewStr = "Matched Row";
    if (similarity < threshold) {
        reviewStr = "Matched with LOW CONFIDENCE, *⚠️ REVIEW NEEDED ⚠️* "
    }
    let confidence = (similarity * 100).toFixed(2)
    let optionalCaption = "";
    if (caption) {
        optionalCaption = "Caption: " + caption
    }
    return `${reviewStr}: ${row}\nConfidence: ${confidence}% ${indicator} ${optionalCaption}`
}

function printOCR(rowStr, caption) {
    let row = rowStr.trim(" ").trim("*");
    let optionalCaption = "";
    if (caption) {
        optionalCaption = "Caption: " + caption
    }
    return `🔍 Read label: ${row}\nConfidence: 0%${optionalCaption}`
}

async function ocr(imageBuffer) {
    try {
        logger.info('Performing OCR on image.');
        // Ensure imageBuffer is base64-encoded as expected by Vision API
        const request = {
            image: { content: imageBuffer.toString('base64') },
            features: [{ type: 'TEXT_DETECTION' }]
        };

        logger.debug('OCR request:', request);

        const [result] = await visionClient.annotateImage(request);
        const detections = result.textAnnotations || [];
        const text = detections.length ? detections[0].description : '';

        logger.debug('OCR result:', text);
        return text;
    } catch (error) {
        logger.error('Error during OCR:', error);
        return null;
    }
}

function preprocessLabel(text) {
    return text
        .replace(/^To:\s*/, '')
        .replace(/^\*+|\*+$/g, '')
        .trim();
}


function closestRow(ocrResult, reference) {
    const preprocessedOcr = preprocessLabel(ocrResult);


    if (reference.length === 0) {
        return { match: preprocessedOcr, confidence: 0 }
    }

    logger.debug(`Matching Label ${preprocessedOcr} with reference data...`)

    let bestMatch = { similarity: 0, row: null };

    reference.forEach((row) => {
        const preprocessedRow = Object.entries(row)
            .filter(([key]) => !['ID', 'Quantity'].includes(key))
            .map(([_, value]) => value) // Extract the values
            .join(' ');

        const similarity = stringSimilarity.compareTwoStrings(preprocessedOcr, preprocessedRow);

        if (similarity > bestMatch.similarity) {
            bestMatch = { similarity, row };
            logger.debug(`Highest match so far (${similarity}): ${bestMatch.row}`)
        }
    });

    logger.info(`Best match confidence: ${bestMatch.similarity}`);
    return { match: bestMatch.row, confidence: bestMatch.similarity };
}

let isOcrSessionActive = false;
let isAwaitingCsv = false;
let ocrResults = [];

async function startOcrSession(sock, sender) {
    logger.info('Starting OCR session.');
    if (referenceData.length === 0) {
        logger.warn("OCR started with no reference, 100% failure rate")
        await sock.sendMessage(sender, { text: 'OCR session started without reference csv, /ocr-reference to avoid failing every OCR.' });
    }
    isOcrSessionActive = true;
    ocrResults = [];
    await sock.sendMessage(sender, { text: 'OCR session started. Send images to process.' });
}

async function endOcrSession(sock, sender) {
    logger.info('Ending OCR session.');
    isOcrSessionActive = false;
    const resultPath = path.resolve(__dirname, 'ocr_results.csv');
    const csvContent = ocrResults.map((row) => Object.values(row).join(',')).join('\n');
    fs.writeFileSync(resultPath, csvContent);

    logger.info('Sending OCR results as CSV.');
    await sock.sendMessage(sender, {
        document: { url: resultPath },
        mimetype: 'text/csv',
        fileName: 'ocr_results.csv'
    });

    fs.unlinkSync(resultPath);
}


async function handleImage(sock, sender, imageBuffer, caption) {
    if (!isOcrSessionActive) {
        logger.warn('Image received outside of OCR session.');
        await sock.sendMessage(sender, { text: 'OCR session is not active. Start with /ocr-start.' });
        return;
    }

    if (referenceData.length === 0) {
        logger.warn('No reference data loaded.');
        await sock.sendMessage(sender, { text: 'No reference data available. Please upload reference data.' });
        //wont stop you but this will always be 0 confidence, thus always fail to match.
    }

    const ocrText = await ocr(imageBuffer);
    if (!ocrText) {
        logger.warn('No text detected in the image.');
        await sock.sendMessage(sender, { text: 'No text detected in the image.' });
        return;
    }

    const { match, confidence } = closestRow(ocrText, referenceData);
    if (match && confidence > threshold) {
        ocrResults.push({ ...match, caption, confidence });
        logger.info(`Matched row added to results with confidence ${confidence}:`, match);
        await sock.sendMessage(sender, {
            text: printMatch(Object.values(match), confidence, caption)
        });
    } else if (match && confidence == 0) {
        logger.info('No reference provided, no match available.');
        await sock.sendMessage(sender, {
            text: printOCR(match, caption)
        });
    } else if (match) {
        logger.info('Low confidence for the image. Review required.');
        await sock.sendMessage(sender, {
            text: printMatch(Object.values(match), confidence, caption)
        });
        await sock.sendMessage(sender, {
            text: printOCR(ocrText, caption)
        });
    } else {
        logger.info('No matching row found for the image.');
        await sock.sendMessage(sender, { text: 'No matching row found in the reference data.' });
    }
}


// Bot initialization
async function startBot() {

    logger.info('Bot is starting...');
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({ auth: state });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Scan the QR code below to log in:');
            logger.info('QR code generated.');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('Bot is now connected!');
            logger.info('Bot reconnected with saved credentials');
        } else if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            logger.info('Connection closed, trying to reconnect...');
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        delay(369);
        const message = m.messages[0];
        if (!message.message) return; //|| message.key.fromMe

        const sender = message.key.remoteJid;
        const text = message.message?.conversation || "";

        const allowedGroups = loadAllowedGroups();

        if (text.startsWith('/list-groups')) {
            const groupList = await listGroups(sock, sender);
            sock.groupList = groupList;
            logger.info('Sent group list');
            logger.debug(groupList);
            return;
        }

        if (text.startsWith('/register') && sock.groupList) {
            let oldGroups = loadAllowedGroups();
            await registerGroups(sock, sender, text, sock.groupList);
            logger.info('Registering groups');
            logger.debug("Received:", text);
            logger.debug("Before:", oldGroups);
            logger.debug("After", loadAllowedGroups());
            return;
        }

        if (text.startsWith('/ping')) {
            await sock.sendMessage(sender, { text: `ok` });
            return;
        }

        if (text.startsWith('/help')) {
            await sock.sendMessage(sender, { text: `https://pong02.github.io/bot-help/` });
            return;
        }

        // Restrict non-public commands to allowed groups
        if (allowedGroups.includes(sender)) {
            if (text.startsWith('/list-registered')) {
                await listRegisteredGroups(sock, sender);
                logger.info('Listing groups');
                logger.debug("Found:", loadAllowedGroups());
                return;
            }

            if (text.startsWith('/ocr-reference')) {
                isAwaitingCsv = true;
                await sock.sendMessage(sender, { text: 'Please send the CSV file now, making sure there are no captions on the attachment.' });
                logger.info('Bot is now awaiting a CSV file.');
                return;
            }

            if (isAwaitingCsv && message.message.documentMessage) {
                const documentMessage = message.message.documentMessage;
                const mimeType = documentMessage.mimetype || '';

                // Check if the MIME type is valid for a CSV
                if (!['text/csv', 'application/vnd.ms-excel'].includes(mimeType)) {
                    logger.warn('Received non-CSV file.');
                    isAwaitingCsv = false; // Reset flag
                    await sock.sendMessage(sender, { text: 'Invalid file type. Please send a CSV file.' });
                    return;
                }

                try {
                    const filePath = path.resolve(__dirname, 'reference.csv');

                    // Download the document as a stream
                    const stream = await downloadMediaMessage(message);
                    if (!stream) {
                        logger.error('Failed to download document.');
                        await sock.sendMessage(sender, { text: 'Failed to download the attached file. Please try again.' });
                        return;
                    }

                    // Convert stream to buffer
                    const buffer = await new Promise((resolve, reject) => {
                        const chunks = [];
                        stream.on('data', (chunk) => chunks.push(chunk));
                        stream.on('end', () => resolve(Buffer.concat(chunks)));
                        stream.on('error', (err) => reject(err));
                    });

                    if (!buffer || buffer.length === 0) {
                        logger.error('File download resulted in an empty buffer.');
                        await sock.sendMessage(sender, { text: 'Failed to download the attached file. Please try again.' });
                        return;
                    }

                    // Save the file locally
                    fs.writeFileSync(filePath, buffer);
                    logger.info(`File saved at ${filePath}`);

                    // Load reference data from the file
                    referenceData = await loadReference(filePath);
                    fs.unlinkSync(filePath); // Delete the file after loading reference data

                    // Confirm success to the user
                    await sock.sendMessage(sender, { text: 'Reference data loaded successfully.' });
                } catch (error) {
                    logger.error('Error handling the CSV file:', error);
                    await sock.sendMessage(sender, { text: 'An error occurred while loading the reference data. Please try again.' });
                } finally {
                    isAwaitingCsv = false; // Reset flag after processing
                }
                return;
            }

            if (text.startsWith('/ocr-start')) {
                await startOcrSession(sock, sender);
                return;
            }

            if (text.startsWith('/ocr-end')) {
                await endOcrSession(sock, sender);
                return;
            }

            if (message.message.imageMessage) {
                if (!isOcrSessionActive) {
                    logger.warn('Image received outside of OCR session. Ignoring.');
                    await sock.sendMessage(sender, { text: 'OCR session is not active. Start with /ocr-start.' });
                    return;
                }

                try {
                    logger.info('Attempting to download image message.');
                    const imageBuffer = await downloadMediaMessage(message, 'buffer', {}, {
                        logger
                    });

                    if (!imageBuffer) {
                        logger.error('Failed to download image buffer.');
                        await sock.sendMessage(sender, { text: 'Failed to process image. Please try again.' });
                        return;
                    }

                    logger.debug('Image buffer downloaded successfully. Length:', imageBuffer.length);
                    const caption = message.message.imageMessage.caption;
                    await handleImage(sock, sender, imageBuffer, caption);
                } catch (error) {
                    logger.error('Error downloading or handling image:', error);
                    await sock.sendMessage(sender, { text: 'An error occurred while processing the image.' });
                }
            }

            if (text.startsWith('/add-prices')) {
                let oldPrices = listPrices();
                const response = addPrices(text);
                logger.info('Adding new Prices');
                logger.debug("Received:", text);
                await sock.sendMessage(sender, { text: response });
                logger.debug("Before:", oldPrices);
                logger.debug("After", listPrices());
                return;
            }

            if (text.startsWith('/prices')) {
                const response = listPrices();
                await sock.sendMessage(sender, { text: response });
                logger.info('Listing prices');
                logger.debug("Found:", response);
                return;
            }

            if (text.startsWith('/inventory')) {
                const inventoryNow = printInventory();
                const stampsNow = printStampInventory();
                await sock.sendMessage(sender, { text: `${inventoryNow}` });
                await sock.sendMessage(sender, { text: `${stampsNow}` });
                logger.info('Listing inventory');
                logger.debug("Envelope:", inventoryNow);
                logger.debug("Stamp:", stampsNow);
                return;
            }

            if (text.startsWith('/buy')) {
                const response = calculateTotalCost(text);
                await sock.sendMessage(sender, { text: response });
                return;
            }

            if (text.startsWith('/estimated-usage')) {
                const usage = parseUsage(text);
                const response = computeUsage(usage);
                const inventoryNow = printInventory();
                const stampResponse = calculateStampUsage(usage);
                const stampsNow = printStampInventory();

                await sock.sendMessage(sender, { text: `Inventory Changes:\n${response}` });
                await sock.sendMessage(sender, { text: `${inventoryNow}` });
                await sock.sendMessage(sender, { text: `Stamp Changes:\n${stampResponse}` });
                await sock.sendMessage(sender, { text: `${stampsNow}` });
                logger.info('Inventory Change');
                logger.debug("Envelope:", response);
                logger.debug("Stamp:", stampResponse);
                return;
            }

            if (text.startsWith('/add-envelopes')) {
                const response = addEnvelopes(text);
                await sock.sendMessage(sender, { text: response });
                logger.info('Envelope Change');
                logger.debug("Envelope:", response);
                return;
            }

            if (text.startsWith('/add-stamps')) {
                const response = addStamps(text);
                await sock.sendMessage(sender, { text: response });
                logger.info('Stamp Change');
                logger.debug("Stamp:", stampResponse);
                return;
            }
        } else {
            console.log(`Message ignored from unregistered group: ${sender}`);
            logger.info(`Ignored Message from ${sender}`);
        }
    });
}

startBot();
