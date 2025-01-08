const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const inventoryPath = path.resolve(__dirname, 'storage/envelope_inventory.json');
const stampInventoryPath = path.resolve(__dirname, 'storage/stamp_inventory.json');
const stampConfigPath = path.resolve(__dirname, 'storage/envelope_stamp.json');
const pricesPath = path.resolve(__dirname, 'storage/prices.json');
const groupsFilePath = path.resolve(__dirname, 'settings/groups.json');
const authDir = './auth';
const logger = require('./logger');
const dataStorePath = './datastore.json';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ensure required files exist
if (!fs.existsSync(dataStorePath)) fs.writeFileSync(dataStorePath, JSON.stringify({}));
if (!fs.existsSync(groupsFilePath)) fs.writeFileSync(groupsFilePath, JSON.stringify([]));
if (!fs.existsSync(pricesPath)) fs.writeFileSync(pricesPath, JSON.stringify({}, null, 2));

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
    logger.debug("Add prices start");
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

function ocr(img) {
    //implement google vision
}

function closestRow(ocrResult){
    //implement string-similarity (leveshtein-distance)
    // return matched row as comma separated value
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
            logger.debug("Received:",text);
            logger.debug("Before:",oldGroups);
            logger.debug("After",loadAllowedGroups());
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
                logger.debug("Found:",loadAllowedGroups());
                return;
            }

            if (text.startsWith('/ocr-reference')) {
                // read th csv attached as reference
                return;
            }

            if (text.startsWith('/ocr-start')) {
                // when this is triggered keep listening for images, keeping the image's caption as well
                result = ocr(img)
                match = closestRow(result,reference)
                //write best result to result csv, with last column being the caption
                //for each message received, send the matched row in chat
                return;
            }

            if (text.startsWith('/ocr-end')) {
                // stop listening for image
                //return the result csv
                return;
            }

            if (text.startsWith('/add-prices')) {
                let oldPrices = listPrices();
                const response = addPrices(text);
                logger.info('Adding new Prices');
                logger.debug("Received:",text);
                await sock.sendMessage(sender, { text: response });
                logger.debug("Before:",oldPrices);
                logger.debug("After",listPrices());
                return;
            }
            
            if (text.startsWith('/prices')) {
                const response = listPrices();
                await sock.sendMessage(sender, { text: response });
                logger.info('Listing prices');
                logger.debug("Found:",response);
                return;
            }

            if (text.startsWith('/inventory')) {
                const inventoryNow = printInventory();
                const stampsNow = printStampInventory();
                await sock.sendMessage(sender, { text: `${inventoryNow}` });
                await sock.sendMessage(sender, { text: `${stampsNow}` });
                logger.info('Listing inventory');
                logger.debug("Envelope:",inventoryNow);
                logger.debug("Stamp:",stampsNow);
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
                logger.debug("Envelope:",response);
                logger.debug("Stamp:",stampResponse);
                return;
            }
    
            if (text.startsWith('/add-envelopes')) {
                const response = addEnvelopes(text);
                await sock.sendMessage(sender, { text: response });
                logger.info('Envelope Change');
                logger.debug("Envelope:",response);
                return;
            }
    
            if (text.startsWith('/add-stamps')) {
                const response = addStamps(text);
                await sock.sendMessage(sender, { text: response });
                logger.info('Stamp Change');
                logger.debug("Stamp:",stampResponse);
                return;
            }
        } else {
            console.log(`Message ignored from unregistered group: ${sender}`);
            logger.info(`Ignored Message from ${sender}`);
        }
    });
}

startBot();
