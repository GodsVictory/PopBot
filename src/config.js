const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { app } = require('electron');

// Default configuration
const DEFAULT_CONFIG = {
    services: [
        {
            name: 'OpenAI',
            type: 'openai',
            api_key: '',
            model: 'gpt-3.5-turbo',
            base_url: 'https://api.openai.com/v1',
            enabled: true
        },
        {
            name: 'Anthropic',
            type: 'anthropic',
            api_key: '',
            model: 'claude-3-opus-20240229',
            base_url: 'https://api.anthropic.com/v1',
            enabled: true
        },
        {
            name: 'Local Model',
            type: 'ollama',
            base_url: 'http://localhost:11434',
            model: 'llama2',
            enabled: false
        }
    ],
    defaults: {
        service: 'OpenAI',
        temperature: 0.7,
        max_tokens: 1000,
        system_prompt: 'You are a helpful AI assistant. Use markdown to format your responses.'
    }
};

class ConfigManager {
    constructor() {
        // Use app.getPath('userData') to get the user's data directory
        this.configPath = path.join(app.getPath('userData'), 'config.yaml');
        this.config = null;
    }

    async loadConfig() {
        try {
            // Ensure the directory exists
            const configDir = path.dirname(this.configPath);
            if (!fs.existsSync(configDir)) {
                await fs.promises.mkdir(configDir, { recursive: true });
            }

            // Try to load existing config
            if (fs.existsSync(this.configPath)) {
                const yamlData = await fs.promises.readFile(this.configPath, 'utf8');
                this.config = yaml.load(yamlData);
            } else {
                // If config doesn't exist, create it with defaults
                this.config = DEFAULT_CONFIG;
                await this.saveConfig();
            }
            
            // Validate and ensure config structure
            this.config = this.validateAndFixConfig(this.config);
            await this.saveConfig();
            
            return this.config;
        } catch (error) {
            console.error('Error loading config:', error);
            this.config = DEFAULT_CONFIG;
            await this.saveConfig();
            return this.config;
        }
    }

    validateAndFixConfig(config) {
        if (!config) {
            return DEFAULT_CONFIG;
        }

        const validatedConfig = {
            services: Array.isArray(config.services) ? config.services : DEFAULT_CONFIG.services,
            defaults: config.defaults || DEFAULT_CONFIG.defaults
        };

        // Validate services
        validatedConfig.services = validatedConfig.services.map(service => ({
            ...DEFAULT_CONFIG.services.find(s => s.type === service.type) || {},
            ...service
        }));

        // Validate defaults
        validatedConfig.defaults = {
            ...DEFAULT_CONFIG.defaults,
            ...validatedConfig.defaults
        };

        return validatedConfig;
    }

    async saveConfig() {
        try {
            const yamlData = yaml.dump(this.config, {
                indent: 2,
                lineWidth: -1,
                noRefs: true,
                quotingType: '"'
            });
            await fs.promises.writeFile(this.configPath, yamlData, 'utf8');
            return true;
        } catch (error) {
            console.error('Error saving config:', error);
            return false;
        }
    }

    getConfig() {
        return this.config || DEFAULT_CONFIG;
    }

    async getActiveService() {
        const config = this.getConfig();
        
        // Try to get the default service
        if (config.defaults?.service) {
            const defaultService = config.services.find(s => 
                s.name === config.defaults.service && s.enabled
            );
            if (defaultService) {
                return defaultService;
            }
        }

        // Fall back to first enabled service
        const firstEnabled = config.services.find(s => s.enabled);
        if (firstEnabled) {
            return firstEnabled;
        }

        // Last resort: return first service
        return config.services[0];
    }
}

module.exports = new ConfigManager(); 