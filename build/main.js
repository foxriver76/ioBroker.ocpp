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
const ocpp_eliftech_1 = require("@ampeco/ocpp-eliftech");
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
    }
    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // subscribe own states
        this.subscribeStates('*');
        this.log.info('Starting OCPP Server');
        // reset connection state
        await this.setStateAsync('info.connection', '', true);
        const validateConnection = (url, credentials, protocol) => {
            this.log.info(`Connection from "${url}" with credentials "${JSON.stringify(credentials)}" and protocol: "${protocol}"`);
            return Promise.resolve([true, 0, '']);
        };
        this.server = new ocpp_eliftech_1.CentralSystem({ validateConnection, wsOptions: {} });
        const port = await this.getPortAsync(this.config.port);
        this.server.listen(port);
        this.log.info(`Server listening on port ${port}`);
        /**
         * Called if client sends an error
         */
        this.server.onError = async (client, command, error) => {
            this.log.error(`Received error from "${client.connection.url}" with command "${JSON.stringify(command)}": ${error.message}`);
        };
        /**
         * Called if client sends response error
         */
        this.server.onResponseError = async (client, command, response, error) => {
            this.log.error(`Received response error from "${client.connection.url}" with command "${JSON.stringify(command)}" (response: ${JSON.stringify(response)}): ${error.message}`);
        };
        /**
         * Called if we receive a command from a client
         */
        this.server.onRequest = async (client, command) => {
            const connection = client.connection;
            // we replace all dots
            const devName = connection.url.replace(/\./g, '_');
            // we received a new command, first check if the client is known to us
            if (!this.knownClients.includes(connection.url)) {
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
            // for debug purposes log whole command here
            this.log.debug(JSON.stringify(command));
            switch (command.getCommandName()) {
                case 'BootNotification': {
                    this.log.info(`Received boot notification from "${connection.url}"`);
                    // device booted, extend native to object
                    await this.extendObjectAsync(devName, {
                        native: command
                    });
                    // we are requesting heartbeat every 60 seconds
                    const response = {
                        status: 'Accepted',
                        currentTime: new Date().toISOString(),
                        interval: 55
                    };
                    return response;
                }
                case 'Authorize': {
                    this.log.info(`Received Authorization Request from "${connection.url}"`);
                    const response = {
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                    return response;
                }
                case 'StartTransaction': {
                    this.log.info(`Received Start transaction from "${connection.url}"`);
                    await this.setStateAsync(`${devName}.transactionActive`, true, true);
                    const response = {
                        transactionId: 1,
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                    return response;
                }
                case 'StopTransaction': {
                    this.log.info(`Received stop transaction from "${connection.url}"`);
                    await this.setStateAsync(`${devName}.transactionActive`, false, true);
                    const response = {
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                    return response;
                }
                case 'Heartbeat': {
                    this.log.debug(`Received heartbeat from "${connection.url}"`);
                    const response = {
                        currentTime: new Date().toISOString()
                    };
                    return response;
                }
                case 'StatusNotification': {
                    this.log.info(`Received Status Notification from "${connection.url}": ${command.status}`);
                    // {"connectorId":1,"errorCode":"NoError","info":"","status":"Preparing","timestamp":"2021-10-27T15:30:09Z","vendorId":"","vendorErrorCode":""}
                    await this.setStateChangedAsync(`${devName}.connectorId`, command.connectorId, true);
                    // set status state
                    await this.setStateAsync(`${devName}.status`, command.status, true);
                    const response = {};
                    return response;
                }
                case 'MeterValues': {
                    this.log.info(`Received MeterValues from "${connection.url}"`);
                    // {"connectorId":1,"transactionId":1,"meterValue":[{"timestamp":"2021-10-27T17:35:01Z",
                    // "sampledValue":[{"value":"4264","format":"Raw","location":"Outlet","context":"Sample.Periodic",
                    // "measurand":"Energy.Active.Import.Register","unit":"Wh"}]}]}
                    await this.setStateAsync(`${devName}.meterValue`, parseFloat(command.meterValue[0].sampledValue[0].value), true);
                    const response = {};
                    return response;
                }
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
            if (command.getCommandName() !== 'BootNotification') {
                // it's not a boot notification so request
                this.log.info(`Requesting BootNotification from "${connection.url}"`);
                await connection.send(new ocpp_eliftech_1.OCPPCommands.TriggerMessage({
                    requestedMessage: 'BootNotification'
                }), 3 /*MessageType.CALLRESULT_MESSAGE*/);
                await this.wait(1000);
            }
            if (command.getCommandName() !== 'StatusNotification') {
                // it's not a status notification so request
                this.log.info(`Requesting StatusNotification from "${connection.url}"`);
                await connection.send(new ocpp_eliftech_1.OCPPCommands.TriggerMessage({
                    requestedMessage: 'StatusNotification'
                }), 3 /*MessageType.CALLRESULT_MESSAGE*/);
                await this.wait(1000);
            }
            if (command.getCommandName() !== 'MeterValues') {
                this.log.info(`Requesting MeterValues from "${connection.url}"`);
                // it's not MeterValues, so request
                await connection.send(new ocpp_eliftech_1.OCPPCommands.TriggerMessage({
                    requestedMessage: 'MeterValues'
                }), 3 /*MessageType.CALLRESULT_MESSAGE*/);
                await this.wait(1000);
            }
            if (command.getCommandName() !== 'GetConfiguration') {
                this.log.info(`Sending GetConfiguration to "${connection.url}"`);
                // it's not GetConfiguration try to request whole config
                await connection.send(new ocpp_eliftech_1.OCPPCommands.GetConfiguration({}), 3 /*MessageType.CALLRESULT_MESSAGE*/);
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
        await this.setStateAsync(`${device.replace(/\./g, '_')}.connected`, false, true);
        const connState = await this.getStateAsync('info.connection');
        if ((connState === null || connState === void 0 ? void 0 : connState.val) && typeof connState.val === 'string') {
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
        await this.setStateAsync(`${device.replace(/\./g, '_')}.connected`, true, true);
        const connState = await this.getStateAsync('info.connection');
        if (typeof (connState === null || connState === void 0 ? void 0 : connState.val) === 'string') {
            // if empty string make empty array
            const devices = connState.val ? connState.val.split(',') : [];
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
        await this.extendObjectAsync(device.replace(/\./g, '_'), {
            type: 'device',
            common: {
                name: device
            },
            native: {}
        }, { preserve: { common: ['name'] } });
        for (const obj of states_1.stateObjects) {
            const id = obj._id;
            obj._id = `${device.replace(/\./g, '_')}.${obj._id}`;
            await this.extendObjectAsync(obj._id, obj, { preserve: { common: ['name'] } });
            obj._id = id;
        }
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    async onUnload(callback) {
        try {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore 3rd party typings are not perfect ;-)
            this.server.server.close();
            delete this.server;
            // clear all timeouts
            for (const [device, timeout] of Object.entries(this.clientTimeouts)) {
                await this.setStateAsync(`${device.replace(/\./g, '_')}.connected`, false, true);
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
        const deviceName = idArr[2];
        const functionality = idArr[3];
        if (!this.server) {
            this.log.warn(`Cannot control "${deviceName}", because server is not running`);
            return;
        }
        const connState = await this.getStateAsync(`${deviceName}.connected`);
        const client = this.server.clients.find(client => {
            return client.connection.url.replace(/\./g, '_') === deviceName;
        });
        if (!(connState === null || connState === void 0 ? void 0 : connState.val) || !client) {
            this.log.warn(`Cannot control "${deviceName}", because not connected`);
            return;
        }
        // we need connectorId
        const connIdState = await this.getStateAsync(`${deviceName}.connectorId`);
        if (!(connIdState === null || connIdState === void 0 ? void 0 : connIdState.val) || typeof connIdState.val !== 'number') {
            this.log.warn(`No valid connectorId for "${deviceName}"`);
            return;
        }
        const connectorId = connIdState.val;
        if (functionality === 'transactionActive') {
            // enable/disable transaction
            let command;
            if (state.val) {
                // enable
                const cmdObj = {
                    connectorId: connectorId,
                    idTag: connectorId.toString(),
                };
                const limitState = await this.getStateAsync(`${deviceName}.chargeLimit`);
                if ((limitState === null || limitState === void 0 ? void 0 : limitState.val) && typeof limitState.val === 'number') {
                    cmdObj.chargingProfile = {
                        chargingProfileId: 1,
                        stackLevel: 1,
                        chargingProfilePurpose: 'TxProfile',
                        chargingProfileKind: 'Recurring',
                        recurrencyKind: 'Daily',
                        chargingSchedule: {
                            'duration': 86400,
                            'startSchedule': '2013-01-01T00:00Z',
                            'chargingRateUnit': 'W',
                            'chargingSchedulePeriod': [
                                {
                                    startPeriod: 0,
                                    limit: limitState.val // e.g. 12 for 12 A
                                }
                            ],
                            // minChargingRate: 12 // if needed we add it
                        }
                    };
                }
                this.log.debug(`Sending RemoteStartTransaction for ${deviceName}: ${JSON.stringify(cmdObj)}`);
                command = new ocpp_eliftech_1.OCPPCommands.RemoteStartTransaction(cmdObj);
            }
            else {
                // disable
                this.log.debug(`Sending RemoteStopTransaction for ${deviceName}`);
                command = new ocpp_eliftech_1.OCPPCommands.RemoteStopTransaction({
                    transactionId: connectorId
                });
            }
            try {
                await client.connection.send(command, 3 /*MessageType.CALLRESULT_MESSAGE*/);
            }
            catch (e) {
                this.log.error(`Cannot execute command "${functionality}" for "${deviceName}": ${e.message}`);
            }
        }
        else if (functionality === 'availability') {
            try {
                this.log.debug(`Sending ChangeAvailability for ${deviceName}: ${state.val ? 'Operative' : 'Inoperative'}`);
                await client.connection.send(new ocpp_eliftech_1.OCPPCommands.ChangeAvailability({
                    connectorId: connectorId,
                    type: state.val ? 'Operative' : 'Inoperative'
                }), 3 /*MessageType.CALLRESULT_MESSAGE*/);
            }
            catch (e) {
                this.log.error(`Cannot execute command "${functionality}" for "${deviceName}": ${e.message}`);
            }
        }
        else if (functionality === 'chargeLimit' && typeof state.val === 'number') {
            try {
                this.log.debug(`Sending SetChargingProfile for ${deviceName}`);
                await client.connection.send(new ocpp_eliftech_1.OCPPCommands.SetChargingProfile({
                    connectorId: connectorId,
                    csChargingProfiles: {
                        chargingProfileId: 1,
                        stackLevel: 1,
                        chargingProfilePurpose: 'TxDefaultProfile',
                        chargingProfileKind: 'Recurring',
                        recurrencyKind: 'Daily',
                        chargingSchedule: {
                            'duration': 86400,
                            'startSchedule': '2013-01-01T00:00Z',
                            'chargingRateUnit': 'W',
                            'chargingSchedulePeriod': [
                                {
                                    startPeriod: 0,
                                    limit: state.val // e.g. 12 for 12 A
                                }
                            ],
                            // minChargingRate: 12 // if needed we add it
                        }
                    }
                }), 3 /*MessageType.CALLRESULT_MESSAGE*/);
            }
            catch (e) {
                this.log.error(`Cannot execute command "${functionality}" for "${deviceName}": ${e.message}`);
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