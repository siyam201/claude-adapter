// Proxy server request handlers
import { FastifyRequest, FastifyReply } from 'fastify';
import OpenAI from 'openai';
import { AnthropicMessageRequest } from '../types/anthropic';
import { AdapterConfig } from '../types/config';
import { convertRequestToOpenAI } from '../converters/request';
import { isAzureOpenAIEndpoint } from '../utils/provider';
import { convertResponseToAnthropic, createErrorResponse } from '../converters/response';
import { streamOpenAIToAnthropic } from '../converters/streaming';
import { streamXmlOpenAIToAnthropic } from '../converters/xmlStreaming';
import { validateAnthropicRequest, formatValidationErrors } from '../utils/validation';
import { logger, RequestLogger } from '../utils/logger';
import { recordUsage } from '../utils/tokenUsage';
import { recordError } from '../utils/errorLog';


// ─── API Pool with RPM tracking ───────────────────────────────────────────────

const RPM_LIMIT = 38;
const RPM_WINDOW_MS = 60_000;

interface ApiKeyEntry {
    key: string;
    label: string;
    requestTimestamps: number[];
    disabled: boolean;
}

// FIX 1: Keys should come from environment variables, not be hardcoded.
// Set NVAPI_KEYS as a comma-separated list in your environment.
const rawKeys = (process.env.NVAPI_KEYS ?? '').split(',').map(k => k.trim()).filter(Boolean);
if (rawKeys.length === 0) {
    throw new Error('No API keys configured. Set the NVAPI_KEYS environment variable.');
}

const apiPool: ApiKeyEntry[] = rawKeys.map((key, i) => ({
    key,
    label: `API-${i + 1}`,
    requestTimestamps: [],
    disabled: false,
}));

function isUnderLimit(entry: ApiKeyEntry): boolean {
    const now = Date.now();
    entry.requestTimestamps = entry.requestTimestamps.filter(
        (ts) => now - ts < RPM_WINDOW_MS
    );
    return entry.requestTimestamps.length < RPM_LIMIT;
}

let poolIndex = 0;

function getNextApiKey(): { key: string; entry: ApiKeyEntry } {
    const total = apiPool.length;
    for (let i = 0; i < total; i++) {
        const entry = apiPool[poolIndex % total];
        poolIndex++;
        if (!entry.disabled && isUnderLimit(entry)) {
            entry.requestTimestamps.push(Date.now());
            return { key: entry.key, entry };
        }
    }
    throw new Error(
        `All ${total} API keys have hit the ${RPM_LIMIT} RPM limit. Try again in a moment.`
    );
}

// ─── Request ID ───────────────────────────────────────────────────────────────

let requestIdCounter = 0;

function generateRequestId(): string {
    requestIdCounter++;
    const timestamp = Date.now().toString(36);
    // FIX 2: Removed trailing space that was present in the original file 1.
    const counter = requestIdCounter.toString(36).padStart(4, '0');
    return `req_${timestamp}_${counter}`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export function createMessagesHandler(config: AdapterConfig) {
    const isAzure = isAzureOpenAIEndpoint(config.baseUrl);

    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const requestId = generateRequestId();
        const log = logger.withRequestId(requestId);

        reply.header('X-Request-Id', requestId);

        // FIX 3: Validate BEFORE picking a key — don't burn RPM on bad requests.
        const validation = validateAnthropicRequest(request.body);
        if (!validation.valid) {
            const errorMessage = formatValidationErrors(validation.errors);
            log.warn('Invalid request', { errors: validation.errors });
            const errorResponse = createErrorResponse(new Error(errorMessage), 400);
            reply.code(400).send({ error: errorResponse.error });
            return;
        }

        // FIX 4: Capture the entry in a block-scoped const so the setTimeout
        // closure always closes over the correct key, even if poolIndex shifts.
        let pickedEntry: ApiKeyEntry;
        try {
            const { key, entry } = getNextApiKey();
            pickedEntry = entry;
        } catch (poolError) {
            handleError(poolError as Error, reply, log, {
                requestId,
                provider: config.baseUrl,
                modelName: (request.body as any)?.model ?? 'unknown',
                streaming: (request.body as any)?.stream ?? false,
            });
            return;
        }

        log.info(`Using ${pickedEntry.label} (${pickedEntry.requestTimestamps.length}/${RPM_LIMIT} RPM)`);

        const openai = new OpenAI({
            baseURL: config.baseUrl,
            apiKey: pickedEntry.key,
        });

        try {
            const anthropicRequest = request.body as AnthropicMessageRequest;
            const targetModel = anthropicRequest.model;
            const isStreaming = anthropicRequest.stream ?? false;

            log.info(`→ ${targetModel} [sent]`);

            const toolStyle = config.toolFormat || 'native';
            const openaiRequest = convertRequestToOpenAI(anthropicRequest, targetModel, toolStyle, isAzure);

            if (toolStyle === 'xml' && anthropicRequest.tools?.length) {
                log.info(`Using XML tool calling mode (${anthropicRequest.tools.length} tools)`);
            }

            if (isStreaming) {
                if (toolStyle === 'xml') {
                    await handleXmlStreamingRequest(openai, openaiRequest, reply, targetModel, config.baseUrl, log);
                } else {
                    await handleStreamingRequest(openai, openaiRequest, reply, targetModel, config.baseUrl, log);
                }
            } else {
                await handleNonStreamingRequest(openai, openaiRequest, reply, targetModel, config.baseUrl, log);
            }

            log.info(`← ${targetModel} [received]`);
        } catch (error) {
            const body = request.body as any;

            // FIX 5: Capture entry in a local const for the closure — avoids
            // a stale-variable race if multiple requests finish simultaneously.
            if ((error as any)?.status === 429) {
                const disabledEntry = pickedEntry;
                log.warn(`${disabledEntry.label} hit 429 — temporarily disabling for 60s`);
                disabledEntry.disabled = true;
                setTimeout(() => {
                    disabledEntry.disabled = false;
                    disabledEntry.requestTimestamps = [];
                    log.info(`${disabledEntry.label} re-enabled`);
                }, RPM_WINDOW_MS);
            }

            handleError(error as Error, reply, log, {
                requestId,
                provider: config.baseUrl,
                modelName: body?.model ?? 'unknown',
                streaming: body?.stream ?? false,
            });
        }
    };
}

// ─── Sub-handlers (unchanged) ─────────────────────────────────────────────────

async function handleNonStreamingRequest(
    openai: OpenAI, openaiRequest: any, reply: FastifyReply,
    originalModel: string, provider: string, log: RequestLogger
): Promise<void> {
    log.debug('Making non-streaming request');
    const response = await openai.chat.completions.create({ ...openaiRequest, stream: false });
    log.debug('Response received', { finishReason: response.choices[0]?.finish_reason, usage: response.usage });

    if (response.usage) {
        recordUsage({
            provider, modelName: originalModel, model: response.model,
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens,
            streaming: false,
        });
    }

    const anthropicResponse = convertResponseToAnthropic(response as any, originalModel);
    reply.send(anthropicResponse);
}

async function handleStreamingRequest(
    openai: OpenAI, openaiRequest: any, reply: FastifyReply,
    originalModel: string, provider: string, log: RequestLogger
): Promise<void> {
    log.debug('Making streaming request');
    const stream = await openai.chat.completions.create({
        ...openaiRequest, stream: true,
    } as OpenAI.ChatCompletionCreateParamsStreaming);
    await streamOpenAIToAnthropic(stream as any, reply, originalModel, provider);
    log.debug('Streaming completed');
}

async function handleXmlStreamingRequest(
    openai: OpenAI, openaiRequest: any, reply: FastifyReply,
    originalModel: string, provider: string, log: RequestLogger
): Promise<void> {
    log.debug('Making XML streaming request (experimental)');
    const stream = await openai.chat.completions.create({
        ...openaiRequest, stream: true,
    } as OpenAI.ChatCompletionCreateParamsStreaming);
    await streamXmlOpenAIToAnthropic(stream as any, reply, originalModel, provider);
    log.debug('XML streaming completed');
}

// ─── Error handler (unchanged) ────────────────────────────────────────────────

function handleError(
    error: Error, reply: FastifyReply, log: RequestLogger,
    context?: { requestId: string; provider: string; modelName: string; streaming: boolean }
): void {
    let statusCode = 500;
    if ('status' in error) statusCode = (error as any).status;
    log.error('Request failed', error, { statusCode });
    if (context) recordError(error, context);
    const errorResponse = createErrorResponse(error, statusCode);
    reply.code(errorResponse.status).send({ error: errorResponse.error });
}
