import * as http from 'node:http';
import * as https from 'node:https';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type {
    OcppCallErrorFrame,
    OcppCallFrame,
    OcppCallResultFrame,
    OcppErrorCode,
    OcppProtocolVersion,
} from './ocpp-types';
import { OCPP_MESSAGE_TYPE } from './ocpp-types';

export interface BasicAuthCredentials {
    name: string;
    pass: string;
}

export type ValidateConnectionCallback = (
    url: string,
    credentials: BasicAuthCredentials | undefined,
    protocol: 'http' | 'https',
    ocppProtocolVersion?: string,
) => Promise<[boolean, number?, string?]>;

export interface OcppServerOptions {
    validateConnection?: ValidateConnectionCallback;
    /** Timeout in ms for outgoing CALL commands (default: 30000) */
    callTimeoutMs?: number;
    /** Optional TLS options to run a secure wss:// server */
    tlsOptions?: https.ServerOptions;
    /** Supported OCPP subprotocols (default: ['ocpp1.6']) */
    supportedProtocols?: OcppProtocolVersion[];
}

interface PendingCall {
    action: string;
    resolve: (payload: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
}

export class OcppError extends Error {
    public readonly errorCode: OcppErrorCode;
    public readonly errorDetails: Record<string, unknown>;

    public constructor(errorCode: OcppErrorCode, errorDescription: string, errorDetails: Record<string, unknown> = {}) {
        super(errorDescription || errorCode);
        this.name = 'OcppError';
        this.errorCode = errorCode;
        this.errorDetails = errorDetails;
    }
}

/**
 * Represents a single connected Charge Point session over OCPP-J WebSocket
 */
export class OcppClientConnection {
    public readonly url: string;
    public readonly protocol: OcppProtocolVersion;
    private readonly ws: WebSocket;
    private readonly callTimeoutMs: number;
    private readonly pendingCalls: Map<string, PendingCall> = new Map();
    /** Serializes outgoing CALL messages per OCPP-J specification (max 1 in-flight CALL at a time) */
    private sendQueue: Promise<unknown> = Promise.resolve();

    public onRequest?: (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
    public onError?: (action: string | undefined, error: Error) => void;
    public onClose?: (code: number, reason: string) => void;

    public constructor(ws: WebSocket, url: string, protocol: OcppProtocolVersion, callTimeoutMs = 30_000) {
        this.ws = ws;
        this.url = url;
        this.protocol = protocol;
        this.callTimeoutMs = callTimeoutMs;

        this.ws.on('message', (data: WebSocket.Data) => {
            void this.handleRawMessage(data);
        });

        this.ws.on('error', (err: Error) => {
            this.onError?.(undefined, err);
        });

        this.ws.on('close', (code: number, reason: Buffer | string) => {
            this.rejectAllPending(new Error(`Connection "${this.url}" closed (code ${code})`));
            const reasonStr = typeof reason === 'string' ? reason : reason.toString('utf8');
            this.onClose?.(code, reasonStr);
        });
    }

    /**
     * Checks whether the underlying WebSocket is currently open
     */
    public isOpen(): boolean {
        return this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * Sends an OCPP-J CALL message to the Charge Point and awaits CALLRESULT.
     * Automatically queues concurrent calls so only one CALL is in-flight at any given time (OCPP-J section 4.1).
     *
     * @param action OCPP action name (e.g. "RemoteStartTransaction", "SetChargingProfile")
     * @param payload Action request payload
     */
    public sendCommand<TReq extends object, TRes = Record<string, unknown>>(
        action: string,
        payload: TReq,
    ): Promise<TRes> {
        const nextTask = this.sendQueue.then(
            () => this.executeCommand<TReq, TRes>(action, payload),
            () => this.executeCommand<TReq, TRes>(action, payload),
        );
        // Keep queue chain alive without unhandled rejection on the internal tail
        this.sendQueue = nextTask.then(
            () => undefined,
            () => undefined,
        );
        return nextTask;
    }

    private executeCommand<TReq extends object, TRes = Record<string, unknown>>(
        action: string,
        payload: TReq,
    ): Promise<TRes> {
        if (!this.isOpen()) {
            return Promise.reject(new Error(`WebSocket connection to "${this.url}" is not open`));
        }

        const messageId = randomUUID();
        const cleanPayload = this.stripUndefined(payload as Record<string, unknown>);
        const frame: OcppCallFrame = [OCPP_MESSAGE_TYPE.CALL, messageId, action, cleanPayload];

        return new Promise<TRes>((resolve, reject) => {
            const timeout = this.setTimeout(() => {
                this.pendingCalls.delete(messageId);
                reject(new Error(`Timeout waiting for response to "${action}" (messageId: ${messageId})`));
            }, this.callTimeoutMs);

            this.pendingCalls.set(messageId, {
                action,
                resolve: res => resolve(res as TRes),
                reject,
                timeout,
            });

            this.ws.send(JSON.stringify(frame), err => {
                if (err) {
                    this.clearTimeout(timeout);
                    this.pendingCalls.delete(messageId);
                    reject(err);
                }
            });
        });
    }

    /**
     * Sends a WebSocket-level ping frame to keep the TCP connection alive
     */
    public ping(): void {
        if (this.isOpen()) {
            try {
                this.ws.ping();
            } catch {
                // ignore ping errors on closing sockets
            }
        }
    }

    /**
     * Closes the WebSocket connection cleanly and rejects any pending requests
     *
     * @param code WebSocket close status code
     * @param reason Human-readable close reason
     */
    public close(code = 1000, reason = 'Normal Closure'): void {
        this.rejectAllPending(new Error(`Connection to "${this.url}" closed by server`));
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            try {
                this.ws.close(code, reason);
            } catch {
                this.ws.terminate();
            }
        }
    }

    private rejectAllPending(error: Error): void {
        for (const [messageId, pending] of this.pendingCalls.entries()) {
            this.clearTimeout(pending.timeout);
            pending.reject(error);
            this.pendingCalls.delete(messageId);
        }
    }

    /**
     * Recursively removes keys with `undefined` values so Charge Points do not fail JSON schema validation
     *
     * @param obj
     */
    private stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
        return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
    }

    private async handleRawMessage(data: WebSocket.Data): Promise<void> {
        let rawText: string;
        if (typeof data === 'string') {
            rawText = data;
        } else if (Buffer.isBuffer(data)) {
            rawText = data.toString('utf8');
        } else if (Array.isArray(data)) {
            rawText = Buffer.concat(data).toString('utf8');
        } else {
            rawText = Buffer.from(data).toString('utf8');
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(rawText);
        } catch (err: any) {
            this.onError?.(undefined, new Error(`Invalid JSON received from "${this.url}": ${err.message}`));
            return;
        }

        if (!Array.isArray(parsed) || parsed.length < 3) {
            this.onError?.(undefined, new Error(`Malformed OCPP-J frame from "${this.url}": ${rawText}`));
            return;
        }

        const messageTypeId = parsed[0];
        const messageId = String(parsed[1]);

        if (messageTypeId === OCPP_MESSAGE_TYPE.CALL) {
            const action = String(parsed[2]);
            const payload = (parsed[3] && typeof parsed[3] === 'object' ? parsed[3] : {}) as Record<string, unknown>;
            await this.handleIncomingCall(messageId, action, payload);
        } else if (messageTypeId === OCPP_MESSAGE_TYPE.CALLRESULT) {
            const payload = (parsed[2] && typeof parsed[2] === 'object' ? parsed[2] : {}) as Record<string, unknown>;
            this.handleIncomingCallResult(messageId, payload);
        } else if (messageTypeId === OCPP_MESSAGE_TYPE.CALLERROR) {
            const errorCode = String(parsed[2] || 'GenericError') as OcppErrorCode;
            const errorDescription = String(parsed[3] || '');
            const errorDetails = (parsed[4] && typeof parsed[4] === 'object' ? parsed[4] : {}) as Record<
                string,
                unknown
            >;
            this.handleIncomingCallError(messageId, errorCode, errorDescription, errorDetails);
        } else {
            this.onError?.(
                undefined,
                new Error(`Unknown OCPP messageTypeId "${String(messageTypeId)}" from "${this.url}"`),
            );
        }
    }

    private async handleIncomingCall(
        messageId: string,
        action: string,
        payload: Record<string, unknown>,
    ): Promise<void> {
        if (!this.onRequest) {
            this.sendCallError(messageId, 'NotImplemented', `No request handler registered for "${action}"`);
            return;
        }

        try {
            const responsePayload = (await this.onRequest(action, payload)) ?? {};
            this.sendCallResult(messageId, responsePayload);
        } catch (err: any) {
            if (err instanceof OcppError) {
                this.sendCallError(messageId, err.errorCode, err.message, err.errorDetails);
            } else {
                this.onError?.(action, err instanceof Error ? err : new Error(String(err)));
                this.sendCallError(messageId, 'InternalError', err?.message || 'Internal error');
            }
        }
    }

    private handleIncomingCallResult(messageId: string, payload: Record<string, unknown>): void {
        const pending = this.pendingCalls.get(messageId);
        if (!pending) {
            return;
        }
        this.clearTimeout(pending.timeout);
        this.pendingCalls.delete(messageId);
        pending.resolve(payload);
    }

    private handleIncomingCallError(
        messageId: string,
        errorCode: OcppErrorCode,
        errorDescription: string,
        errorDetails: Record<string, unknown>,
    ): void {
        const pending = this.pendingCalls.get(messageId);
        const error = new OcppError(
            errorCode,
            `${errorCode}${errorDescription ? `: ${errorDescription}` : ''}`,
            errorDetails,
        );
        if (!pending) {
            this.onError?.(undefined, error);
            return;
        }
        this.clearTimeout(pending.timeout);
        this.pendingCalls.delete(messageId);
        pending.reject(error);
    }

    private sendCallResult(messageId: string, payload: Record<string, unknown>): void {
        if (!this.isOpen()) {
            return;
        }
        const frame: OcppCallResultFrame = [OCPP_MESSAGE_TYPE.CALLRESULT, messageId, this.stripUndefined(payload)];
        this.ws.send(JSON.stringify(frame), () => {
            // ignore send errors on abruptly closed sockets
        });
    }

    private sendCallError(
        messageId: string,
        errorCode: OcppErrorCode,
        errorDescription: string,
        errorDetails: Record<string, unknown> = {},
    ): void {
        if (!this.isOpen()) {
            return;
        }
        const frame: OcppCallErrorFrame = [
            OCPP_MESSAGE_TYPE.CALLERROR,
            messageId,
            errorCode,
            errorDescription,
            errorDetails,
        ];
        this.ws.send(JSON.stringify(frame), () => {
            // ignore send errors on abruptly closed sockets
        });
    }

    /**
     * Timer helper matching ioBroker repochecker pattern
     *
     * @param callback timer callback function
     * @param ms delay in milliseconds
     */
    private setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
        return setTimeout(callback, ms);
    }

    /**
     * Clears an active timer
     *
     * @param timeout timer reference
     */
    private clearTimeout(timeout: NodeJS.Timeout): void {
        clearTimeout(timeout);
    }
}

/**
 * OCPP-J Central System Server supporting OCPP 1.6 (and ready for OCPP 2.0.1)
 */
export class OcppServer {
    private readonly options: OcppServerOptions;
    private httpServer?: http.Server | https.Server;
    private wss?: WebSocket.Server;
    private readonly activeClients: Map<string, OcppClientConnection> = new Map();

    public onRequest?: (
        client: OcppClientConnection,
        action: string,
        payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    public onClientError?: (client: OcppClientConnection, action: string | undefined, error: Error) => void;
    public onClientConnect?: (client: OcppClientConnection) => void;
    public onClientDisconnect?: (client: OcppClientConnection, code: number, reason: string) => void;

    public constructor(options: OcppServerOptions = {}) {
        this.options = options;
    }

    /**
     * Returns an active client connection by its raw URL (e.g. "/EVB-123")
     *
     * @param url client URL
     */
    public getClient(url: string): OcppClientConnection | undefined {
        return this.activeClients.get(url);
    }

    /**
     * Returns all currently active client connections
     */
    public getClients(): OcppClientConnection[] {
        return Array.from(this.activeClients.values());
    }

    /**
     * Starts listening for OCPP WebSocket connections on the given port
     *
     * @param port TCP port to listen on
     * @param host optional bind address
     */
    public async listen(port: number, host?: string): Promise<void> {
        const supportedProtocols = this.options.supportedProtocols ?? ['ocpp1.6'];

        this.httpServer = this.options.tlsOptions ? https.createServer(this.options.tlsOptions) : http.createServer();

        this.wss = new WebSocket.Server({
            noServer: true,
            handleProtocols: (protocols: string[] | Set<string>): string | false => {
                const list = Array.isArray(protocols) ? protocols : Array.from(protocols);
                for (const supported of supportedProtocols) {
                    if (list.includes(supported)) {
                        return supported;
                    }
                }
                // If client did not send Sec-WebSocket-Protocol at all, default to ocpp1.6
                if (list.length === 0) {
                    return 'ocpp1.6';
                }
                return false;
            },
        });

        this.httpServer.on('upgrade', (req, socket, head) => {
            void this.handleUpgrade(req, socket as Socket, head);
        });

        return new Promise((resolve, reject) => {
            const onError = (err: Error): void => {
                reject(err);
            };
            this.httpServer!.once('error', onError);
            this.httpServer!.listen(port, host, () => {
                this.httpServer?.removeListener('error', onError);
                resolve();
            });
        });
    }

    /**
     * Stops the WebSocket and HTTP(S) server and closes all client connections
     */
    public async close(): Promise<void> {
        for (const client of this.activeClients.values()) {
            client.onClose = undefined;
            client.close(1001, 'Server shutting down');
        }
        this.activeClients.clear();

        if (this.wss) {
            await new Promise<void>(resolve => this.wss!.close(() => resolve()));
            this.wss = undefined;
        }

        if (this.httpServer) {
            await new Promise<void>(resolve => this.httpServer!.close(() => resolve()));
            this.httpServer = undefined;
        }
    }

    private parseBasicAuth(authHeader: string | undefined): BasicAuthCredentials | undefined {
        if (!authHeader || !authHeader.toLowerCase().startsWith('basic ')) {
            return undefined;
        }
        try {
            const base64 = authHeader.slice(6).trim();
            const decoded = Buffer.from(base64, 'base64').toString('utf8');
            const colonIdx = decoded.indexOf(':');
            if (colonIdx === -1) {
                return { name: decoded, pass: '' };
            }
            return {
                name: decoded.slice(0, colonIdx),
                pass: decoded.slice(colonIdx + 1),
            };
        } catch {
            return undefined;
        }
    }

    private async handleUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
        socket.on('error', () => {
            // ignore low-level socket reset errors during upgrade/close
        });
        const url = req.url || '/';
        const credentials = this.parseBasicAuth(req.headers.authorization);
        const protocol: 'http' | 'https' = this.options.tlsOptions ? 'https' : 'http';
        const secProtocolHeader = req.headers['sec-websocket-protocol'];
        const requestedProtocol = Array.isArray(secProtocolHeader) ? secProtocolHeader[0] : secProtocolHeader;

        if (this.options.validateConnection) {
            try {
                const [isValid, statusCode, statusMessage] = await this.options.validateConnection(
                    url,
                    credentials,
                    protocol,
                    requestedProtocol,
                );

                if (!isValid || socket.destroyed) {
                    if (!socket.destroyed) {
                        const code = statusCode && statusCode >= 400 ? statusCode : 401;
                        const msg = statusMessage || 'Unauthorized';
                        socket.write(
                            `HTTP/1.1 ${code} ${msg}\r\n` +
                                'WWW-Authenticate: Basic realm="OCPP"\r\n' +
                                'Connection: close\r\n\r\n',
                        );
                        socket.destroy();
                    }
                    return;
                }
            } catch {
                if (!socket.destroyed) {
                    socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
                    socket.destroy();
                }
                return;
            }
        }

        if (!this.wss || socket.destroyed) {
            socket.destroy();
            return;
        }

        this.wss.handleUpgrade(req, socket, head, ws => {
            const negotiatedProtocol = (ws.protocol || 'ocpp1.6') as OcppProtocolVersion;

            // Zombie socket prevention (#20): if an older connection for the same URL still exists, close & replace it
            const existing = this.activeClients.get(url);
            if (existing) {
                existing.onClose = undefined;
                existing.close(1000, 'Replaced by new connection');
                this.activeClients.delete(url);
            }

            const client = new OcppClientConnection(ws, url, negotiatedProtocol, this.options.callTimeoutMs ?? 30_000);

            client.onRequest = async (action, payload) => {
                if (!this.onRequest) {
                    throw new OcppError('NotImplemented', `Action "${action}" is not implemented`);
                }
                return this.onRequest(client, action, payload);
            };

            client.onError = (action, err) => {
                this.onClientError?.(client, action, err);
            };

            client.onClose = (code, reason) => {
                if (this.activeClients.get(url) === client) {
                    this.activeClients.delete(url);
                    this.onClientDisconnect?.(client, code, reason);
                }
            };

            this.activeClients.set(url, client);
            this.onClientConnect?.(client);
        });
    }
}
