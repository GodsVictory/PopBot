const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu } = require('electron');
const path = require('path');
const configManager = require('./config');
const aiService = require('./ai-service');

// Constants
const SHORTCUT_KEY = 'CommandOrControl+Shift+Space';
const CHAT_WINDOW_CONFIG = {
    width: 400,
    height: 600,
    frame: false,
    transparent: false,
    webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
    }
};
const SETTINGS_WINDOW_CONFIG = {
    width: 800,
    height: 600,
    frame: false,
    transparent: false,
    webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
    }
};

// State management
let chatWindow = null;
let settingsWindow = null;
let isConfigReady = false;
let configReadyPromise = null;
let tray = null;

async function ensureConfigReady() {
    if (!isConfigReady) {
        if (!configReadyPromise) {
            configReadyPromise = configManager.loadConfig();
        }
        await configReadyPromise;
        isConfigReady = true;
    }
}

async function createChatWindow() {
    chatWindow = new BrowserWindow(CHAT_WINDOW_CONFIG);
    await chatWindow.loadFile('src/index.html');
    chatWindow.hide();
}

function positionWindowNearCursor(window) {
    const cursorPosition = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPosition);
    const { width, height } = window.getBounds();

    // Calculate position to center the window near the cursor
    let x = cursorPosition.x - (width / 2);
    let y = cursorPosition.y - (height / 2);

    // Ensure window stays within screen bounds
    const bounds = display.workArea;
    x = Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - width));
    y = Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - height));

    // Ensure coordinates are integers
    x = Math.round(x);
    y = Math.round(y);

    window.setPosition(x, y);
}

async function createSettingsWindow() {
    if (settingsWindow) {
        settingsWindow.focus();
        return;
    }

    settingsWindow = new BrowserWindow({
        ...SETTINGS_WINDOW_CONFIG,
        parent: chatWindow,
        modal: true
    });

    await settingsWindow.loadFile('src/settings.html');

    settingsWindow.on('closed', () => {
        settingsWindow = null;
    });
}

function createTray() {
    // Create tray icon
    tray = new Tray(path.join(__dirname, 'assets', 'icon.png'));
    
    // Create context menu
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show Chat',
            click: () => {
                showChatWindow()
            }
        },
        {
            label: 'Settings',
            click: () => createSettingsWindow()
        },
        { type: 'separator' },
        {
            label: 'Quit',
            accelerator: 'CmdOrCtrl+Q',
            click: () => {
                app.isQuitting = true;
                app.quit();
            }
        }
    ]);

    // Set tooltip and context menu
    tray.setToolTip('PopBot');
    tray.setContextMenu(contextMenu);

    // Handle tray icon click
    tray.on('click', () => {
        if (chatWindow.isVisible()) {
            clearChat();
        } else {
            showChatWindow()
        }
    });

    // Clean up tray on app quit
    app.on('before-quit', () => {
        if (tray) {
            tray.destroy();
        }
    });
}

// IPC Handlers
function setupIpcHandlers() {
    ipcMain.handle('get-config', async () => {
        return configManager.getConfig();
    });

    ipcMain.handle('update-service-setting', async (event, serviceName, setting, value) => {
        try {
            const config = await configManager.getConfig();
            if (!config?.services) {
                throw new Error('Invalid config structure');
            }
            const service = config.services.find(s => s.name === serviceName);
            if (!service) {
                throw new Error(`Service not found: ${serviceName}`);
            }
            service[setting] = value;
            await configManager.saveConfig();
            return true;
        } catch (error) {
            console.error('Error updating service setting:', error);
            return false;
        }
    });

    ipcMain.handle('update-default-service', async (event, serviceName) => {
        try {
            const config = await configManager.getConfig();
            if (!config?.defaults) {
                throw new Error('Invalid config structure');
            }
            config.defaults.service = serviceName;
            await configManager.saveConfig();
            return true;
        } catch (error) {
            console.error('Error updating default service:', error);
            return false;
        }
    });

    ipcMain.handle('update-default-setting', async (event, setting, value) => {
        try {
            const config = await configManager.getConfig();
            if (!config?.defaults) {
                throw new Error('Invalid config structure');
            }
            config.defaults[setting] = value;
            await configManager.saveConfig();
            return true;
        } catch (error) {
            console.error('Error updating default setting:', error);
            return false;
        }
    });

    ipcMain.handle('add-service', async (event, serviceName) => {
        try {
            const config = await configManager.getConfig();
            if (!config?.services) {
                throw new Error('Invalid config structure');
            }
            
            // Check if service with same name already exists
            if (config.services.some(s => s.name === serviceName)) {
                throw new Error(`Service with name "${serviceName}" already exists`);
            }

            // Add new service with default values
            config.services.push({
                name: serviceName,
                api_key: '',
                model: '',
                base_url: '',
                enabled: true
            });

            await configManager.saveConfig();
            return true;
        } catch (error) {
            console.error('Error adding service:', error);
            throw error;
        }
    });

    ipcMain.handle('delete-service', async (event, serviceName) => {
        try {
            const config = await configManager.getConfig();
            if (!config?.services) {
                throw new Error('Invalid config structure');
            }

            // Check if service exists
            const serviceIndex = config.services.findIndex(s => s.name === serviceName);
            if (serviceIndex === -1) {
                throw new Error(`Service "${serviceName}" not found`);
            }

            // Check if it's the default service
            if (config.defaults?.service === serviceName) {
                throw new Error('Cannot delete the default service. Please set a different default service first.');
            }

            // Remove the service
            config.services.splice(serviceIndex, 1);
            await configManager.saveConfig();
            return true;
        } catch (error) {
            console.error('Error deleting service:', error);
            throw error;
        }
    });

    ipcMain.handle('send-message', async (event, message) => {
        try {
            const windowId = event.sender.id;
            const response = await aiService.sendMessage(message, windowId);
            return { success: true, response };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('cancel-request', async () => {
        try {
            aiService.cancelCurrentRequest();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.on('show-settings', createSettingsWindow);
    ipcMain.on('settings-closed', () => settingsWindow?.close());
    ipcMain.on('hide-window', () => clearChat());
}

function clearChat() {
    if (chatWindow) {
        const windowId = chatWindow.webContents.id;
        aiService.clearConversationHistory(windowId);
        chatWindow.webContents.send('window-hidden');
        chatWindow.hide();
    }
}

function showChatWindow() {
    if (chatWindow) {
        positionWindowNearCursor(chatWindow);
        chatWindow.show();
        chatWindow.focus();
        chatWindow.webContents.send('window-shown');
    }
}

// App initialization
async function initializeApp() {
    try {
        console.log('Loading configuration...');
        await configManager.loadConfig();
        console.log('Configuration loaded successfully');

        await createChatWindow();
        await ensureConfigReady();
        setupIpcHandlers();
        createTray();

        // Register global shortcut
        globalShortcut.register(SHORTCUT_KEY, () => {
            if (chatWindow.isVisible()) {
                clearChat();
            } else {
                showChatWindow()
            }
        });

        // Handle window close
        chatWindow.on('close', (event) => {
            if (!app.isQuitting) {
                event.preventDefault();
                clearChat();
            }
        });

        app.on('before-quit', () => {
            app.isQuitting = true;
        });

        // Handle streaming responses
        aiService.on('stream', (data) => {
            if (chatWindow && !chatWindow.isDestroyed()) {
                chatWindow.webContents.send('stream-chunk', data);
            }
        });

        console.log('App initialized successfully');
    } catch (error) {
        console.error('Error during app initialization:', error);
        app.quit();
    }
}

// App lifecycle events
app.whenReady().then(initializeApp);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createChatWindow();
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
}); 