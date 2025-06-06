const axios = require('axios');
const configManager = require('./config');
const { EventEmitter } = require('events');

// API endpoints and versions
const API_ENDPOINTS = {
    openai: '/chat/completions',
    anthropic: '/messages',
    ollama: '/api/generate'
};

const API_VERSIONS = {
    anthropic: '2023-06-01'
};

class AIService extends EventEmitter {
    constructor() {
        super();
        this.config = null;
        this.conversationHistory = new Map(); // Map to store conversation history for each window
        this.currentRequest = null; // Store current request for cancellation
    }

    async ensureConfig() {
        if (!this.config) {
            await configManager.loadConfig();
            this.config = configManager.getConfig();
        }
        return this.config;
    }

    async sendMessage(message, windowId) {
        if (!message?.trim()) {
            throw new Error('Message cannot be empty');
        }

        await this.ensureConfig();
        const service = await configManager.getActiveService();
        if (!service) {
            throw new Error('No active AI service configured');
        }

        console.log(`[AI Service] Using service: ${service.name} (${service.type})`);
        console.log(`[AI Service] User message: ${message}`);

        // Get or initialize conversation history for this window
        if (!this.conversationHistory.has(windowId)) {
            this.conversationHistory.set(windowId, []);
        }
        const history = this.conversationHistory.get(windowId);

        // Add user message to history
        history.push({ role: 'user', content: message });

        const serviceHandlers = {
            openai: this.sendToOpenAI.bind(this),
            anthropic: this.sendToAnthropic.bind(this),
            ollama: this.sendToLocal.bind(this)
        };

        const handler = serviceHandlers[service.type];
        if (!handler) {
            throw new Error(`Unsupported service type: ${service.type}`);
        }

        const response = await handler(message, service, history, windowId);
        
        // Add assistant response to history
        history.push({ role: 'assistant', content: response });
        
        return response;
    }

    clearConversationHistory(windowId) {
        this.conversationHistory.delete(windowId);
    }

    async sendToOpenAI(message, service, history, windowId) {
        try {
            console.log('[OpenAI] Sending request...');
            const config = await this.ensureConfig();
            const requestBody = {
                model: service.model,
                messages: [
                    { role: 'system', content: config.defaults.system_prompt },
                    ...history
                ],
                temperature: config.defaults.temperature,
                max_tokens: config.defaults.max_tokens
            };

            const response = await this.makeRequest(
                service.base_url + API_ENDPOINTS.openai,
                requestBody,
                {
                    'Authorization': `Bearer ${service.api_key}`,
                    'Content-Type': 'application/json'
                }
            );

            return response.choices[0].message.content;
        } catch (error) {
            console.error('[OpenAI] API error:', error.response?.data || error.message);
            throw new Error('Failed to get response from OpenAI');
        }
    }

    async sendToAnthropic(message, service, history, windowId) {
        try {
            console.log('[Anthropic] Sending request...');
            const config = await this.ensureConfig();
            const requestBody = {
                model: service.model,
                messages: history,
                temperature: config.defaults.temperature,
                max_tokens: config.defaults.max_tokens,
                system: config.defaults.system_prompt,
                stream: true
            };

            // Create new AbortController for this request
            const controller = new AbortController();
            this.currentRequest = controller;

            const response = await axios.post(
                service.base_url + API_ENDPOINTS.anthropic,
                requestBody,
                {
                    headers: {
                        'x-api-key': service.api_key,
                        'anthropic-version': API_VERSIONS.anthropic,
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream'
                    },
                    responseType: 'stream',
                    signal: controller.signal
                }
            );

            return await this.processStreamResponse(response, 'sse');
        } catch (error) {
            if (error.name === 'CanceledError') {
                this.emit('cancelled');
                return null; // Return null instead of throwing for cancellations
            }
            console.error('[Anthropic] API error:', error.response?.data || error.message);
            throw new Error('Failed to get response from Anthropic');
        }
    }

    async makeRequest(url, data, headers = {}) {
        try {
            // Create new AbortController for this request
            const controller = new AbortController();
            this.currentRequest = controller;

            const response = await axios.post(url, data, { 
                headers,
                signal: controller.signal 
            });
            return response.data;
        } catch (error) {
            if (error.name === 'CanceledError') {
                this.emit('cancelled');
                return null; // Return null instead of throwing for cancellations
            }
            if (error.response) {
                throw new Error(`API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
            }
            throw error;
        }
    }

    async processStreamResponse(response, format = 'json') {
        let fullResponse = '';
        let currentChunk = '';

        return new Promise((resolve, reject) => {
            response.data.on('data', (chunk) => {
                try {
                    const lines = chunk.toString().split('\n').filter(line => line.trim());
                    for (const line of lines) {
                        if (format === 'sse') {
                            // Handle SSE format
                            if (line.startsWith('data: ')) {
                                const jsonStr = line.slice(6); // Remove 'data: ' prefix
                                if (jsonStr === '[DONE]') {
                                    resolve(fullResponse);
                                    return;
                                }
                                try {
                                    const data = JSON.parse(jsonStr);
                                    if (data.delta?.text) {
                                        currentChunk += data.delta.text;
                                        fullResponse += data.delta.text;
                                        this.emit('stream', {
                                            chunk: data.delta.text,
                                            full: fullResponse,
                                            done: false
                                        });
                                    }
                                } catch (e) {
                                    // Skip non-JSON lines in SSE format
                                    continue;
                                }
                            }
                        } else {
                            // Handle JSON format (for Ollama)
                            const data = JSON.parse(line);
                            if (data.response) {
                                currentChunk += data.response;
                                fullResponse += data.response;
                                this.emit('stream', {
                                    chunk: data.response,
                                    full: fullResponse,
                                    done: data.done
                                });
                            }
                            if (data.done) {
                                resolve(fullResponse);
                            }
                        }
                    }
                } catch (error) {
                    // Don't log or reject on cancellation
                    if (error.name !== 'CanceledError') {
                        console.error('[Stream] Error parsing stream:', error);
                        reject(error);
                    }
                }
            });

            response.data.on('error', (error) => {
                // Don't log or reject on cancellation
                if (error.name !== 'CanceledError') {
                    console.error('[Stream] Stream error:', error);
                    reject(error);
                }
            });

            response.data.on('end', () => {
                if (!fullResponse) {
                    reject(new Error('No response received from stream'));
                } else if (format === 'sse') {
                    // For SSE, resolve on end if we haven't already
                    resolve(fullResponse);
                }
            });
        });
    }

    async sendToLocal(message, service, history, windowId) {
        try {
            console.log('[Local] Sending request...');
            const config = await this.ensureConfig();
            
            // For local models, we'll format the conversation history as a single prompt
            const formattedHistory = history.map(msg => 
                `${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.content}`
            ).join('\n\n');
            
            const requestBody = {
                model: service.model,
                prompt: formattedHistory,
                temperature: config.defaults.temperature,
                max_tokens: config.defaults.max_tokens,
                stream: true
            };

            // Create new AbortController for this request
            const controller = new AbortController();
            this.currentRequest = controller;

            const response = await axios.post(
                service.base_url + API_ENDPOINTS.ollama,
                requestBody,
                {
                    responseType: 'stream',
                    signal: controller.signal
                }
            );

            return await this.processStreamResponse(response);
        } catch (error) {
            if (error.name === 'CanceledError') {
                this.emit('cancelled');
                return null; // Return null instead of throwing for cancellations
            }
            console.error('[Local] API error:', error.response?.data || error.message);
            throw new Error('Failed to get response from local model');
        }
    }

    cancelCurrentRequest() {
        if (this.currentRequest) {
            this.currentRequest.abort();
            this.currentRequest = null;
            this.emit('cancelled');
        }
    }
}

module.exports = new AIService(); 