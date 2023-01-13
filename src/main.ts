/*
 * Created with @iobroker/create-adapter v2.0.1
 */

import * as utils from '@iobroker/adapter-core';
import { getConnectorObjects, deviceObjects } from './lib/states';
import { BaseCommand, CentralSystem, OCPPCommands, OCPPConnection } from '@ampeco/ocpp-eliftech';
import {
    AuthorizeResponse,
    BootNotificationResponse,
    HeartbeatResponse,
    MeterValuesRequest,
    MeterValuesResponse,
    RemoteStartTransactionRequest,
    StartTransactionResponse,
    StatusNotificationRequest,
    StatusNotificationResponse,
    StopTransactionResponse,
    DataTransferRequest,
    DataTransferResponse,
    StartTransactionRequest,
    StopTransactionRequest,
    GetConfigurationResponse,
    ChangeAvailabilityResponse,
    RemoteStartTransactionResponse,
    RemoteStopTransactionResponse,
    SetChargingProfileResponse
} from '@ampeco/ocpp-eliftech/schemas';

/** limit can be in ampere or watts */
type LimitType = 'A' | 'W';

// cannot import the constants correctly, so define the necessary ones until fixed
const CALL_MESSAGE = 2; // REQ

interface KnownClient {
    connectorIds: number[];
}

class Ocpp extends utils.Adapter {
    private readonly clientTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private readonly knownClients: Map<string, KnownClient> = new Map();
    private server: CentralSystem | undefined;
    private readonly knownDataTransfer = new Set<string>();

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'ocpp'
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        // subscribe own states
        this.subscribeStates('*');

        this.log.info('Starting OCPP Server');

        // reset connection state
        await this.setStateAsync('info.connection', '', true);

        const validateConnection = (
            url: string,
            credentials: { name: string; pass: string } | undefined,
            protocol: 'http' | 'https',
            ocppProtocolVersion?: string
        ): Promise<[boolean, number, string]> => {
            this.log.debug(
                `Connection from "${url}" with credentials "${JSON.stringify(credentials)}", protocol: "${protocol}"${
                    ocppProtocolVersion ? `, OCPP: ${ocppProtocolVersion}` : ''
                }`
            );

            if (this.config.authentication) {
                if (
                    (this.config.username && this.config.username !== credentials?.name) ||
                    (this.config.password && this.config.password !== credentials?.pass)
                ) {
                    this.log.warn(`Client "${url}" provided incorrect credentials, connection denied`);
                    return Promise.resolve([false, 0, '']);
                }
            }

            this.log.info(
                `New valid connection from "${url}" (${protocol}${
                    ocppProtocolVersion ? `/${ocppProtocolVersion}` : ''
                })`
            );
            return Promise.resolve([true, 0, '']);
        };

        this.server = new CentralSystem({ validateConnection, wsOptions: {} });

        const port = await this.getPortAsync(this.config.port);

        this.server.listen(port);

        this.log.info(`Server listening on port ${port}`);

        /**
         * Called if client sends an error
         */
        this.server.onError = async (client, command, error) => {
            this.log.error(
                `Received error from "${client.connection.url}" with command "${JSON.stringify(command)}": ${
                    error.message
                }`
            );
        };

        /**
         * Called if client sends response error
         */
        this.server.onResponseError = async (client, command, response, error) => {
            this.log.error(
                `Received response error from "${client.connection.url}" with command "${JSON.stringify(
                    command
                )}" (response: ${JSON.stringify(response)}): ${error.message}`
            );
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
                this.knownClients.set(connection.url, { connectorIds: [] });
                // request all important values at start, do not await this
                this.requestNewClient(connection, command);

                // on connection, ensure objects for this device are existing
                await this.createDeviceObjects(connection.url);
                // device is now connected
                await this.setDeviceOnline(connection.url);
            }

            // we give 90 seconds to send next heartbeat - every response can count as heartbeat according to OCPP
            if (this.clientTimeouts.has(connection.url)) {
                clearTimeout(this.clientTimeouts.get(connection.url));
            }

            this.clientTimeouts.set(
                connection.url,
                setTimeout(() => this.timedOut(connection.url), 90000)
            );

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
                    const response: BootNotificationResponse = {
                        status: 'Accepted',
                        currentTime: new Date().toISOString(),
                        interval: 55
                    };
                    return response;
                }
                case 'Authorize': {
                    this.log.info(`Received Authorization Request from "${connection.url}"`);
                    const response: AuthorizeResponse = {
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                    return response;
                }
                case 'StartTransaction': {
                    const startCommand = command as unknown as StartTransactionRequest;
                    const connectorId = startCommand.connectorId;

                    this.log.info(`Received Start transaction from "${connection.url}.${connectorId}"`);
                    await this.setStateAsync(
                        `${devName}.${connectorId}.transactionStartMeter`,
                        startCommand.meterStart,
                        true
                    );
                    await this.setStateAsync(`${devName}.${connectorId}.transactionActive`, true, true);
                    const response: StartTransactionResponse = {
                        transactionId: connectorId,
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                    return response;
                }
                case 'StopTransaction': {
                    const stopCommand = command as unknown as StopTransactionRequest;
                    // we use connId as transactionId and vice versa
                    const connectorId = stopCommand.transactionId;

                    const startMeterState = await this.getStateAsync(`${devName}.${connectorId}.transactionStartMeter`);

                    this.log.info(`Received stop transaction from "${connection.url}.${connectorId}"`);

                    if (typeof startMeterState?.val === 'number') {
                        const consumption = stopCommand.meterStop - startMeterState.val;
                        await this.setStateAsync(
                            `${devName}.${connectorId}.lastTransactionConsumption`,
                            consumption,
                            true
                        );
                    }

                    await this.setStateAsync(
                        `${devName}.${connectorId}.transactionEndMeter`,
                        stopCommand.meterStop,
                        true
                    );
                    await this.setStateAsync(`${devName}.${connectorId}.transactionActive`, false, true);
                    const response: StopTransactionResponse = {
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                    return response;
                }
                case 'Heartbeat': {
                    this.log.debug(`Received heartbeat from "${connection.url}"`);

                    const response: HeartbeatResponse = {
                        currentTime: new Date().toISOString()
                    };
                    return response;
                }
                case 'StatusNotification': {
                    const statusCommand = command as unknown as StatusNotificationRequest;
                    const connectorId = statusCommand.connectorId;

                    this.log.info(
                        `Received Status Notification from "${connection.url}.${connectorId}": ${statusCommand.status}`
                    );

                    if (statusCommand.errorCode !== 'NoError') {
                        this.log.warn(
                            `Status from "${connection.url}.${connectorId}" contains an error: ${statusCommand.errorCode}`
                        );
                    }

                    // {"connectorId":1,"errorCode":"NoError","info":"","status":"Preparing",
                    // "timestamp":"2021-10-27T15:30:09Z","vendorId":"","vendorErrorCode":""}

                    if (!this.knownClients.get(connection.url)!.connectorIds.includes(connectorId)) {
                        this.knownClients.get(connection.url)!.connectorIds.push(connectorId);
                        await this.createConnectorObjects(connection.url, connectorId);
                    }

                    await this.setStateAsync(
                        `${devName}.${connectorId}.status`,
                        (command as unknown as StatusNotificationRequest).status,
                        true
                    );

                    const response: StatusNotificationResponse = {};
                    return response;
                }
                case 'MeterValues': {
                    const connectorId = (command as unknown as StatusNotificationRequest).connectorId;
                    this.log.info(`Received MeterValues from "${connection.url}.${connectorId}"`);

                    // {"connectorId":1,"transactionId":1,"meterValue":[{"timestamp":"2021-10-27T17:35:01Z",
                    // "sampledValue":[{"value":"4264","format":"Raw","location":"Outlet","context":"Sample.Periodic",
                    // "measurand":"Energy.Active.Import.Register","unit":"Wh"}]}]}
                    await this._setMeterValues(devName, connectorId, command as unknown as MeterValuesRequest);

                    const response: MeterValuesResponse = {};
                    return response;
                }
                case 'DataTransfer':
                    this.log.info(
                        `Received DataTransfer from "${connection.url}" with id "${
                            (command as unknown as DataTransferRequest).messageId
                        }": ${(command as unknown as DataTransferRequest).data}`
                    );
                    try {
                        await this.synchronizeDataTransfer(
                            devName,
                            (command as unknown as DataTransferRequest).messageId,
                            (command as unknown as DataTransferRequest).data
                        );
                    } catch (e: any) {
                        this.log.warn(`Could not synchronize transfer data: ${e.message}`);
                    }

                    const response: DataTransferResponse = { status: 'Accepted' };
                    return response;
                case 'GetConfiguration':
                    this.log.info(`Received GetConfiguration from "${connection.url}: ${JSON.stringify(command)}"`);
                    break;
                default:
                    this.log.warn(`Command not implemented from "${connection.url}": ${JSON.stringify(command)}`);
            }
        };
    }

    /**
     * Request BootNotification, StatusNotification and MeterValues
     * @param connection connection object
     * @param command command object
     */
    private async requestNewClient(connection: OCPPConnection, command: BaseCommand): Promise<void> {
        // we want to request boot notification and status and meter values to have everything up to date again
        try {
            if (command.getCommandName() !== 'BootNotification') {
                // it's not a boot notification so request
                this.log.info(`Requesting BootNotification from "${connection.url}"`);
                await connection.send(
                    new OCPPCommands.TriggerMessage({
                        requestedMessage: 'BootNotification'
                    }),
                    CALL_MESSAGE
                );

                await this._wait(1_000);
            }

            if (command.getCommandName() !== 'StatusNotification') {
                // it's not a status notification so request
                this.log.info(`Requesting StatusNotification from "${connection.url}"`);
                await connection.send(
                    new OCPPCommands.TriggerMessage({
                        requestedMessage: 'StatusNotification'
                    }),
                    CALL_MESSAGE
                );

                await this._wait(1_000);
            }

            if (command.getCommandName() !== 'MeterValues') {
                this.log.info(`Requesting MeterValues from "${connection.url}"`);
                // TODO: add connectorId if known or request it also if new connector detected?
                // it's not MeterValues, so request
                await connection.send(
                    new OCPPCommands.TriggerMessage({
                        requestedMessage: 'MeterValues'
                    }),
                    CALL_MESSAGE
                );
                await this._wait(1_000);
            }

            if (command.getCommandName() !== 'GetConfiguration') {
                this.log.info(`Sending GetConfiguration to "${connection.url}"`);
                // it's not GetConfiguration try to request whole config
                const res = (await connection.send(
                    new OCPPCommands.GetConfiguration({}),
                    CALL_MESSAGE
                )) as GetConfigurationResponse;

                this.log.debug(`Recevied configuration from ${connection.url}: ${JSON.stringify(res)}`);
                await this.createConfigurationObjects(connection.url, res);
            }
        } catch (e: any) {
            this.log.warn(`Could not request states of "${connection.url}": ${e.message}`);
        }
    }

    /**
     * Is called if client timed out, sets connection to offline
     * @param device name of the wallbox device
     */
    private async timedOut(device: string): Promise<void> {
        this.log.warn(`Client "${device}" timed out`);
        if (this.knownClients.has(device)) {
            this.knownClients.delete(device);
        }

        await this.setStateAsync(`${device.replace(/\./g, '_')}.connected`, false, true);
        const connState = await this.getStateAsync('info.connection');
        if (connState?.val && typeof connState.val === 'string') {
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
    public async setDeviceOnline(device: string): Promise<void> {
        await this.setStateAsync(`${device.replace(/\./g, '_')}.connected`, true, true);

        const connState = await this.getStateAsync('info.connection');

        if (typeof connState?.val === 'string') {
            // if empty string make empty array
            const devices = connState.val ? connState.val.split(',') : [];
            if (devices.indexOf(device) === -1) {
                // device not yet in array
                devices.push(device);
                await this.setStateAsync('info.connection', devices.join(','), true);
            }
        } else {
            // just set device
            await this.setStateAsync('info.connection', device, true);
        }
    }

    /**
     * Creates the corresponding state objects for a device
     * @param device name of the wallbox device
     */
    public async createDeviceObjects(device: string): Promise<void> {
        await this.extendObjectAsync(
            device.replace(/\./g, '_'),
            {
                type: 'device',
                common: {
                    name: device
                },
                native: {}
            },
            { preserve: { common: ['name'] } }
        );

        for (const obj of deviceObjects) {
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
    public async createConfigurationObjects(deviceName: string, config: GetConfigurationResponse): Promise<void> {
        if (!config.configurationKey) {
            return;
        }

        deviceName = deviceName.replace(/\./g, '_');

        await this.extendObjectAsync(`${deviceName}.configuration`, {
            type: 'channel',
            common: {
                name: 'Configuration'
            },
            native: {}
        });

        for (const entry of config.configurationKey) {
            await this.extendObjectAsync(`${deviceName}.configuration.${entry.key}`, {
                type: 'state',
                common: {
                    name: entry.key,
                    type: 'string',
                    role: 'state',
                    write: !entry.readonly,
                    read: true
                },
                native: {}
            });

            await this.setStateAsync(`${deviceName}.configuration.${entry.key}`, entry.value || '', true);
        }
    }

    /**
     * Creates the corresponding state objects for a device
     * @param device name of the wallbox device
     * @param connectorId id of the connector
     */
    public async createConnectorObjects(device: string, connectorId: number): Promise<void> {
        await this.extendObjectAsync(
            `${device.replace(/\./g, '_')}.${connectorId}`,
            {
                type: 'channel',
                common: {
                    name: connectorId ? `Connector ${connectorId}` : 'Main'
                },
                native: {}
            },
            { preserve: { common: ['name'] } }
        );

        const connectorObjects = getConnectorObjects(connectorId);

        for (const obj of connectorObjects) {
            const id = obj._id;
            obj._id = `${device.replace(/\./g, '_')}.${connectorId}.${obj._id}`;
            await this.extendObjectAsync(obj._id, obj, { preserve: { common: ['name'] } });
            obj._id = id;
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private async onUnload(callback: () => void): Promise<void> {
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
        } catch {
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
    private async synchronizeDataTransfer(
        device: string,
        messageId: string | undefined,
        data: string | undefined
    ): Promise<void> {
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
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            // if state deleted or already acknowledged
            return;
        }

        // handle state change
        const idArr = id.split('.');
        const deviceName = idArr[2];
        const connectorId = parseInt(idArr[3]);
        const functionality = idArr[4];

        if (!this.server) {
            this.log.warn(`Cannot control "${deviceName}", because server is not running`);
            return;
        }

        const connState = await this.getStateAsync(`${deviceName}.connected`);
        const client = this.server.clients.find(client => {
            return client.connection.url.replace(/\./g, '_') === deviceName;
        });

        if (!connState?.val || !client) {
            this.log.warn(`Cannot control "${deviceName}", because not connected`);
            return;
        }

        if (functionality === 'transactionActive') {
            // enable/disable transaction

            let command;
            if (state.val) {
                // enable
                const cmdObj: RemoteStartTransactionRequest = {
                    connectorId,
                    idTag: await this._getIdTag(deviceName, connectorId)
                };

                const limitState = await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimit`);

                if (limitState?.val && typeof limitState.val === 'number') {
                    const limitType = (await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimitType`))!
                        .val as LimitType;

                    cmdObj.chargingProfile = {
                        chargingProfileId: 1,
                        stackLevel: 0, // some chargers only support 0
                        chargingProfilePurpose: 'TxDefaultProfile',
                        chargingProfileKind: 'Recurring',
                        recurrencyKind: 'Daily',
                        chargingSchedule: {
                            duration: 86400, // 24 hours
                            startSchedule: '2013-01-01T00:00Z',
                            chargingRateUnit: limitType, // Ampere or Watt
                            chargingSchedulePeriod: [
                                {
                                    startPeriod: 0, // up from 00:00 h (whole day)
                                    limit: limitState.val // e.g. 12 for 12 A
                                }
                            ]
                            // minChargingRate: 12 // if needed we add it
                        }
                    };
                }

                this.log.debug(
                    `Sending RemoteStartTransaction for ${deviceName}.${connectorId}: ${JSON.stringify(cmdObj)}`
                );
                command = new OCPPCommands.RemoteStartTransaction(cmdObj);
            } else {
                // stop the transaction
                this.log.debug(`Sending RemoteStopTransaction for ${deviceName}.${connectorId}`);

                command = new OCPPCommands.RemoteStopTransaction({
                    transactionId: connectorId
                });
            }

            try {
                const res = (await client.connection.send(command, CALL_MESSAGE)) as
                    | RemoteStartTransactionResponse
                    | RemoteStopTransactionResponse;

                if (res.status === 'Rejected') {
                    this.log.warn(
                        `${state.val ? 'Starting' : 'Stopping'} transcation has been rejected by charge point`
                    );
                }
            } catch (e: any) {
                this.log.error(
                    `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`
                );
            }
        } else if (functionality === 'availability') {
            try {
                this.log.debug(
                    `Sending ChangeAvailability for ${deviceName}.${connectorId}: ${
                        state.val ? 'Operative' : 'Inoperative'
                    }`
                );
                const res = (await client.connection.send(
                    new OCPPCommands.ChangeAvailability({
                        connectorId,
                        type: state.val ? 'Operative' : 'Inoperative'
                    }),
                    CALL_MESSAGE
                )) as ChangeAvailabilityResponse;

                if (res.status !== 'Rejected') {
                    await this.setStateAsync(`${deviceName}.${connectorId}.availability`, state.val, true);
                }
            } catch (e: any) {
                this.log.error(
                    `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`
                );
            }
        } else if (functionality === 'chargeLimit' && typeof state.val === 'number') {
            try {
                const limitType = (await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimitType`))!
                    .val as LimitType;
                this.log.debug(`Sending SetChargingProfile for ${deviceName}.${connectorId}`);
                const res = (await client.connection.send(
                    new OCPPCommands.SetChargingProfile({
                        connectorId,
                        csChargingProfiles: {
                            chargingProfileId: 1,
                            stackLevel: 0, // some chargers only support 0
                            chargingProfilePurpose: 'TxDefaultProfile', // default not only for transaction
                            chargingProfileKind: 'Recurring',
                            recurrencyKind: 'Daily',
                            chargingSchedule: {
                                duration: 86400, // 24 hours
                                startSchedule: '2013-01-01T00:00Z',
                                chargingRateUnit: limitType, // Ampere or Watt
                                chargingSchedulePeriod: [
                                    {
                                        startPeriod: 0, // up from 00:00 h (whole day)
                                        limit: state.val // e.g. 12 for 12 A
                                    }
                                ]
                                // minChargingRate: 12 // if needed we add it
                            }
                        }
                    }),
                    CALL_MESSAGE
                )) as SetChargingProfileResponse;

                if (res.status === 'Accepted') {
                    await this.setStateAsync(`${deviceName}.${connectorId}.chargeLimitType`, limitType, true);
                    await this.setStateAsync(`${deviceName}.${connectorId}.chargeLimit`, state.val, true);
                } else {
                    this.log.warn(`Charge point responded with "${res.status}" on changing charge limit`);
                }
            } catch (e: any) {
                this.log.error(
                    `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`
                );
            }
        } else if (functionality === 'chargeLimitType' && typeof state.val === 'string') {
            await this.extendObjectAsync(`${deviceName}.${connectorId}.chargeLimit`, { common: { unit: state.val } });
        }
    }

    /**
     * Sets the meter values and creates objects if non existing
     *
     * @param devName name of the device
     * @param connectorId the connector id
     * @param meterValues meter values object
     */
    private async _setMeterValues(
        devName: string,
        connectorId: number,
        meterValues: MeterValuesRequest
    ): Promise<void> {
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
    private async _wait(ms: number): Promise<void> {
        return new Promise(resolve => {
            setTimeout(() => resolve(), ms);
        });
    }

    /**
     * Determines the idTag for the connector
     * @param deviceName the name of the device
     * @param connectorId the connector id which will be used as fallback idTag
     */
    private async _getIdTag(deviceName: string, connectorId: number): Promise<string> {
        try {
            const state = await this.getStateAsync(`${deviceName}.${connectorId}.idTag`);

            if (state?.val) {
                return typeof state.val !== 'string' ? state.val.toString() : state.val;
            }
        } catch (e: any) {
            this.log.warn(`Could not determine idTag of "${deviceName}.${connectorId}": ${e.message}`);
        }

        return connectorId.toString();
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Ocpp(options);
} else {
    // otherwise start the instance directly
    (() => new Ocpp())();
}
