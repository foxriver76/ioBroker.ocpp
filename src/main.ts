/*
 * Created with @iobroker/create-adapter v2.0.1
 */

import * as utils from '@iobroker/adapter-core';
import { stateObjects } from './lib/states';
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
    StopTransactionResponse
} from '@ampeco/ocpp-eliftech/schemas';

// cannot import the constants correctly, so define the necessary ones until fixed
const CALL_MESSAGE = 2; // REQ

class Ocpp extends utils.Adapter {
    private readonly clientTimeouts: Record<string, NodeJS.Timeout>;
    private readonly knownClients: string[];
    private server: CentralSystem | undefined;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'ocpp'
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
                    this.log.info(`Received Start transaction from "${connection.url}"`);
                    await this.setStateAsync(`${devName}.transactionActive`, true, true);
                    const response: StartTransactionResponse = {
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
                    this.log.info(
                        `Received Status Notification from "${connection.url}": ${
                            (command as unknown as StatusNotificationRequest).status
                        }`
                    );
                    // {"connectorId":1,"errorCode":"NoError","info":"","status":"Preparing",
                    // "timestamp":"2021-10-27T15:30:09Z","vendorId":"","vendorErrorCode":""}
                    await this.setStateChangedAsync(
                        `${devName}.connectorId`,
                        (command as unknown as StatusNotificationRequest).connectorId,
                        true
                    );

                    await this.setStateAsync(
                        `${devName}.status`,
                        (command as unknown as StatusNotificationRequest).status,
                        true
                    );

                    const response: StatusNotificationResponse = {};
                    return response;
                }
                case 'MeterValues': {
                    this.log.info(`Received MeterValues from "${connection.url}"`);
                    // {"connectorId":1,"transactionId":1,"meterValue":[{"timestamp":"2021-10-27T17:35:01Z",
                    // "sampledValue":[{"value":"4264","format":"Raw","location":"Outlet","context":"Sample.Periodic",
                    // "measurand":"Energy.Active.Import.Register","unit":"Wh"}]}]}
                    await this._setMeterValues(devName, command as unknown as MeterValuesRequest);

                    const response: MeterValuesResponse = {};
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
     */
    private async requestNewClient(connection: OCPPConnection, command: BaseCommand): Promise<void> {
        // we want to request boot notification and status and meter values to ahve everything up to date again
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

                await this._wait(1000);
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

                await this._wait(1000);
            }

            if (command.getCommandName() !== 'MeterValues') {
                this.log.info(`Requesting MeterValues from "${connection.url}"`);
                // it's not MeterValues, so request
                await connection.send(
                    new OCPPCommands.TriggerMessage({
                        requestedMessage: 'MeterValues'
                    }),
                    CALL_MESSAGE
                );
                await this._wait(1000);
            }

            if (command.getCommandName() !== 'GetConfiguration') {
                this.log.info(`Sending GetConfiguration to "${connection.url}"`);
                // it's not GetConfiguration try to request whole config
                await connection.send(new OCPPCommands.GetConfiguration({}), CALL_MESSAGE);
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
        const idx = this.knownClients.indexOf(device);
        if (idx !== -1) {
            // client is in list, but now no longer active
            this.knownClients.splice(idx, 1);
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

        for (const obj of stateObjects) {
            const id = obj._id;
            obj._id = `${device.replace(/\./g, '_')}.${obj._id}`;
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
        const functionality = idArr[3];

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

        // we need connectorId
        const connIdState = await this.getStateAsync(`${deviceName}.connectorId`);

        if (!connIdState?.val || typeof connIdState.val !== 'number') {
            this.log.warn(`No valid connectorId for "${deviceName}"`);
            return;
        }

        const connectorId = connIdState.val;

        if (functionality === 'transactionActive') {
            // enable/disable transaction

            let command;
            if (state.val) {
                // enable
                const cmdObj: RemoteStartTransactionRequest = {
                    connectorId,
                    idTag: await this._getIdTag(deviceName, connectorId)
                };

                const limitState = await this.getStateAsync(`${deviceName}.chargeLimit`);

                if (limitState?.val && typeof limitState.val === 'number') {
                    cmdObj.chargingProfile = {
                        chargingProfileId: 1,
                        stackLevel: 0, // some chargers only support 0
                        chargingProfilePurpose: 'TxDefaultProfile',
                        chargingProfileKind: 'Recurring',
                        recurrencyKind: 'Daily',
                        chargingSchedule: {
                            duration: 86400, // 24 hours
                            startSchedule: '2013-01-01T00:00Z',
                            chargingRateUnit: 'A', // Ampere or Watt
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

                this.log.debug(`Sending RemoteStartTransaction for ${deviceName}: ${JSON.stringify(cmdObj)}`);
                command = new OCPPCommands.RemoteStartTransaction(cmdObj);
            } else {
                // disable
                this.log.debug(`Sending RemoteStopTransaction for ${deviceName}`);
                command = new OCPPCommands.RemoteStopTransaction({
                    transactionId: connectorId
                });
            }
            try {
                await client.connection.send(command, CALL_MESSAGE);
            } catch (e: any) {
                this.log.error(`Cannot execute command "${functionality}" for "${deviceName}": ${e.message}`);
            }
        } else if (functionality === 'availability') {
            try {
                this.log.debug(
                    `Sending ChangeAvailability for ${deviceName}: ${state.val ? 'Operative' : 'Inoperative'}`
                );
                await client.connection.send(
                    new OCPPCommands.ChangeAvailability({
                        connectorId,
                        type: state.val ? 'Operative' : 'Inoperative'
                    }),
                    CALL_MESSAGE
                );
            } catch (e: any) {
                this.log.error(`Cannot execute command "${functionality}" for "${deviceName}": ${e.message}`);
            }
        } else if (functionality === 'chargeLimit' && typeof state.val === 'number') {
            try {
                this.log.debug(`Sending SetChargingProfile for ${deviceName}`);
                await client.connection.send(
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
                                chargingRateUnit: 'A', // Ampere or Watt
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
                );
            } catch (e: any) {
                this.log.error(`Cannot execute command "${functionality}" for "${deviceName}": ${e.message}`);
            }
        }
    }

    /**
     * Sets the meter values and creates objects if non existing
     *
     * @param devName name of the device
     * @param meterValues meter values object
     */
    private async _setMeterValues(devName: string, meterValues: MeterValuesRequest): Promise<void> {
        for (const value of meterValues.meterValue[0].sampledValue) {
            let id = `${devName}.meterValues.`;
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
            const state = await this.getStateAsync(`${deviceName}.idTag`);

            if (state?.val) {
                return typeof state.val !== 'string' ? state.val.toString() : state.val;
            }
        } catch (e: any) {
            this.log.warn(`Could not determine idTag of "${deviceName}": ${e.message}`);
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
