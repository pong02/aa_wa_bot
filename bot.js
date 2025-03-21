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
const { get } = require('https');
const dataStorePath = './datastore.json';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_RECONNECTION_ATTEMPTS = 20;

// globals 
let threshold = 0.75; //default
let reconnectionAttempts = 0;
let ocrGroup = [];
let registeredList = [];
let registeredOcrList = [];

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
    ocrGroup = config.targets || [];
} else {
    logger.warn('Config file not found. Falling back to default threshold.');
}

logger.info(`OCR initialised with threshold of ${threshold}`);
logger.info(`OCR initialised to listen to groups ${ocrGroup}.`);

function groupisEmpty(groups) {
    if (Array.isArray(groups) && groups.length > 0) {
        logger.info(`Fetched ${groups.length} groups`);
        return false;
    } else {
        logger.info("Group is empty");
        return true;
    }
}

function loadAllowedGroups() {
    return JSON.parse(fs.readFileSync(groupsFilePath, 'utf-8'));
}

function saveOcrGroups(groupIds) {
    logger.debug("Before OCR saved:", config)
    config.targets = groupIds;
    ocrGroup = groupIds;
    logger.debug("New OCR groups:", config)
    logger.debug(`Added groups ${groupIds} to ocr targets`)
    fs.writeFileSync(ocrConfig, JSON.stringify(config, null, 2), 'utf-8');
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

    const lines = rawString.split('\n').slice(1);
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

    savePrices(prices);
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
    logger.debug('Inventory updated:', finalInventory);

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

async function getGroupName(sock, groupId) {
    try {
        const groupMetadata = await sock.groupMetadata(groupId);

        const groupName = groupMetadata.subject;

        logger.debug(`Group translated: ${groupName}`);
        return groupName;
    } catch (error) {
        console.error('Error fetching group name:', error);
        throw error;
    }
}

async function registerGroups(sock, sender, text, groupList) {
    const registeredGroups = loadAllowedGroups();
    const numbers = text.replace('/register', '').split(',').map((num) => parseInt(num.trim(), 10)).filter((num) => !isNaN(num));

    let nonReg = true;
    let response = 'Registered Groups:\n';
    numbers.forEach((num) => {
        const group = groupList.find((g) => g.number === num);
        if (group && !registeredGroups.includes(group.id)) {
            registeredGroups.push(group.id);
            response += ` - ${group.name}\n`;
            nonReg = false;
        }
    });
    if (nonReg) {
        response += "None."
    }

    saveAllowedGroups(registeredGroups);
    await sock.sendMessage(sender, { text: response });
}

async function listRegisteredGroups(sock, sender) {
    const registeredGroups = loadAllowedGroups();

    if (groupisEmpty(registeredGroups)) {
        await sock.sendMessage(sender, { text: 'No groups are currently registered.' });
        return;
    }

    let count = 0;
    let response = 'Registered Groups:\n';
    for (const groupId of registeredGroups) {
        try {
            count += 1
            const groupMetadata = await sock.groupMetadata(groupId);
            response += `${count}. ${groupMetadata.subject}\n`;
        } catch (error) {
            console.error(`Error fetching metadata for group ID: ${groupId}`, error);
            response += `- Unknown Group (ID: ${groupId})\n`;
        }
    }
    registeredList = registeredGroups;
    if (count == 0) {
        response += "None."
    }

    await sock.sendMessage(sender, { text: response });
}

async function registerOcrGroups(sock, sender, text, groupList) {
    const registeredGroups = ocrGroup;
    const numbers = text.replace('/ocr-register', '').split(',').map((num) => parseInt(num.trim(), 10)).filter((num) => !isNaN(num));
    let nonReg = true;
    let response = 'Registered OCR Groups:\n';
    numbers.forEach((num) => {
        const group = groupList.find((g) => g.number === num);
        if (group && !registeredGroups.includes(group.id)) {
            registeredGroups.push(group.id);
            response += ` - ${group.name}\n`;
            nonReg = false;
        }
    });

    if (nonReg) {
        response += "None.";
    }

    saveOcrGroups(registeredGroups);
    await sock.sendMessage(sender, { text: response });
}

async function listOcrGroups(sock, sender) {
    const registeredGroups = ocrGroup;
    if (groupisEmpty(registeredGroups)) {
        await sock.sendMessage(sender, { text: 'No groups are currently registered for OCR. ' });
        return;
    }

    let count = 0;
    let response = 'Registered OCR Groups:\n';
    for (const groupId of registeredGroups) {
        try {
            count += 1;
            const groupMetadata = await sock.groupMetadata(groupId);
            response += `${count}. ${groupMetadata.subject}\n`;
        } catch (error) {
            logger.error(`Error fetching metadata for group ID: ${groupId}`, error);
            response += `- Unknown Group (ID: ${groupId})\n`;
        }
    }
    registeredOcrList = registeredGroups;
    if (count == 0) {
        response += "None."
    }
    await sock.sendMessage(sender, { text: response });
}

async function deregisterGroups(sock, sender, text) {
    const indexesToRemove = text.replace('/deregister', '').split(',').map(num => parseInt(num.trim(), 10)).filter(num => !isNaN(num) && num > 0);
    logger.debug(`Removal of indices ${indexesToRemove} from list ${registeredOcrList}.`)
    if (indexesToRemove.length === 0) {
        await sock.sendMessage(sender, { text: "No valid numbers provided. Please specify indexes to deregister." });
    }
    registeredList = registeredList.filter((_, index) => !indexesToRemove.includes(index + 1));

    logger.info(`New list: ${registeredList}.`)
    saveAllowedGroups(registeredList);

    let response = "Updated Registered Groups:\n";
    if (registeredList.length > 0) {
        const groupNames = await Promise.all(
            registeredList.map((group, index) => 
                getGroupName(sock, group)
                    .then(groupName => `${index + 1}. ${groupName}`)
                    .catch(error => {
                        logger.warn(`Failed to fetch name for group ${group}: ${error.message}`);
                        return `${index + 1}. [Failed to fetch group name]`;
                    })
            )
        );
        response += groupNames.join('\n');
    } else {
        response += "None.";
    }
    await sock.sendMessage(sender, { text: response });
}

async function deregisterOcrGroups(sock, sender, text) {
    const indexesToRemove = text.replace('/ocr-deregister', '').split(',').map(num => parseInt(num.trim(), 10)).filter(num => !isNaN(num) && num > 0);
    if (indexesToRemove.length === 0) {
        await sock.sendMessage(sender, { text: "No valid numbers provided. Please specify indexes to deregister." });
    }
    logger.debug(`Removal of indices ${indexesToRemove} from list ${registeredOcrList}.`)

    logger.info(`New list: ${registeredList}.`)
    registeredOcrList = registeredOcrList.filter((_, index) => !indexesToRemove.includes(index + 1));

    saveOcrGroups(registeredOcrList);

    let response = "Updated OCR Registered Groups:\n";
    if (registeredList.length > 0) {
        const groupNames = await Promise.all(
            registeredList.map((group, index) => 
                getGroupName(sock, group)
                    .then(groupName => `${index + 1}. ${groupName}`)
                    .catch(error => {
                        logger.warn(`Failed to fetch name for group ${group}: ${error.message}`);
                        return `${index + 1}. [Failed to fetch group name]`;
                    })
            )
        );
        response += groupNames.join('\n');
    } else {
        response += "None.";
    }

    await sock.sendMessage(sender, { text: response });
}

function addEnvelopes(rawString) {
    let inventory = fs.existsSync(inventoryPath) ? JSON.parse(fs.readFileSync(inventoryPath, 'utf-8')) : {};

    // Normalize inventory keys to lowercase for case insensitivity
    const normalizedInventory = Object.keys(inventory).reduce((acc, key) => {
        acc[key.toLowerCase()] = inventory[key];
        return acc;
    }, {});

    const lines = rawString.replace(/pcs/g, '').split('\n').slice(1); // Remove "pcs" and split lines
    const additionMap = new Map();

    lines.forEach((line) => {
        const [key, value] = line.split(':').map((s) => s.trim());
        if (key && value && !isNaN(value)) {
            additionMap.set(key.toLowerCase(), parseInt(value, 10));
        }
    });

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
    logger.debug('Envelope inventory updated:', finalInventory);

    return response;
}

function addStamps(rawString) {
    let stampInventory = fs.existsSync(stampInventoryPath) ? JSON.parse(fs.readFileSync(stampInventoryPath, 'utf-8')) : {};

    // Normalize inventory keys to lowercase for case insensitivity
    const normalizedStampInventory = Object.keys(stampInventory).reduce((acc, key) => {
        acc[key.toLowerCase()] = stampInventory[key];
        return acc;
    }, {});

    const lines = rawString.replace(/pcs/g, '').split('\n').slice(1); // Remove "pcs" and split lines
    const additionMap = new Map();

    lines.forEach((line) => {
        const [key, value] = line.split(':').map((s) => s.trim());
        if (key && value && !isNaN(value)) {
            additionMap.set(key.toLowerCase(), parseInt(value, 10));
        }
    });

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
    logger.debug('Stamp inventory updated:', finalStampInventory);

    return response;
}

function calculateTotalCost(rawString) {
    const prices = loadPrices();

    const lines = rawString.split('\n').slice(1); // Remove the command line
    let response = 'Purchase Summary:\n';
    let totalCost = 0;

    lines.forEach((line) => {
        const [envelopeType, quantity] = line.split(':').map((s) => s.trim());
        if (envelopeType && quantity && !isNaN(quantity)) {
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

function extractLabel(ocrText) {
    // Step 1: Split by "To:"
    let parts = ocrText.split(/To:/i); // Case-insensitive split
    logger.info(`Removing Prefix noise, identified ${parts.length} to process`)
    let extracted = ocrText;
    // Step 2: Take the last part (actual label content)
    if (parts.length >= 2){
        extracted = parts[parts.length - 1].trim();
    } // If no "To:", return string as is

    // Step 3: Remove everything after the item & quantity marker
    starMarker = extracted.lastIndexOf('*');
    if (starMarker !== -1) {
        extracted = extracted.substring(0, Math.max(0, starMarker + 3)).trim();
    }

    logger.info(`[ ! ] Successfully Recognized label in ocr result: ${extracted}`)

    return extracted;
}

function printMatch(rowStr, similarity, caption) {
    let indicator = '🔴';
    if (similarity > threshold) {
        indicator = '🟢';
    } else if (similarity > 0.5) {
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
    const filteredOcr = extractLabel(preprocessLabel(ocrResult));

    if (reference.length === 0) {
        logger.info("Reference not found, defaulting 0% match")
        return { match: filteredOcr, confidence: 0 }
    }

    logger.debug(`Matching Label ${filteredOcr} with reference data...`)

    let bestMatch = { similarity: 0, row: null };

    reference.forEach((row) => {
        const preprocessedRow = Object.entries(row)
            .filter(([key]) => !['ID', 'Quantity'].includes(key))
            .map(([_, value]) => value)
            .join(' ');

        const similarity = stringSimilarity.compareTwoStrings(filteredOcr, preprocessedRow);

        logger.info(`+ Similarity: ${similarity} \n ${filteredOcr} | [${preprocessedRow}]`);

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
            text: printMatch(Object.values(match), confidence, caption) + "\n\n" + printOCR(extractLabel(ocrText), caption)
        });
    } else {
        logger.info('No matching row found for the image.');
        logger.info(match)
        await sock.sendMessage(sender, { text: `No matching row found in the reference data. OCR Result: ${ocrText}` });
    }
}

async function startBot() {

    logger.info('Bot is starting...');
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({
        auth: state,
        syncFullHistory: false,
        defaultQueryTimeoutMs: undefined
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        logger.info(`Connection update event: ${JSON.stringify(update)}`);

        if (update.qr) {
            logger.info("New QR generated")
            console.log('Scan the QR code below to log in:');
            qrcode.generate(update.qr, { small: true });
        }

        logger.info(`WebSocket is not open, current state: ${sock.ws.readyState}`);

        if (connection === 'open') {
            logger.info("Bot has been connected successfully")
            reconnectionAttempts = 0;
            sock.autoReconnecting = false;
        } else if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut ;
            logger.error(`Connection interrupted, status: ${lastDisconnect.error?.output?.statusCode}, flag: ${shouldReconnect}`)
            if (lastDisconnect?.error?.output?.statusCode === 428) {
                // Handle specific case where connection closure was due to a critical error
                logger.error('Critical error detected: Connection Closed. Bot will exit.');
                process.exit(1);
            }
            if (lastDisconnect?.reason === DisconnectReason.connectionClosed) {
                logger.error('Precondition required, can no longer reconnect, exiting peacefully.');
                process.exit(1); // Exit the process to let PM2 restart it
            }
            
            if (!sock.autoReconnecting && shouldReconnect) {
                reconnectionAttempts++;
                logger.info(`Reconnection attempt: ${reconnectionAttempts}`);
                if (reconnectionAttempts >= MAX_RECONNECTION_ATTEMPTS) {
                    logger.error('Maximum reconnection attempts reached, bot will exit.');
                    process.exit(1);
                } else {
                    sock.autoReconnecting = true;
                    logger.info("No reconnection attempts found, reconnecting now...")
                    startBot(); // Controlled reconnection
                }
            }
            else {
                logger.error('Unknown Error occured. Exiting peacefully');
                process.exit(1); // Exit the process to let PM2 restart it
            }
        }
    });

    if (sock) {
        sock.ev.on('connection.update', update => {
            if (update.connection === 'open') {
                logger.info('Connection is now open, monitoring for automatic operations...');
                setTimeout(() => {
                    // Log a status update after a delay, to see if automatic operations complete
                    logger.info('Checking status post connection open...');
                }, 60000); // Check 1 minute after opening
            }
        });
    }

    sock.ev.on('messages.upsert', async (m) => {
        delay(369);
        const message = m.messages[0];
        if (!message.message) return;

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

            if (text.startsWith('/ocr-list')) {
                await listOcrGroups(sock, sender);
                logger.info('Listing OCR enabled groups');
                logger.debug("Found:", ocrGroup);
                return;
            }

            if (text.startsWith('/ocr-register') && sock.groupList) {
                let oldGroups = loadAllowedGroups();
                await registerOcrGroups(sock, sender, text, sock.groupList);
                logger.info('Registering groups');
                logger.debug("Received:", text);
                logger.debug("Before:", oldGroups);
                logger.info("After", loadAllowedGroups());
                return;
            }

            if (text.startsWith('/ocr-deregister')) {
                if (groupisEmpty(registeredOcrList)) {
                    logger.info('No list set before calling deregister');
                    await sock.sendMessage(sender, { text: 'Please call the /ocr-list function before deregistering' });
                    return;
                }
                logger.info("Removing groups for OCR:");
                await deregisterOcrGroups(sock, sender, text);
                return;
            }

            if (text.startsWith('/deregister')) {
                if (groupisEmpty(registeredList)) {
                    logger.info('No list set before calling deregister');
                    await sock.sendMessage(sender, { text: 'Please call the /list-registered function before deregistering' });
                    return;
                }
                logger.info("Removing groups:");
                await deregisterGroups(sock, sender, text);
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

                if (!['text/csv', 'application/vnd.ms-excel'].includes(mimeType)) {
                    logger.warn('Received non-CSV file.');
                    isAwaitingCsv = false;
                    await sock.sendMessage(sender, { text: 'Invalid file type. Please send a CSV file.' });
                    return;
                }

                try {
                    const filePath = path.resolve(__dirname, 'reference.csv');

                    const stream = await downloadMediaMessage(message);
                    if (!stream) {
                        logger.error('Failed to download document.');
                        await sock.sendMessage(sender, { text: 'Failed to download the attached file. Please try again.' });
                        return;
                    }

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

                    fs.writeFileSync(filePath, buffer);
                    logger.info(`File saved at ${filePath}`);

                    referenceData = await loadReference(filePath);
                    fs.unlinkSync(filePath);

                    await sock.sendMessage(sender, { text: 'Reference data loaded successfully.' });
                } catch (error) {
                    logger.error('Error handling the CSV file:', error);
                    await sock.sendMessage(sender, { text: 'An error occurred while loading the reference data. Please try again.' });
                } finally {
                    isAwaitingCsv = false;
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

            if (message.message.imageMessage && ocrGroup.includes(sender)) {
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
            logger.info(`Ignored Message from ${sender}`);
        }
    });
}

startBot();
