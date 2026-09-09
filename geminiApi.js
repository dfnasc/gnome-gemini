/**
 * geminiApi.js
 *
 * Client for the Google Gemini Generative Language REST API.
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export class GeminiApiClient {
    constructor() {
        this._session = new Soup.Session();
        this._session.timeout = 60; // 60 seconds timeout
        this._cancellable = null;
    }

    /**
     * Send a generation request to the Gemini API.
     *
     * @param {Object} options
     * @param {string} options.apiKey
     * @param {string} options.model
     * @param {Array<Object>} options.contents Array of { role: 'user' | 'model', parts: [{ text: string }] }
     * @param {string} [options.systemInstruction]
     * @param {number} [options.temperature]
     * @returns {Promise<string>} Model response text
     */
    async generateContent({ apiKey, model, contents, systemInstruction, temperature }) {
        if (!apiKey || apiKey.trim() === '') {
            throw new Error('A chave da API do Gemini não está configurada.\nAbra as Preferências da extensão e insira sua chave da API.');
        }

        const effectiveModel = (model && model.trim() !== '') ? model.trim() : 'gemini-2.5-flash';
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(effectiveModel)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

        const payload = {
            contents: contents,
        };

        if (systemInstruction && systemInstruction.trim() !== '') {
            payload.systemInstruction = {
                parts: [{ text: systemInstruction.trim() }],
            };
        }

        if (typeof temperature === 'number') {
            payload.generationConfig = {
                temperature: Math.max(0.0, Math.min(2.0, temperature)),
            };
        }

        const requestBody = JSON.stringify(payload);
        const requestBytes = new GLib.Bytes(new TextEncoder().encode(requestBody));

        const message = Soup.Message.new('POST', endpoint);
        message.set_request_body_from_bytes('application/json', requestBytes);

        return new Promise((resolve, reject) => {
            const cancellable = new Gio.Cancellable();
            this._cancellable = cancellable;

            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (_session, result) => {
                    try {
                        const responseBytes = this._session.send_and_read_finish(result);
                        const decoder = new TextDecoder('utf-8');
                        const responseText = decoder.decode(responseBytes.toArray());

                        let json;
                        try {
                            json = JSON.parse(responseText);
                        } catch (parseError) {
                            reject(new Error(`Resposta inválida do servidor (HTTP ${message.status_code}): ${responseText}`));
                            return;
                        }

                        if (json.error) {
                            const code = json.error.code || message.status_code;
                            const msg = json.error.message || 'Erro desconhecido retornado pela API.';
                            if (code === 400 && msg.toLowerCase().includes('api key')) {
                                reject(new Error('Chave de API inválida. Verifique sua chave nas configurações.'));
                            } else if (code === 429) {
                                reject(new Error('Limite de taxa excedido (Rate Limit). Tente novamente em alguns segundos.'));
                            } else {
                                reject(new Error(`Erro da API Gemini (${code}): ${msg}`));
                            }
                            return;
                        }

                        const candidate = json.candidates?.[0];
                        if (!candidate) {
                            if (json.promptFeedback?.blockReason) {
                                reject(new Error(`Resposta bloqueada pela política de segurança: ${json.promptFeedback.blockReason}`));
                            } else {
                                reject(new Error('Nenhuma resposta gerada pelo modelo.'));
                            }
                            return;
                        }

                        const parts = candidate.content?.parts || [];
                        const text = parts.map(p => p.text || '').join('');

                        if (!text && candidate.finishReason) {
                            reject(new Error(`Geração finalizada sem texto (${candidate.finishReason}).`));
                            return;
                        }

                        resolve(text);
                    } catch (e) {
                        if (cancellable.is_cancelled()) {
                            reject(new Error('Requisição cancelada pelo usuário.'));
                        } else {
                            reject(new Error(`Falha na requisição: ${e.message || e}`));
                        }
                    } finally {
                        if (this._cancellable === cancellable) {
                            this._cancellable = null;
                        }
                    }
                }
            );
        });
    }

    /**
     * Cancel an ongoing request if any.
     */
    cancelCurrentRequest() {
        if (this._cancellable && !this._cancellable.is_cancelled()) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }
}
