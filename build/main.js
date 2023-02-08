"use strict";
/*
 * Created with @iobroker/create-adapter v2.0.1
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
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
// cannot import the constants correctly, so define the necessary ones until fixed
const CALL_MESSAGE = 2; // REQ
class Ocpp extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'ocpp'
        });
        this.clientTimeouts = new Map();
        this.knownClients = new Map();
        this.knownDataTransfer = new Set();
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
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
        const validateConnection = (url, credentials, protocol, ocppProtocolVersion) => {
            this.log.debug(`Connection from "${url}" with credentials "${JSON.stringify(credentials)}", protocol: "${protocol}"${ocppProtocolVersion ? `, OCPP: ${ocppProtocolVersion}` : ''}`);
            if (this.config.authentication) {
                if ((this.config.username && this.config.username !== (credentials === null || credentials === void 0 ? void 0 : credentials.name)) ||
                    (this.config.password && this.config.password !== (credentials === null || credentials === void 0 ? void 0 : credentials.pass))) {
                    this.log.warn(`Client "${url}" provided incorrect credentials, connection denied`);
                    return Promise.resolve([false, 0, '']);
                }
            }
            this.log.info(`New valid connection from "${url}" (${protocol}${ocppProtocolVersion ? `/${ocppProtocolVersion}` : ''})`);
            // sometimes a reconnect happens without time out - ensure to handle as new client (request states etc)
            if (this.knownClients.has(url)) {
                this.knownClients.delete(url);
            }
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
            if (!this.knownClients.has(connection.url)) {
                this.log.info(`New device connected: "${connection.url}"`);
                // not known yet
                this.knownClients.set(connection.url, { connectorIds: [0] });
                // on connection, ensure objects for this device are existing
                await this.createDeviceObjects(connection.url);
                // device is now connected
                await this.setDeviceOnline(connection.url);
                // Every device has a 0 connector
                await this.createConnectorObjects(connection.url, 0);
                // request all important values at start, do not await this
                this.requestNewClient(connection, command);
            }
            // we give 90 seconds to send next heartbeat - every response can count as heartbeat according to OCPP
            if (this.clientTimeouts.has(connection.url)) {
                clearTimeout(this.clientTimeouts.get(connection.url));
            }
            this.clientTimeouts.set(connection.url, setTimeout(() => this.timedOut(connection.url), 90000));
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
                    const authCommand = command;
                    this.log.info(`Received Authorization Request from "${connection.url}" with idTag "${authCommand.idTag}"`);
                    const state = await this.getStateAsync(`${devName}.0.authList`);
                    let status = 'Accepted';
                    if (typeof (state === null || state === void 0 ? void 0 : state.val) === 'string') {
                        const idTags = state.val.replace(/\s/g, '').split(',');
                        if (!idTags.includes(authCommand.idTag)) {
                            status = 'Invalid';
                            this.log.warn(`ID Tag "${authCommand.idTag}" has been rejected`);
                        }
                    }
                    const response = {
                        idTagInfo: {
                            status
                        }
                    };
                    return response;
                }
                case 'StartTransaction': {
                    const startCommand = command;
                    const connectorId = startCommand.connectorId;
                    this.log.info(`Received Start transaction from "${connection.url}.${connectorId}"`);
                    await this.setStateAsync(`${devName}.${connectorId}.idTag`, startCommand.idTag, true);
                    await this.setStateAsync(`${devName}.${connectorId}.transactionStartMeter`, startCommand.meterStart, true);
                    await this.setStateAsync(`${devName}.${connectorId}.transactionActive`, true, true);
                    const response = {
                        transactionId: connectorId,
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                    return response;
                }
                case 'StopTransaction': {
                    const stopCommand = command;
                    // we use connId as transactionId and vice versa
                    const connectorId = stopCommand.transactionId;
                    if (stopCommand.idTag) {
                        await this.setStateAsync(`${devName}.${connectorId}.idTag`, stopCommand.idTag, true);
                    }
                    const startMeterState = await this.getStateAsync(`${devName}.${connectorId}.transactionStartMeter`);
                    this.log.info(`Received stop transaction from "${connection.url}.${connectorId}"`);
                    if (typeof (startMeterState === null || startMeterState === void 0 ? void 0 : startMeterState.val) === 'number') {
                        const consumption = stopCommand.meterStop - startMeterState.val;
                        await this.setStateAsync(`${devName}.${connectorId}.lastTransactionConsumption`, consumption, true);
                    }
                    await this.setStateAsync(`${devName}.${connectorId}.transactionEndMeter`, stopCommand.meterStop, true);
                    await this.setStateAsync(`${devName}.${connectorId}.transactionActive`, false, true);
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
                    const statusCommand = command;
                    const connectorId = statusCommand.connectorId;
                    this.log.info(`Received Status Notification from "${connection.url}.${connectorId}": ${statusCommand.status}`);
                    if (statusCommand.errorCode !== 'NoError') {
                        this.log.warn(`Status from "${connection.url}.${connectorId}" contains an error: ${statusCommand.errorCode}`);
                    }
                    if (!this.knownClients.get(connection.url).connectorIds.includes(connectorId)) {
                        this.knownClients.get(connection.url).connectorIds.push(connectorId);
                        await this.createConnectorObjects(connection.url, connectorId);
                    }
                    await this.setStateAsync(`${devName}.${connectorId}.status`, statusCommand.status, true);
                    const response = {};
                    return response;
                }
                case 'MeterValues': {
                    const meterValuesCommand = command;
                    const connectorId = meterValuesCommand.connectorId;
                    this.log.info(`Received MeterValues from "${connection.url}.${connectorId}"`);
                    // {"connectorId":1,"transactionId":1,"meterValue":[{"timestamp":"2021-10-27T17:35:01Z",
                    // "sampledValue":[{"value":"4264","format":"Raw","location":"Outlet","context":"Sample.Periodic",
                    // "measurand":"Energy.Active.Import.Register","unit":"Wh"}]}]}
                    await this._setMeterValues(devName, connectorId, meterValuesCommand);
                    const response = {};
                    return response;
                }
                case 'DataTransfer':
                    const dataTransferCommand = command;
                    this.log.info(`Received DataTransfer from "${connection.url}" with id "${dataTransferCommand.messageId}": ${dataTransferCommand.data}`);
                    try {
                        await this.synchronizeDataTransfer(devName, dataTransferCommand.messageId, dataTransferCommand.data);
                    }
                    catch (e) {
                        this.log.warn(`Could not synchronize transfer data: ${e.message}`);
                    }
                    const response = { status: 'Accepted' };
                    return response;
                default:
                    this.log.warn(`Command not implemented from "${connection.url}": ${JSON.stringify(command)}`);
            }
        };
    }
    /**
     * Request configuration
     * @param connection the OCPP connection
     */
    async requestConfiguration(connection) {
        this.log.info(`Sending GetConfiguration to "${connection.url}"`);
        // it's not GetConfiguration try to request whole config
        const res = (await connection.send(new ocpp_eliftech_1.OCPPCommands.GetConfiguration({}), CALL_MESSAGE));
        this.log.debug(`Received configuration from ${connection.url}: ${JSON.stringify(res)}`);
        await this.createConfigurationObjects(connection.url, res);
    }
    /**
     * Request BootNotification, StatusNotification and MeterValues
     * @param connection connection object
     * @param command command object
     */
    async requestNewClient(connection, command) {
        var _a, _b;
        // wait initially
        await this._wait(1000);
        // we want to request boot notification and status and meter values to have everything up to date again
        try {
            if (command.getCommandName() !== 'BootNotification') {
                // it's not a boot notification so request
                this.log.info(`Requesting BootNotification from "${connection.url}"`);
                await connection.send(new ocpp_eliftech_1.OCPPCommands.TriggerMessage({
                    requestedMessage: 'BootNotification'
                }), CALL_MESSAGE);
                await this._wait(1000);
            }
            if (command.getCommandName() !== 'StatusNotification') {
                // it's not a status notification so request
                this.log.info(`Requesting StatusNotification from "${connection.url}"`);
                await connection.send(new ocpp_eliftech_1.OCPPCommands.TriggerMessage({
                    requestedMessage: 'StatusNotification'
                }), CALL_MESSAGE);
                await this._wait(1000);
            }
            if (command.getCommandName() !== 'MeterValues') {
                this.log.info(`Requesting MeterValues from "${connection.url}"`);
                // it's not MeterValues, so request
                await connection.send(new ocpp_eliftech_1.OCPPCommands.TriggerMessage({
                    requestedMessage: 'MeterValues'
                }), CALL_MESSAGE);
                await this._wait(1000);
            }
        }
        catch (e) {
            this.log.warn(`Could not request states of "${connection.url}": ${e.message}`);
        }
        try {
            await this.requestConfiguration(connection);
            const supportedProfiles = (_b = (_a = this.knownClients.get(connection.url)) === null || _a === void 0 ? void 0 : _a.supportedProfiles) !== null && _b !== void 0 ? _b : [];
            await this.removeUnsupportedStates(connection.url, supportedProfiles);
        }
        catch (e) {
            this.log.error(`Could not request configuration of ${connection.url}: ${e.message}`);
        }
    }
    /**
     * Is called if client timed out, sets connection to offline
     * @param device name of the wallbox device
     */
    async timedOut(device) {
        this.log.warn(`Client "${device}" timed out`);
        if (this.knownClients.has(device)) {
            this.knownClients.delete(device);
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
        for (const obj of states_1.deviceObjects) {
            const id = obj._id;
            obj._id = `${device.replace(/\./g, '_')}.${obj._id}`;
            await this.extendObjectAsync(obj._id, obj, { preserve: { common: ['name'] } });
            obj._id = id;
        }
    }
    /**
     * Creates configuration objects and states accordingly
     * @param deviceName of the wallbox device
     * @param config the config object
     */
    async createConfigurationObjects(deviceName, config) {
        if (!config.configurationKey) {
            return;
        }
        const iobDeviceName = deviceName.replace(/\./g, '_');
        await this.extendObjectAsync(`${iobDeviceName}.configuration`, {
            type: 'channel',
            common: {
                name: 'Configuration'
            },
            native: {}
        });
        for (const entry of config.configurationKey) {
            const { role, type, value } = this.parseConfigurationValue(entry.value || '', entry.readonly);
            if (entry.key === 'SupportedFeatureProfiles' && entry.value && this.knownClients.has(deviceName)) {
                // Store the capabilities
                this.log.info(`Supported profiles by client "${deviceName}" are "${entry.value}"`);
                this.knownClients.get(deviceName).supportedProfiles = entry.value.replace(/\s/g, '').split(',');
            }
            await this.extendObjectAsync(`${iobDeviceName}.configuration.${entry.key}`, {
                type: 'state',
                common: {
                    name: entry.key,
                    type: type,
                    role: role,
                    write: !entry.readonly,
                    read: true
                },
                native: {}
            });
            await this.setStateAsync(`${iobDeviceName}.configuration.${entry.key}`, value, true);
        }
    }
    /**
     * Parses a configuration value and determines, data type, role and parsed value
     * @param value value of config attribute
     * @param readOnly readonly flag
     */
    parseConfigurationValue(value, readOnly) {
        let parsedValue = value;
        let role = 'text';
        let type = 'string';
        if (value === 'true') {
            parsedValue = true;
        }
        else if (value === 'false') {
            parsedValue = false;
        }
        if (value && !isNaN(Number(value))) {
            parsedValue = parseFloat(value);
            role = 'value';
            type = 'number';
        }
        if (typeof parsedValue === 'boolean') {
            type = 'boolean';
            if (readOnly) {
                role = 'indicator';
            }
            else {
                role = 'switch';
            }
        }
        return { role, value: parsedValue, type };
    }
    /**
     * Creates the corresponding state objects for a device
     * @param device name of the wallbox device
     * @param connectorId id of the connector
     */
    async createConnectorObjects(device, connectorId) {
        const iobDevice = device.replace(/\./g, '_');
        await this.extendObjectAsync(`${iobDevice}.${connectorId}`, {
            type: 'channel',
            common: {
                name: connectorId ? `Connector ${connectorId}` : 'Main'
            },
            native: {}
        }, { preserve: { common: ['name'] } });
        const connectorObjects = (0, states_1.getConnectorObjects)(connectorId);
        for (const obj of connectorObjects) {
            const id = obj._id;
            obj._id = `${iobDevice}.${connectorId}.${obj._id}`;
            await this.extendObjectAsync(obj._id, obj, { preserve: { common: ['name'] } });
            obj._id = id;
        }
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    async onUnload(callback) {
        try {
            // @ts-expect-error 3rd party typings are not perfect (yet?) ;-)
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
     * Sets given data to the ioBroker storage and ensures objects are existing
     *
     * @param device id of the device
     * @param messageId id of the data transfer
     * @param data actual data
     */
    async synchronizeDataTransfer(device, messageId, data) {
        messageId = messageId || 'unknown';
        data = data || '';
        if (!this.knownDataTransfer.size) {
            await this.extendObjectAsync(`${device.replace(/\./g, '_')}.dataTransfer`, {
                type: 'channel',
                common: {
                    name: `Data Transfers of ${device}`
                },
                native: {}
            });
        }
        if (!this.knownDataTransfer.has(messageId)) {
            await this.extendObjectAsync(`${device.replace(/\./g, '_')}.dataTransfer.${messageId}`, {
                type: 'state',
                common: {
                    name: `Data Transfers for message "${messageId}"`,
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false
                },
                native: {}
            });
            this.knownDataTransfer.add(messageId);
        }
        await this.setStateAsync(`${device.replace(/\./g, '_')}.dataTransfer.${messageId}`, data, true);
    }
    /**
     * Is called if a subscribed state changes
     */
    async onStateChange(id, state) {
        var _a, _b;
        if (!state || state.ack) {
            // if state deleted or already acknowledged
            return;
        }
        // handle state change
        const idArr = id.split('.');
        const deviceName = idArr[2];
        const channel = idArr[3];
        const connectorId = parseInt(channel);
        const functionality = idArr[4];
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
        if (functionality === 'transactionActive') {
            // enable/disable transaction
            let command;
            if (state.val) {
                // enable
                const cmdObj = {
                    connectorId,
                    idTag: 'ioBroker'
                };
                const limitState = await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimit`);
                if ((limitState === null || limitState === void 0 ? void 0 : limitState.val) && typeof limitState.val === 'number') {
                    const limitType = (await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimitType`))
                        .val;
                    cmdObj.chargingProfile = {
                        chargingProfileId: 1,
                        stackLevel: 0,
                        chargingProfilePurpose: 'TxDefaultProfile',
                        chargingProfileKind: 'Recurring',
                        recurrencyKind: 'Daily',
                        chargingSchedule: {
                            duration: 86400,
                            startSchedule: '2013-01-01T00:00Z',
                            chargingRateUnit: limitType,
                            chargingSchedulePeriod: [
                                {
                                    startPeriod: 0,
                                    limit: limitState.val // e.g. 12 for 12 A
                                }
                            ]
                            // minChargingRate: 12 // if needed we add it
                        }
                    };
                    const numberPhases = await this._getNumberOfPhases(deviceName, connectorId);
                    if (numberPhases) {
                        cmdObj.chargingProfile.chargingSchedule.chargingSchedulePeriod[0].numberPhases = numberPhases;
                    }
                }
                this.log.debug(`Sending RemoteStartTransaction for ${deviceName}.${connectorId}: ${JSON.stringify(cmdObj)}`);
                command = new ocpp_eliftech_1.OCPPCommands.RemoteStartTransaction(cmdObj);
            }
            else {
                // stop the transaction
                this.log.debug(`Sending RemoteStopTransaction for ${deviceName}.${connectorId}`);
                command = new ocpp_eliftech_1.OCPPCommands.RemoteStopTransaction({
                    transactionId: connectorId
                });
            }
            try {
                const res = (await client.connection.send(command, CALL_MESSAGE));
                if (res.status === 'Rejected') {
                    this.log.warn(`${state.val ? 'Starting' : 'Stopping'} transaction has been rejected by charge point`);
                }
            }
            catch (e) {
                this.log.error(`Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`);
            }
        }
        else if (functionality === 'availability') {
            try {
                this.log.debug(`Sending ChangeAvailability for ${deviceName}.${connectorId}: ${state.val ? 'Operative' : 'Inoperative'}`);
                const res = (await client.connection.send(new ocpp_eliftech_1.OCPPCommands.ChangeAvailability({
                    connectorId,
                    type: state.val ? 'Operative' : 'Inoperative'
                }), CALL_MESSAGE));
                if (res.status !== 'Rejected') {
                    await this.setStateAsync(`${deviceName}.${connectorId}.availability`, state.val, true);
                }
            }
            catch (e) {
                this.log.error(`Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`);
            }
        }
        else if (functionality === 'chargeLimit') {
            if (typeof state.val !== 'number') {
                return;
            }
            try {
                const limitType = (await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimitType`))
                    .val;
                const numberPhases = await this._getNumberOfPhases(deviceName, connectorId);
                await this.changeChargeLimit({
                    client,
                    limitType,
                    limit: state.val,
                    deviceName,
                    connectorId,
                    numberPhases
                });
            }
            catch (e) {
                this.log.error(`Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`);
            }
        }
        else if (functionality === 'numberPhases') {
            if (typeof state.val !== 'number') {
                return;
            }
            try {
                const limitType = (await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimitType`))
                    .val;
                const limit = (_a = (await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimit`))) === null || _a === void 0 ? void 0 : _a.val;
                if (typeof limit !== 'number') {
                    this.log.error(`Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": No chargeLimit set`);
                    return;
                }
                await this.changeChargeLimit({
                    client,
                    limitType,
                    limit,
                    deviceName,
                    connectorId,
                    numberPhases: state.val
                });
            }
            catch (e) {
                this.log.error(`Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`);
            }
        }
        else if (functionality === 'chargeLimitType') {
            if (typeof state.val !== 'string') {
                return;
            }
            await this.extendObjectAsync(`${deviceName}.${connectorId}.chargeLimit`, { common: { unit: state.val } });
        }
        else if (functionality === 'hardReset' || functionality === 'softReset') {
            try {
                const res = (await client.connection.send(new ocpp_eliftech_1.OCPPCommands.Reset({ type: functionality === 'softReset' ? 'Soft' : 'Hard' }), CALL_MESSAGE));
                if (res.status === 'Rejected') {
                    this.log.warn(`${functionality} has been rejected by charge point`);
                }
            }
            catch (e) {
                this.log.error(`Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`);
            }
        }
        else if (functionality === 'authList') {
            const authList = (_b = state.val) !== null && _b !== void 0 ? _b : '';
            if (typeof authList !== 'string') {
                return;
            }
            try {
                await this.syncAuthList(client, authList);
            }
            catch (e) {
                this.log.error(`Could not synchronize Local Authentication List: ${e.message}`);
            }
        }
        else if (channel === 'configuration') {
            if (state.val === null) {
                return;
            }
            const value = state.val.toString();
            this.log.info(`Changing configuration (device: ${deviceName}) of "${functionality}" to "${value}"`);
            try {
                const res = (await client.connection.send(new ocpp_eliftech_1.OCPPCommands.ChangeConfiguration({ key: functionality, value }), CALL_MESSAGE));
                if (res.status === 'Accepted') {
                    await this.setStateAsync(`${deviceName}.configuration.${functionality}`, state.val, true);
                }
                else if (res.status === 'RebootRequired') {
                    this.log.info(`Reboot Required: Configuration changed (device: ${deviceName}) of "${functionality}" to "${state.val}"`);
                }
                else {
                    this.log.warn(`Cannot change confiuration of ${deviceName} (key: ${functionality}, value: ${state.val}): ${res.status}`);
                }
            }
            catch (e) {
                this.log.error(`Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`);
            }
        }
        else {
            this.log.warn(`State change of ${deviceName}.${connectorId}.${functionality} not implemented`);
        }
    }
    /**
     * Determines user-configured number of phases for charging
     *
     * @param deviceName name of device in objects
     * @param connectorId Id of the connector
     */
    async _getNumberOfPhases(deviceName, connectorId) {
        var _a;
        let numberPhases;
        try {
            numberPhases = (_a = (await this.getStateAsync(`${deviceName}.${connectorId}.numberPhases`))) === null || _a === void 0 ? void 0 : _a.val;
        }
        catch (e) {
            this.log.warn(`Could not determine number of phases: ${e.message}`);
        }
        return typeof numberPhases === 'number' ? numberPhases : undefined;
    }
    /**
     * Sets the meter values and creates objects if non existing
     *
     * @param devName name of the device
     * @param connectorId the connector id
     * @param meterValues meter values object
     */
    async _setMeterValues(devName, connectorId, meterValues) {
        for (const value of meterValues.meterValue[0].sampledValue) {
            let id = `${devName}.${connectorId}.meterValues.`;
            let name = '';
            if (value.measurand) {
                id += value.measurand.replace(/\./g, '_');
                name = value.measurand;
            }
            if (value.phase) {
                id += value.measurand ? `_${value.phase}` : value.phase;
                name += value.measurand ? ` ${value.phase}` : value.phase;
            }
            if (!value.phase && !value.measurand) {
                id += 'unknown';
                name = 'Unknown';
            }
            await this.extendObjectAsync(id, {
                type: 'state',
                common: {
                    name: name,
                    role: 'value',
                    type: 'number',
                    read: true,
                    write: false,
                    unit: value.unit
                },
                native: value
            });
            await this.setStateAsync(id, parseFloat(value.value), true);
        }
    }
    /**
     * Waits for given ms
     * @param ms milliseconds to wait
     */
    async _wait(ms) {
        return new Promise(resolve => {
            setTimeout(() => resolve(), ms);
        });
    }
    /**
     * Changes the general charge limit
     *
     * @param options the charge limit options
     */
    async changeChargeLimit(options) {
        const { client, connectorId, deviceName, limitType, limit, numberPhases } = options;
        this.log.debug(`Sending SetChargingProfile for ${deviceName}.${connectorId}`);
        const command = {
            connectorId,
            csChargingProfiles: {
                chargingProfileId: 1,
                stackLevel: 0,
                chargingProfilePurpose: 'TxDefaultProfile',
                chargingProfileKind: 'Recurring',
                recurrencyKind: 'Daily',
                chargingSchedule: {
                    duration: 86400,
                    startSchedule: '2013-01-01T00:00Z',
                    chargingRateUnit: limitType,
                    chargingSchedulePeriod: [
                        {
                            startPeriod: 0,
                            limit // e.g. 12 for 12 A
                        }
                    ]
                    // minChargingRate: 12 // if needed we add it
                }
            }
        };
        if (numberPhases) {
            command.csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].numberPhases = numberPhases;
        }
        const res = (await client.connection.send(new ocpp_eliftech_1.OCPPCommands.SetChargingProfile(command), CALL_MESSAGE));
        if (res.status === 'Accepted') {
            await this.setStateAsync(`${deviceName}.${connectorId}.chargeLimitType`, limitType, true);
            await this.setStateAsync(`${deviceName}.${connectorId}.chargeLimit`, limit, true);
            await this.setStateAsync(`${deviceName}.${connectorId}.numberPhases`, numberPhases !== null && numberPhases !== void 0 ? numberPhases : null, true);
        }
        else {
            this.log.warn(`Charge point responded with "${res.status}" on changing charge limit`);
        }
    }
    /**
     * Synchronize auth list with local client
     *
     * @param client the CentralSystemClient
     * @param authList csv string with tag ids
     */
    async syncAuthList(client, authList) {
        const { listVersion } = (await client.connection.send(new ocpp_eliftech_1.OCPPCommands.GetLocalListVersion({}), CALL_MESSAGE));
        authList = authList.replace(/\s/g, '');
        const idTags = authList.split(',');
        const localAuthorizationList = [];
        for (const idTag of idTags) {
            localAuthorizationList.push({ idTag, idTagInfo: { status: 'Accepted' } });
        }
        const res = (await client.connection.send(new ocpp_eliftech_1.OCPPCommands.SendLocalList({ listVersion, updateType: 'Full', localAuthorizationList }), CALL_MESSAGE));
        if (res.status === 'Accepted') {
            await this.setStateAsync(`${client.connection.url.replace(/\./g, '_')}.0.authList`, authList, true);
        }
        else {
            throw new Error(`Client has responded with status "${res.status}"`);
        }
    }
    /**
     * Remove states of non-supported profiles
     * @param deviceName name of the device
     * @param supportedProfiles supported profiles
     */
    async removeUnsupportedStates(deviceName, supportedProfiles) {
        var _a;
        const iobDeviceName = deviceName.replace(/\./g, '_');
        const SMART_CHARGING_STATE_IDS = ['numberPhases', 'chargeLimitType', 'chargeLimit'];
        const LOCAL_AUTH_LIST_STATE_IDS = ['authList'];
        const connectorIds = (_a = this.knownClients.get(deviceName)) === null || _a === void 0 ? void 0 : _a.connectorIds;
        if (!connectorIds) {
            return;
        }
        if (!supportedProfiles.includes('SmartCharging')) {
            this.log.info('Removing SmartCharging functionality as unsupported');
            for (const connectorId of connectorIds) {
                for (const id of SMART_CHARGING_STATE_IDS) {
                    try {
                        await this.delObjectAsync(`${iobDeviceName}.${connectorId}.${id}`);
                    }
                    catch (_b) {
                        // ignore
                    }
                }
            }
        }
        if (!supportedProfiles.includes('LocalAuthListManagement')) {
            this.log.info('Removing LocalAuthListManagement functionality as unsupported');
            for (const connectorId of connectorIds) {
                for (const id of LOCAL_AUTH_LIST_STATE_IDS) {
                    try {
                        await this.delObjectAsync(`${iobDeviceName}.${connectorId}.${id}`);
                    }
                    catch (_c) {
                        // ignore
                    }
                }
            }
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