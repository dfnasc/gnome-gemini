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
     * Sleep helper compatible with Gio.Cancellable.
     *
     * @param {number} ms
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<void>}
     */
    _sleep(ms, cancellable) {
        return new Promise((resolve, reject) => {
            if (cancellable && cancellable.is_cancelled()) {
                reject(new Error('Requisição cancelada pelo usuário.'));
                return;
            }

            let cancelId = 0;
            const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                if (cancelId && cancellable) {
                    cancellable.disconnect(cancelId);
                }
                resolve();
                return GLib.SOURCE_REMOVE;
            });

            if (cancellable) {
                cancelId = cancellable.connect(() => {
                    GLib.source_remove(sourceId);
                    reject(new Error('Requisição cancelada pelo usuário.'));
                });
            }
        });
    }

    /**
     * Perform a single HTTP request to the Gemini API.
     */
    _executeRequest({ apiKey, model, contents, systemInstruction, temperature }, cancellable) {
        const effectiveModel = (model && model.trim() !== '') ? model.trim() : 'gemini-3.8-flash';
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
            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (_session, result) => {
                    try {
                        const responseBytes = this._session.send_and_read_finish(result);
                        const decoder = new TextDecoder('utf-8');
                        const responseText = decoder.decode(responseBytes.toArray());

                        const statusCode = message.status_code;

                        let json = null;
                        try {
                            json = JSON.parse(responseText);
                        } catch {
                            // Non-JSON response (e.g. HTML 503 / 502 / 504 from gateway)
                            if (statusCode === 503) {
                                const err = new Error(`O servidor do Gemini está temporariamente sobrecarregado (Erro 503). Tente novamente em instantes ou selecione outro modelo nas preferências.`);
                                err.statusCode = 503;
                                err.isTransient = true;
                                reject(err);
                                return;
                            }
                            if (statusCode >= 400) {
                                const err = new Error(`Erro do servidor (HTTP ${statusCode}): ${responseText.slice(0, 200)}`);
                                err.statusCode = statusCode;
                                err.isTransient = (statusCode === 500 || statusCode === 502 || statusCode === 504);
                                reject(err);
                                return;
                            }
                        }

                        if (json && json.error) {
                            const code = json.error.code || statusCode;
                            const msg = json.error.message || 'Erro desconhecido retornado pela API.';
                            let friendlyError;

                            if (code === 400 && msg.toLowerCase().includes('api key')) {
                                friendlyError = new Error('Chave de API inválida. Verifique sua chave nas configurações.');
                            } else if (code === 404) {
                                friendlyError = new Error(`Modelo "${effectiveModel}" não encontrado ou indisponível (Erro 404). Selecione outro modelo nas preferências.`);
                            } else if (code === 429) {
                                friendlyError = new Error('Limite de taxa excedido (Erro 429 - Rate Limit). Tente novamente em alguns segundos.');
                                friendlyError.isTransient = true;
                            } else if (code === 503 || msg.toLowerCase().includes('overloaded')) {
                                friendlyError = new Error(`O modelo "${effectiveModel}" está temporariamente sobrecarregado (Erro 503 - Service Unavailable). Tente novamente em instantes ou selecione outro modelo nas preferências.`);
                                friendlyError.isTransient = true;
                            } else if (code >= 500) {
                                friendlyError = new Error(`Instabilidade temporária nos servidores da Google (Erro ${code}): ${msg}`);
                                friendlyError.isTransient = true;
                            } else {
                                friendlyError = new Error(`Erro da API Gemini (${code}): ${msg}`);
                            }

                            friendlyError.statusCode = code;
                            reject(friendlyError);
                            return;
                        }

                        if (statusCode >= 400) {
                            let friendlyError;
                            if (statusCode === 503) {
                                friendlyError = new Error(`O modelo "${effectiveModel}" está temporariamente sobrecarregado (Erro 503). Tente novamente em instantes ou selecione outro modelo nas preferências.`);
                                friendlyError.isTransient = true;
                            } else {
                                friendlyError = new Error(`Erro HTTP ${statusCode} retornado pela API Gemini.`);
                            }
                            friendlyError.statusCode = statusCode;
                            reject(friendlyError);
                            return;
                        }

                        const candidate = json?.candidates?.[0];
                        if (!candidate) {
                            if (json?.promptFeedback?.blockReason) {
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

                        resolve({ text: text, usageMetadata: json.usageMetadata || null });
                    } catch (e) {
                        if (cancellable.is_cancelled()) {
                            reject(new Error('Requisição cancelada pelo usuário.'));
                        } else {
                            reject(new Error(`Falha na requisição: ${e.message || e}`));
                        }
                    }
                }
            );
        });
    }

    /**
     * Send a generation request to the Gemini API with automatic retry on transient errors.
     *
     * @param {Object} options
     * @param {string} options.apiKey
     * @param {string} options.model
     * @param {Array<Object>} options.contents Array of { role: 'user' | 'model', parts: [{ text: string }] }
     * @param {string} [options.systemInstruction]
     * @param {number} [options.temperature]
     * @returns {Promise<string>} Model response text
     */
    async generateContent(options) {
        const { apiKey } = options;
        if (!apiKey || apiKey.trim() === '') {
            throw new Error('A chave da API do Gemini não está configurada.\nAbra as Preferências da extensão e insira sua chave da API.');
        }

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        const maxRetries = 2; // up to 2 retries (total 3 attempts)
        let attempt = 0;

        try {
            while (true) {
                try {
                    return await this._executeRequest(options, cancellable);
                } catch (err) {
                    if (cancellable.is_cancelled()) {
                        throw err;
                    }

                    const isTransient = err.isTransient ||
                        err.statusCode === 503 ||
                        err.statusCode === 429 ||
                        err.statusCode === 500 ||
                        err.statusCode === 502 ||
                        err.statusCode === 504 ||
                        (err.message && (err.message.includes('503') || err.message.includes('sobrecarregado') || err.message.includes('overloaded')));

                    if (isTransient && attempt < maxRetries) {
                        attempt++;
                        const delayMs = attempt * 1500;
                        await this._sleep(delayMs, cancellable);
                        continue;
                    }

                    throw err;
                }
            }
        } finally {
            if (this._cancellable === cancellable) {
                this._cancellable = null;
            }
        }
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
