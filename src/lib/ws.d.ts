declare module 'ws' {
    import { EventEmitter } from 'events';
    import * as http from 'http';
    import * as https from 'https';
    import * as net from 'net';

    class WebSocket extends EventEmitter {
        public static readonly CONNECTING: 0;
        public static readonly OPEN: 1;
        public static readonly CLOSING: 2;
        public static readonly CLOSED: 3;

        public readonly readyState: number;
        public readonly protocol: string;
        public readonly url: string;

        public constructor(address: string, protocols?: string | string[], options?: Record<string, unknown>);

        public send(data: string | Buffer, cb?: (err?: Error) => void): void;
        public ping(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void;
        public pong(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void;
        public close(code?: number, data?: string | Buffer): void;
        public terminate(): void;
    }

    namespace WebSocket {
        type Data = string | Buffer | ArrayBuffer | Buffer[];

        interface ServerOptions {
            host?: string;
            port?: number;
            server?: http.Server | https.Server;
            noServer?: boolean;
            path?: string;
            clientTracking?: boolean;
            handleProtocols?: (protocols: string[] | Set<string>, request: http.IncomingMessage) => string | false;
        }

        class Server extends EventEmitter {
            public readonly clients: Set<WebSocket>;
            public constructor(options?: ServerOptions, callback?: () => void);
            public handleUpgrade(
                request: http.IncomingMessage,
                socket: net.Socket,
                upgradeHead: Buffer,
                callback: (client: WebSocket, request: http.IncomingMessage) => void
            ): void;
            public close(cb?: (err?: Error) => void): void;
        }
    }

    export = WebSocket;
}
