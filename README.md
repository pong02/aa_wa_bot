# AA WhatsApp Bot
## _Quick walkthrough_
1. This bot is an all in one helper to smoothen the flow of our daily operations.
2. We plan to use it to completely remove the need for human effort in menial tasks.
3. The bot's functions will be explored below

#### Set Up
To set up on your device
1. Install Node.js
    - Go to Node.js official website and download the LTS (Long-Term Support) version for your operating system.
    - Run the installer and follow the instructions.
    - Ensure the checkbox for adding Node.js to your system's PATH is selected.
2. Extract ZIP of the bot into directory of choice
    - `cd` into the directory extracted into, then cd into the aa-wa-bot directory
    - `npm install` to install all dependencies
    - `node bot.js` to start the bot once dependencies are completely installed

#### Registering WhatsApp account
A valid account must be used to register the bot, and please make sure you have at least 1 linked device slot available for the bot to occupy.
1. The bot will have to all access to your chats as it has to listen to keywords
2. The terminal should have a QR inside on the first ever set up, scan it and it will be using your account to reply
3. The session used by the bot is HEADLESS, meaning it will not interfere with any other sessions on your PC, you can continue using your app/web versions with other accounts
4. The session will be shown as Ubuntu on the linked devices page of your WhatsApp
5. DO NOT remove the linked session or you will have to redo the registration again
6. To redo the registration (QR scan), you need to delete all contents of the auth folder, then restart the bot so that it gets a new valid session

#### Data storage
All data that you can edit will be stored in the storage folder. It is a simple JSON file so you can edit it whenever, just try not to edit while the bot is trying to edit, it might cause issues.
- `envelope_inventory.json` holds all the envelope counts
- `envelope_stamp.json` holds all the configurations of stamps needed by different envelopes
- `stamp_inventory.json` holds all the stamp counts

####  Configurations available
There are some configurable aspects of this bot, all found in the settings directory. The groups that are whitelisted will have their IDs stored in `groups.json` whereas the ocr related configuration will be in the `ocr-config.json`.

#### wiki page
https://pong02.github.io/bot-help/