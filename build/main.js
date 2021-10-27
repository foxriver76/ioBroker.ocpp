"use strict";
/*
 * Created with @iobroker/create-adapter v2.0.1
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = __importStar(require("@iobroker/adapter-core"));
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
const ocpp_eliftech_1 = require("ocpp-eliftech");
// Load your modules here, e.g.:
// import * as fs from "fs";
class Ocpp extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'ocpp',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.client = {
            info: {
                connectors: []
            }
        };
    }
    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.log.info('Starting OCPP Server');
        for (const i in ocpp_eliftech_1.OCPPCommands['Authorize']) {
            this.log.warn(i);
        }
        const server = new ocpp_eliftech_1.CentralSystem();
        const port = await this.getPortAsync(this.config.port);
        server.listen(port);
        this.log.info(`Server listening on port ${port}`);
        server.onRequest = async (client, command) => {
            const connection = client.connection;
            this.log.info(`New command from ${connection.url}`);
            switch (true) {
                case (command instanceof ocpp_eliftech_1.OCPPCommands.BootNotification):
                    this.log.info('Received Boot Notification');
                    this.client.info = {
                        connectors: [],
                        ...command
                    };
                    return {
                        status: 'Accepted',
                        currentTime: new Date().toISOString(),
                        interval: 60
                    };
                case (command instanceof ocpp_eliftech_1.OCPPCommands.Authorize):
                    this.log.info('Received Authorization Request');
                    return {
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                case command instanceof ocpp_eliftech_1.OCPPCommands.StartTransaction:
                    this.log.info('Received Start transaction');
                    return {
                        transactionId: 1,
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                case (command instanceof ocpp_eliftech_1.OCPPCommands.StopTransaction):
                    this.log.info('Received stop transaction');
                    return {
                        transactionId: 1,
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                case (command instanceof ocpp_eliftech_1.OCPPCommands.Heartbeat):
                    this.log.info('Received heartbeat');
                    return {
                        currentTime: new Date().toISOString()
                    };
                case (command instanceof ocpp_eliftech_1.OCPPCommands.StatusNotification):
                    this.log.info('Received Status Notification');
                    // client.info = client.info || {};
                    // client.info.connectors = client.info.connectors || [];
                    const connectorIndex = this.client.info.connectors.findIndex(item => command.connectorId === item.connectorId);
                    if (connectorIndex === -1) {
                        this.client.info.connectors.push({
                            ...command
                        });
                    }
                    else {
                        this.client.info.connectors[connectorIndex] = {
                            ...command
                        };
                    }
                    return {};
                default:
                    this.log.warn(`Command not implemented: ${JSON.stringify(command)}`);
            }
        };
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    async onUnload(callback) {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            // clearInterval(interval1);
            await this.setStateAsync('info.connection', false, true);
            callback();
        }
        catch (_a) {
            callback();
        }
    }
    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  */
    // private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
    // 	if (obj) {
    // 		// The object was changed
    // 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    // 	} else {
    // 		// The object was deleted
    // 		this.log.info(`object ${id} deleted`);
    // 	}
    // }
    /**
     * Is called if a subscribed state changes
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        }
        else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }
}
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options) => new Ocpp(options);
}
else {
    // otherwise start the instance directly
    (() => new Ocpp())();
}
//# sourceMappingURL=main.js.map