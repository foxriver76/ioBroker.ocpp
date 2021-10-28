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
const utils = __importStar(require("@iobroker/adapter-core"));
const states_1 = require("./lib/states");
const ocpp_eliftech_1 = require("ocpp-eliftech");
class Ocpp extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'ocpp',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.clientTimeouts = {};
        this.knownClients = [];
        this.clients = {};
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
        // subscribe own states
        this.subscribeStates('*');
        this.log.info('Starting OCPP Server');
        const server = new ocpp_eliftech_1.CentralSystem();
        const port = await this.getPortAsync(this.config.port);
        server.listen(port);
        this.log.info(`Server listening on port ${port}`);
        server.onRequest = async (client, command) => {
            const connection = client.connection;
            this.clients[connection.url] = client;
            // we received a new command, first check if the client is known to us
            if (this.knownClients.indexOf(connection.url) === -1) {
                this.log.info(`New device connected: "${connection.url}"`);
                // not known yet
                this.knownClients.push(connection.url);
                // request all important values at start, do not await this
                this.requestNewClient(connection, command);
                // on connection, ensure objects for this device are existing
                await this.createDeviceObjects(connection.url);
                // device is now connected
                await this.setDeviceOnline(connection.url);
            }
            // we give 90 seconds to send next heartbeat - every response can count as heartbeat according to OCPP
            if (this.clientTimeouts[connection.url]) {
                clearTimeout(this.clientTimeouts[connection.url]);
            }
            this.clientTimeouts[connection.url] = setTimeout(() => this.timedOut(connection.url), 90000);
            switch (true) {
                case (command instanceof ocpp_eliftech_1.OCPPCommands.BootNotification):
                    this.log.info(`Received boot notification from "${connection.url}"`);
                    this.client.info = {
                        connectors: [],
                        ...command
                    };
                    // device booted, extend native to object
                    await this.extendObjectAsync(connection.url, {
                        native: command
                    });
                    // we are requesting heartbeat every 60 seconds
                    return {
                        status: 'Accepted',
                        currentTime: new Date().toISOString(),
                        interval: 55
                    };
                case (command instanceof ocpp_eliftech_1.OCPPCommands.Authorize):
                    this.log.info(`Received Authorization Request from "${connection.url}"`);
                    return {
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                case command instanceof ocpp_eliftech_1.OCPPCommands.StartTransaction:
                    this.log.info(`Received Start transaction from "${connection.url}"`);
                    await this.setStateAsync(`${connection.url}.enabled`, true, true);
                    return {
                        transactionId: 1,
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                case (command instanceof ocpp_eliftech_1.OCPPCommands.StopTransaction):
                    this.log.info(`Received stop transaction from "${connection.url}"`);
                    await this.setStateAsync(`${connection.url}.enabled`, false, true);
                    return {
                        transactionId: 1,
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                case (command instanceof ocpp_eliftech_1.OCPPCommands.Heartbeat):
                    this.log.debug(`Received heartbeat from "${connection.url}"`);
                    return {
                        currentTime: new Date().toISOString()
                    };
                case (command instanceof ocpp_eliftech_1.OCPPCommands.StatusNotification):
                    this.log.info(`Received Status Notification from "${connection.url}": ${command.status}`);
                    // {"connectorId":1,"errorCode":"NoError","info":"","status":"Preparing","timestamp":"2021-10-27T15:30:09Z","vendorId":"","vendorErrorCode":""}
                    await this.setStateChangedAsync(`${connection.url}.connectorId`, command.connectorId, true);
                    // set status state
                    await this.setStateAsync(`${connection.url}.status`, command.status, true);
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
                case (command instanceof ocpp_eliftech_1.OCPPCommands.MeterValues):
                    this.log.info(`Received MeterValues from "${connection.url}"`);
                    // {"connectorId":1,"transactionId":1,"meterValue":[{"timestamp":"2021-10-27T17:35:01Z",
                    // "sampledValue":[{"value":"4264","format":"Raw","location":"Outlet","context":"Sample.Periodic",
                    // "measurand":"Energy.Active.Import.Register","unit":"Wh"}]}]}
                    await this.setStateAsync(`${connection.url}.meterValue`, parseFloat(command.meterValue[0].sampledValue[0].value), true);
                    return {};
                default:
                    this.log.warn(`Command not implemented from "${connection.url}": ${JSON.stringify(command)}`);
            }
        };
    }
    /**
     * Request BootNotification, StatusNotification and MeterValues
     * @param connection connection object
     * @param command command object
     * @private
     */
    async requestNewClient(connection, command) {
        // we want to request boot notification and status and meter values to ahve everything up to date again
        try {
            if (!(command instanceof ocpp_eliftech_1.OCPPCommands.BootNotification)) {
                // it's not a boot notification so request
                this.log.info(`Requesting BootNotification from "${connection.url}"`);
                await connection.send(new ocpp_eliftech_1.OCPPCommands.TriggerMessage({
                    requestedMessage: 'BootNotification'
                }));
                await this.wait(1000);
            }
            if (!(command instanceof ocpp_eliftech_1.OCPPCommands.StatusNotification)) {
                // it's not a status notification so request
                this.log.info(`Requesting StatusNotification from "${connection.url}"`);
                await connection.send(new ocpp_eliftech_1.OCPPCommands.TriggerMessage({
                    requestedMessage: 'StatusNotification'
                }));
                await this.wait(1000);
            }
            if (!(command instanceof ocpp_eliftech_1.OCPPCommands.MeterValues)) {
                this.log.info(`Requesting MeterValues from "${connection.url}"`);
                // it's not MeterValues, so request
                await connection.send(new ocpp_eliftech_1.OCPPCommands.TriggerMessage({
                    requestedMessage: 'MeterValues'
                }));
            }
        }
        catch (e) {
            this.log.warn(`Could not request states of "${connection.url}": ${e.message}`);
        }
    }
    /**
     * Is called if client timed out, sets connection to offline
     * @param device name of the wallbox device
     */
    async timedOut(device) {
        this.log.warn(`Client "${device}" timed out`);
        const idx = this.knownClients.indexOf(device);
        if (idx !== -1) {
            // client is in list, but now no longer active
            this.knownClients.splice(idx, 1);
        }
        await this.setStateAsync(`${device}.connected`, false, true);
        const connState = await this.getStateAsync('info.connection');
        if (typeof (connState === null || connState === void 0 ? void 0 : connState.val) === 'string') {
            // get devices and convert them to an array
            const devices = connState.val.split(',');
            const idx = devices.indexOf(device);
            if (idx !== -1) {
                // device is in list, so remove it and set updated state
                devices.splice(idx, 1);
                await this.setStateAsync('info.connection', devices.join(','), true);
            }
        }
    }
    /**
     * Sets the corresponding online states
     * @param device name of the wallbox device
     */
    async setDeviceOnline(device) {
        await this.setStateAsync(`${device}.connected`, true, true);
        const connState = await this.getStateAsync('info.connection');
        if (typeof (connState === null || connState === void 0 ? void 0 : connState.val) === 'string') {
            const devices = connState.val.split(',');
            if (devices.indexOf(device) === -1) {
                // device not yet in array
                devices.push(device);
                await this.setStateAsync('info.connection', devices.join(','), true);
            }
        }
        else {
            // just set device
            await this.setStateAsync('info.connection', device, true);
        }
    }
    /**
     * Creates the corresponding state objects for a device
     * @param device name of the wallbox device
     */
    async createDeviceObjects(device) {
        await this.extendObjectAsync(device, {
            type: 'device',
            common: {
                name: device
            },
            native: {}
        }, { preserve: { common: ['name'] } });
        for (const obj of states_1.stateObjects) {
            const id = obj._id;
            obj._id = `${device}.${obj._id}`;
            await this.extendObjectAsync(obj._id, obj, { preserve: { common: ['name'] } });
            obj._id = id;
        }
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    async onUnload(callback) {
        try {
            // clear all timeouts
            for (const [device, timeout] of Object.entries(this.clientTimeouts)) {
                await this.setStateAsync(`${device}.connected`, false, true);
                clearTimeout(timeout);
            }
            await this.setStateAsync('info.connection', '', true);
            callback();
        }
        catch (_a) {
            callback();
        }
    }
    /**
     * Is called if a subscribed state changes
     */
    async onStateChange(id, state) {
        if (!state || state.ack) {
            // if state deleted or already acknowledged
            return;
        }
        // handle state change
        const idArr = id.split('.');
        const connState = await this.getStateAsync(`${idArr[2]}.connected`);
        if (!(connState === null || connState === void 0 ? void 0 : connState.val)) {
            this.log.warn(`Cannot control "${idArr[2]}", because not connected`);
            return;
        }
        if (idArr[3] === 'enabled') {
            // enable/disable charger
            // we need connectorId
            const connIdState = await this.getStateAsync(`${idArr[2]}.connectorId`);
            if (!(connIdState === null || connIdState === void 0 ? void 0 : connIdState.val)) {
                this.log.warn(`No connectorId for "${idArr[2]}"`);
                return;
            }
            const connectorId = connIdState.val;
            let command;
            if (state.val) {
                // enable
                command = new ocpp_eliftech_1.OCPPCommands.RemoteStartTransaction({
                    connectorId: connectorId,
                    idTag: connectorId.toString()
                });
            }
            else {
                // disable
                command = new ocpp_eliftech_1.OCPPCommands.RemoteStopTransaction({
                    transactionId: connectorId
                });
            }
            try {
                await this.clients[idArr[2]].connection.send(command);
            }
            catch (e) {
                this.log.error(`Cannot execute command "${idArr[4]}" for "${idArr[3]}": ${e.message}`);
            }
        }
    }
    /**
     * Waits for given ms
     * @param ms milliseconds to wait
     * @private
     */
    async wait(ms) {
        return new Promise(resolve => {
            setTimeout(() => resolve(), ms);
        });
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