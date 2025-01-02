const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const inventoryPath = path.resolve(__dirname, 'storage/envelope_inventory.json');
const stampInventoryPath = path.resolve(__dirname, 'storage/stamp_inventory.json');
const stampConfigPath = path.resolve(__dirname, 'storage/envelope_stamp.json');

// Path for persistent auth state
const authDir = './auth';

// Datastore file for additional bot data
const dataStorePath = './datastore.json';

// Ensure datastore file exists
if (!fs.existsSync(dataStorePath)) {
    fs.writeFileSync(dataStorePath, JSON.stringify({}));
}

async function loadDatastore() {
    const data = fs.readFileSync(dataStorePath);
    return JSON.parse(data);
}

async function saveDatastore(datastore) {
    fs.writeFileSync(dataStorePath, JSON.stringify(datastore, null, 2));
}

function parseUsage(rawString) {
    const lines = rawString.split('\n').slice(1);
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
    // Load the inventory from file
    let inventory = {};
    if (fs.existsSync(inventoryPath)) {
        inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf-8'));
    }

    let response = '';

    // Normalize inventory keys to lowercase for case insensitivity
    const normalizedInventory = Object.keys(inventory).reduce((acc, key) => {
        acc[key.toLowerCase()] = inventory[key];
        return acc;
    }, {});

    const updatedInventory = { ...normalizedInventory }; // Clone the inventory for updates

    // Deduct quantities from inventory
    usageMap.forEach((quantity, itemCode) => {
        const normalizedKey = itemCode.toLowerCase(); // Normalize the item code

        if (updatedInventory[normalizedKey] !== undefined) {
            updatedInventory[normalizedKey] -= quantity;
            response += `${itemCode}: Updated balance to ${updatedInventory[normalizedKey]}\n`;
        } else {
            response += `Item ${itemCode} not found in inventory.\n`;
        }
    });

    // Reconstruct the inventory with original casing for saving
    const finalInventory = Object.keys(inventory).reduce((acc, key) => {
        acc[key] = updatedInventory[key.toLowerCase()] || 0; // Ensure the original case is preserved
        return acc;
    }, {});

    // Save the updated inventory back to file
    fs.writeFileSync(inventoryPath, JSON.stringify(finalInventory, null, 2));
    console.log('Inventory updated:', finalInventory);

    return response;
}

function printInventory() {
    let inventory = {};

    if (fs.existsSync(inventoryPath)) {
        inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf-8'));
    } else {
        return 'Inventory file not found.';
    }

    // Generate a formatted string of the inventory
    let response = 'Inventory:\n';
    Object.entries(inventory).forEach(([itemCode, quantity]) => {
        response += `${itemCode}: ${quantity}\n`;
    });

    return response;
}
function calculateStampUsage(usageMap) {
    // Load stamp configurations and inventory
    const stampConfigurations = JSON.parse(fs.readFileSync(stampConfigPath, 'utf-8'));
    let stampInventory = JSON.parse(fs.readFileSync(stampInventoryPath, 'utf-8'));

    let response = 'Stamp Usage Calculation:\n';

    // Normalize the stamp inventory to lowercase
    const normalizedStampInventory = Object.keys(stampInventory).reduce((acc, key) => {
        acc[key.toLowerCase()] = stampInventory[key];
        return acc;
    }, {});

    const updatedStampInventory = { ...normalizedStampInventory }; // Clone for updates

    // Normalize the stamp configurations to lowercase
    const normalizedStampConfigurations = Object.keys(stampConfigurations).reduce((acc, key) => {
        acc[key.toLowerCase()] = Object.entries(stampConfigurations[key]).reduce((innerAcc, [stampType, stampCount]) => {
            innerAcc[stampType.toLowerCase()] = stampCount;
            return innerAcc;
        }, {});
        return acc;
    }, {});

    // Loop through each envelope in the usage map
    usageMap.forEach((quantity, envelopeType) => {
        const normalizedEnvelopeType = envelopeType.toLowerCase();

        if (normalizedStampConfigurations[normalizedEnvelopeType]) {
            const requiredStamps = normalizedStampConfigurations[normalizedEnvelopeType];

            // Deduct the required stamps from the inventory
            Object.entries(requiredStamps).forEach(([stampType, stampCount]) => {
                const totalStampsNeeded = stampCount * quantity;

                if (updatedStampInventory[stampType] !== undefined) {
                    updatedStampInventory[stampType] -= totalStampsNeeded;
                    response += `${stampType}: ${totalStampsNeeded} used for ${envelopeType}\n`;
                } else {
                    response += `Stamp type ${stampType} not found in inventory.\n`;
                }
            });
        } else {
            response += `No stamp configuration found for ${envelopeType}.\n`;
        }
    });

    // Save the updated stamp inventory, preserving original case for keys
    const finalStampInventory = Object.keys(stampInventory).reduce((acc, key) => {
        acc[key] = updatedStampInventory[key.toLowerCase()] || 0;
        return acc;
    }, {});

    fs.writeFileSync(stampInventoryPath, JSON.stringify(finalStampInventory, null, 2));
    console.log('Stamp inventory updated:', finalStampInventory);

    return response;
}


function printStampInventory() {
    let stampInventory = {};

    if (fs.existsSync(stampInventoryPath)) {
        stampInventory = JSON.parse(fs.readFileSync(stampInventoryPath, 'utf-8'));
    } else {
        return 'Stamp inventory file not found.';
    }

    let response = 'Stamp Inventory Status:\n';
    Object.entries(stampInventory).forEach(([stampType, quantity]) => {
        response += `${stampType}: ${quantity}\n`;
    });

    return response;
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const datastore = await loadDatastore();

    const sock = makeWASocket({
        auth: state,
    });

    sock.ev.on('creds.update', saveCreds); // Save auth state on updates

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Scan the QR code below to log in:');
            qrcode.generate(qr, { small: true }); // Display QR code in terminal
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                startBot(); // Reconnect if not logged out
            }
        } else if (connection === 'open') {
            console.log('Bot is now connected!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];
        if (!message.message || message.key.fromMe) return; // Ignore bot's own messages

        console.log('Full message object:', JSON.stringify(message, null, 2));

        const sender = message.key.remoteJid;
        const text = message.message?.conversation || 
                     message.message?.extendedTextMessage?.text || 
                     message.message?.imageMessage?.caption || 
                     message.message?.videoMessage?.caption || 
                     message.message?.documentMessage?.caption || 
                     message.message?.buttonsResponseMessage?.selectedButtonId || 
                     message.message?.listResponseMessage?.title || 
                     "";

        if (!text) {
            console.log('Message has no text content.');
        } else {
            console.log(`Received message from ${sender}: ${text}`);

            if (text.startsWith('/estimated-usage')) {
                usage = parseUsage(text)
                response = computeUsage(usage)
                inventoryNow = printInventory()
                stampResponse = calculateStampUsage(usage)
                stampsNow = printStampInventory()
                try {
                    await sock.sendMessage(sender, { text: `Inventory Changes:\n${response}` });
                    await sock.sendMessage(sender, { text: `${inventoryNow}` });

                    await sock.sendMessage(sender, { text: `Stamp Changes:\n${stampResponse}` });
                    await sock.sendMessage(sender, { text: `${stampsNow}` });
                    console.log(`Computing estimate from command by ${sender} "`);

                } catch (error) {
                    console.error(`Failed to send message to ${sender}:`, error);
                }
            }

            // Store the message in the datastore
            if (!datastore[sender]) {
                datastore[sender] = [];
            }
            datastore[sender].push({ text, timestamp: Date.now() });
            await saveDatastore(datastore);
        }
    });
}

startBot();
