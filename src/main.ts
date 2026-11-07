/*
 * Created with @iobroker/create-adapter v2.0.1
 */

import * as utils from '@iobroker/adapter-core';
import { getConnectorObjects, deviceObjects } from './lib/states';
import { OcppClientConnection, OcppServer } from './lib/ocpp-server';
import {
    AuthorizeRequest,
    AuthorizeResponse,
    BootNotificationResponse,
    ChangeAvailabilityRequest,
    ChangeAvailabilityResponse,
    ChangeConfigurationRequest,
    ChangeConfigurationResponse,
    DataTransferRequest,
    DataTransferResponse,
    DiagnosticsStatusNotificationRequest,
    DiagnosticsStatusNotificationResponse,
    FirmwareStatusNotificationRequest,
    FirmwareStatusNotificationResponse,
    GetConfigurationRequest,
    GetConfigurationResponse,
    GetLocalListVersionRequest,
    GetLocalListVersionResponse,
    HeartbeatResponse,
    MeterValuesRequest,
    MeterValuesResponse,
    RemoteStartTransactionRequest,
    RemoteStartTransactionResponse,
    RemoteStopTransactionRequest,
    RemoteStopTransactionResponse,
    ResetRequest,
    ResetResponse,
    SecurityEventNotificationRequest,
    SecurityEventNotificationResponse,
    SendLocalListRequest,
    SendLocalListResponse,
    SetChargingProfileRequest,
    SetChargingProfileResponse,
    StartTransactionRequest,
    StartTransactionResponse,
    StatusNotificationRequest,
    StatusNotificationResponse,
    StopTransactionRequest,
    StopTransactionResponse,
    TriggerMessageRequest,
    TriggerMessageResponse
} from './lib/ocpp-types';

/** limit can be in ampere or watts */
type LimitType = 'A' | 'W';

interface KnownClient {
    connectorIds: number[];
    supportedProfiles?: string[];
    /** Maps connectorId -> active transactionId */
    activeTransactions: Map<number, number>;
}

interface ChangeChargeLimitOptions {
    /** Limit in watts or ampere according to type */
    limit: number;
    /** Ampere or Watt */
    limitType: LimitType;
    /** Number of phases 1 to 3 */
    numberPhases?: number;
    /** Name of device according to objects */
    deviceName: string;
    /** ID of the connector */
    connectorId: number;
    /** Client connection for this charge point */
    connection: OcppClientConnection;
}

type ConfigurationRole = 'text' | 'value' | 'switch' | 'indicator';
type ConfigurationType = 'string' | 'number' | 'boolean';

interface ParsedConfigurationAttribute {
    value: string | number | boolean;
    type: ConfigurationType;
    role: ConfigurationRole;
}

class Ocpp extends utils.Adapter {
    private readonly clientTimeouts: Map<string, ioBroker.Timeout> = new Map();
    private readonly knownClients: Map<string, KnownClient> = new Map();
    private server: OcppServer | undefined;
    private readonly knownDataTransfer = new Set<string>();
    private nextTransactionId = 1;

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
     * Converts a raw connection URL (e.g. "/EVB-123.45") into the ioBroker device ID
     * Respects `config.stripLeadingSlash` (Issue #60) while keeping 100% backward compatibility by default
     *
     * @param url raw connection URL
     */
    private getDeviceId(url: string): string {
        let normalized = url.replace(/\./g, '_');
        if (this.config.stripLeadingSlash) {
            normalized = normalized.replace(/^\/+/, '');
        }
        return normalized || 'chargepoint';
    }

    /**
     * Normalizes an OCPP feature profile name for comparison (e.g. "Smart Charging" -> "smartcharging")
     *
     * @param profile raw profile name
     */
    private normalizeProfileName(profile: string): string {
        return profile.replace(/[\s_-]/g, '').toLowerCase();
    }

    /**
     * Checks whether a list of supported profiles includes the requested profile
     *
     * @param supportedProfiles list of supported profiles from charge point
     * @param targetProfile profile name to check (e.g. "SmartCharging")
     */
    private hasProfile(supportedProfiles: string[], targetProfile: string): boolean {
        const target = this.normalizeProfileName(targetProfile);
        return supportedProfiles.some(p => this.normalizeProfileName(p) === target);
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        try {
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
                    `Connection from "${url}" with credentials "${JSON.stringify(
                        credentials
                    )}", protocol: "${protocol}"${ocppProtocolVersion ? `, OCPP: ${ocppProtocolVersion}` : ''}`
                );

                if (this.config.authentication) {
                    if (
                        (this.config.username && this.config.username !== credentials?.name) ||
                        (this.config.password && this.config.password !== credentials?.pass)
                    ) {
                        this.log.warn(`Client "${url}" provided incorrect credentials, connection denied`);
                        return Promise.resolve([false, 401, 'Unauthorized']);
                    }
                }

                this.log.info(
                    `New valid connection from "${url}" (${protocol}${
                        ocppProtocolVersion ? `/${ocppProtocolVersion}` : ''
                    })`
                );

                // sometimes a reconnect happens without time out - ensure to handle as new client (request states etc)
                if (this.knownClients.has(url)) {
                    this.knownClients.delete(url);
                }

                return Promise.resolve([true, 200, 'OK']);
            };

            this.server = new OcppServer({
                validateConnection,
                supportedProtocols: ['ocpp1.6']
            });

            const port = await this.getPortAsync(this.config.port);

            await this.server.listen(port);

            this.log.info(`Server listening on port ${port}`);

            this.server.onClientError = (client, action, error): void => {
                this.log.error(
                    `Received error from "${client.url}"${action ? ` (command "${action}")` : ''}: ${error.message}`
                );
            };

            this.server.onRequest = async (
                client: OcppClientConnection,
                action: string,
                payload: Record<string, unknown>
            ): Promise<Record<string, unknown>> => {
                const url = client.url;
                const devName = this.getDeviceId(url);

                // we received a new command, first check if the client is known to us
                if (!this.knownClients.has(url)) {
                    this.log.info(`New device connected: "${url}"`);
                    this.knownClients.set(url, {
                        connectorIds: [0],
                        activeTransactions: new Map()
                    });

                    // on connection, ensure objects for this device are existing
                    await this.createDeviceObjects(url);
                    // device is now connected
                    await this.setDeviceOnline(url);
                    // Every device has a 0 connector
                    await this.createConnectorObjects(url, 0);

                    // request all important values at start, do not await this
                    void this.requestNewClient(client, action);
                }

                // we give 90 seconds to send next heartbeat - every request can count as heartbeat according to OCPP
                const prevTimeout = this.clientTimeouts.get(url);
                if (prevTimeout) {
                    this.clearTimeout(prevTimeout);
                }

                const timeoutHandle = this.setTimeout(() => {
                    void this.timedOut(url);
                }, 90_000);
                if (timeoutHandle) {
                    this.clientTimeouts.set(url, timeoutHandle);
                }

                // for debug purposes log whole command here
                this.log.debug(`Received ${action} from "${url}": ${JSON.stringify(payload)}`);

                switch (action) {
                    case 'BootNotification': {
                        this.log.info(`Received boot notification from "${url}"`);

                        // device booted, extend native to object
                        await this.extendObjectAsync(devName, {
                            native: payload
                        });

                        // we are requesting heartbeat every 55 seconds
                        const response: BootNotificationResponse = {
                            status: 'Accepted',
                            currentTime: new Date().toISOString(),
                            interval: 55
                        };
                        return response as unknown as Record<string, unknown>;
                    }
                    case 'Authorize': {
                        const authCommand = payload as unknown as AuthorizeRequest;

                        this.log.info(`Received Authorization Request from "${url}" with idTag "${authCommand.idTag}"`);

                        const state = await this.getStateAsync(`${devName}.0.authList`);

                        let status: AuthorizeResponse['idTagInfo']['status'] = 'Accepted';

                        if (typeof state?.val === 'string' && state.val.trim().length > 0) {
                            const idTags = state.val.replace(/\s/g, '').split(',');

                            if (!idTags.includes(authCommand.idTag)) {
                                status = 'Invalid';
                                this.log.warn(`ID Tag "${authCommand.idTag}" has been rejected`);
                            }
                        }

                        const response: AuthorizeResponse = {
                            idTagInfo: {
                                status
                            }
                        };
                        return response as unknown as Record<string, unknown>;
                    }
                    case 'StartTransaction': {
                        const startCommand = payload as unknown as StartTransactionRequest;
                        const connectorId = startCommand.connectorId;
                        const knownClient = this.knownClients.get(url);

                        if (knownClient && !knownClient.connectorIds.includes(connectorId)) {
                            knownClient.connectorIds.push(connectorId);
                            await this.createConnectorObjects(url, connectorId);
                        }

                        const transactionId = this.nextTransactionId++;
                        knownClient?.activeTransactions.set(connectorId, transactionId);

                        this.log.info(
                            `Received Start transaction from "${url}.${connectorId}" (transactionId: ${transactionId})`
                        );

                        await this.setStateAsync(`${devName}.${connectorId}.idTag`, startCommand.idTag, true);
                        await this.setStateAsync(
                            `${devName}.${connectorId}.transactionStartMeter`,
                            startCommand.meterStart,
                            true
                        );
                        await this.setStateAsync(`${devName}.${connectorId}.transactionActive`, true, true);

                        const response: StartTransactionResponse = {
                            transactionId,
                            idTagInfo: {
                                status: 'Accepted'
                            }
                        };
                        return response as unknown as Record<string, unknown>;
                    }
                    case 'StopTransaction': {
                        const stopCommand = payload as unknown as StopTransactionRequest;
                        const knownClient = this.knownClients.get(url);

                        // Resolve connectorId from tracked activeTransactions, falling back to transactionId if matching
                        let connectorId = stopCommand.transactionId;
                        if (knownClient) {
                            for (const [connId, txId] of knownClient.activeTransactions.entries()) {
                                if (txId === stopCommand.transactionId) {
                                    connectorId = connId;
                                    knownClient.activeTransactions.delete(connId);
                                    break;
                                }
                            }
                        }

                        if (stopCommand.idTag) {
                            await this.setStateAsync(`${devName}.${connectorId}.idTag`, stopCommand.idTag, true);
                        }

                        const startMeterState = await this.getStateAsync(
                            `${devName}.${connectorId}.transactionStartMeter`
                        );

                        this.log.info(`Received stop transaction from "${url}.${connectorId}"`);

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
                        return response as unknown as Record<string, unknown>;
                    }
                    case 'Heartbeat': {
                        this.log.debug(`Received heartbeat from "${url}"`);

                        const response: HeartbeatResponse = {
                            currentTime: new Date().toISOString()
                        };
                        return response as unknown as Record<string, unknown>;
                    }
                    case 'StatusNotification': {
                        const statusCommand = payload as unknown as StatusNotificationRequest;
                        const connectorId = statusCommand.connectorId;

                        this.log.info(
                            `Received Status Notification from "${url}.${connectorId}": ${statusCommand.status}`
                        );

                        if (statusCommand.errorCode && statusCommand.errorCode !== 'NoError') {
                            this.log.warn(
                                `Status from "${url}.${connectorId}" contains an error: ${statusCommand.errorCode}`
                            );
                        }

                        const knownClient = this.knownClients.get(url);
                        if (knownClient && !knownClient.connectorIds.includes(connectorId)) {
                            knownClient.connectorIds.push(connectorId);
                            await this.createConnectorObjects(url, connectorId);
                        }

                        await this.setStateAsync(`${devName}.${connectorId}.status`, statusCommand.status, true);

                        const response: StatusNotificationResponse = {};
                        return response;
                    }
                    case 'MeterValues': {
                        const meterValuesCommand = payload as unknown as MeterValuesRequest;
                        const connectorId = meterValuesCommand.connectorId;
                        this.log.info(`Received MeterValues from "${url}.${connectorId}"`);

                        const knownClient = this.knownClients.get(url);
                        if (knownClient && !knownClient.connectorIds.includes(connectorId)) {
                            knownClient.connectorIds.push(connectorId);
                            await this.createConnectorObjects(url, connectorId);
                        }

                        await this._setMeterValues(devName, connectorId, meterValuesCommand);

                        const response: MeterValuesResponse = {};
                        return response;
                    }
                    case 'DataTransfer': {
                        const dataTransferCommand = payload as unknown as DataTransferRequest;
                        this.log.info(
                            `Received DataTransfer from "${url}" with id "${dataTransferCommand.messageId}": ${dataTransferCommand.data}`
                        );
                        try {
                            await this.synchronizeDataTransfer(
                                devName,
                                dataTransferCommand.messageId,
                                dataTransferCommand.data
                            );
                        } catch (e: any) {
                            this.log.warn(`Could not synchronize transfer data: ${e.message}`);
                        }

                        const response: DataTransferResponse = { status: 'Accepted' };
                        return response as unknown as Record<string, unknown>;
                    }
                    case 'DiagnosticsStatusNotification': {
                        const diagCmd = payload as unknown as DiagnosticsStatusNotificationRequest;
                        this.log.info(`Received DiagnosticsStatusNotification from "${url}": ${diagCmd.status}`);
                        const response: DiagnosticsStatusNotificationResponse = {};
                        return response;
                    }
                    case 'FirmwareStatusNotification': {
                        const fwCmd = payload as unknown as FirmwareStatusNotificationRequest;
                        this.log.info(`Received FirmwareStatusNotification from "${url}": ${fwCmd.status}`);
                        const response: FirmwareStatusNotificationResponse = {};
                        return response;
                    }
                    case 'SecurityEventNotification': {
                        const secCmd = payload as unknown as SecurityEventNotificationRequest;
                        this.log.info(
                            `Received SecurityEventNotification from "${url}": ${secCmd.type}${
                                secCmd.techInfo ? ` (${secCmd.techInfo})` : ''
                            }`
                        );
                        const response: SecurityEventNotificationResponse = {};
                        return response;
                    }
                    default:
                        this.log.warn(`Command not implemented from "${url}": ${action} (${JSON.stringify(payload)})`);
                        return {};
                }
            };
        } catch (e: any) {
            this.log.error(`Failed to start OCPP server: ${e.message}`);
        }
    }

    /**
     * Request configuration (and explicitly query SupportedFeatureProfiles if truncated by GetConfigurationMaxKeys, Issue #65)
     *
     * @param connection the OCPP client connection
     */
    private async requestConfiguration(connection: OcppClientConnection): Promise<void> {
        this.log.info(`Sending GetConfiguration to "${connection.url}"`);
        const res = await connection.sendCommand<GetConfigurationRequest, GetConfigurationResponse>(
            'GetConfiguration',
            {}
        );

        this.log.debug(`Received configuration from ${connection.url}: ${JSON.stringify(res)}`);
        await this.createConfigurationObjects(connection.url, res);

        // Issue #65: If charge point truncated response due to GetConfigurationMaxKeys, query SupportedFeatureProfiles explicitly
        const hasSupportedProfilesKey = (res.configurationKey || []).some(
            entry => entry.key === 'SupportedFeatureProfiles'
        );
        if (!hasSupportedProfilesKey) {
            try {
                this.log.debug(`Explicitly requesting SupportedFeatureProfiles from "${connection.url}"`);
                const profileRes = await connection.sendCommand<GetConfigurationRequest, GetConfigurationResponse>(
                    'GetConfiguration',
                    { key: ['SupportedFeatureProfiles'] }
                );
                await this.createConfigurationObjects(connection.url, profileRes);
            } catch (e: any) {
                this.log.debug(
                    `Could not explicitly query SupportedFeatureProfiles from "${connection.url}": ${e.message}`
                );
            }
        }
    }

    /**
     * Request BootNotification, StatusNotification and MeterValues
     *
     * @param connection connection object
     * @param initialAction initial action name
     */
    private async requestNewClient(connection: OcppClientConnection, initialAction: string): Promise<void> {
        // wait initially
        await this._wait(1_000);

        // we want to request boot notification and status and meter values to have everything up to date again
        try {
            if (initialAction !== 'BootNotification') {
                this.log.info(`Requesting BootNotification from "${connection.url}"`);
                await connection.sendCommand<TriggerMessageRequest, TriggerMessageResponse>('TriggerMessage', {
                    requestedMessage: 'BootNotification'
                });

                await this._wait(1_000);
            }

            if (initialAction !== 'StatusNotification') {
                this.log.info(`Requesting StatusNotification from "${connection.url}"`);
                await connection.sendCommand<TriggerMessageRequest, TriggerMessageResponse>('TriggerMessage', {
                    requestedMessage: 'StatusNotification'
                });

                await this._wait(1_000);
            }

            if (initialAction !== 'MeterValues') {
                this.log.info(`Requesting MeterValues from "${connection.url}"`);
                await connection.sendCommand<TriggerMessageRequest, TriggerMessageResponse>('TriggerMessage', {
                    requestedMessage: 'MeterValues'
                });

                await this._wait(1_000);
            }
        } catch (e: any) {
            this.log.warn(`Could not request states of "${connection.url}": ${e.message}`);
        }

        try {
            await this.requestConfiguration(connection);
            const supportedProfiles = this.knownClients.get(connection.url)?.supportedProfiles;
            // Only remove unsupported states if SupportedFeatureProfiles was actually reported by the charger (#65)
            if (supportedProfiles && supportedProfiles.length > 0) {
                await this.removeUnsupportedStates(connection.url, supportedProfiles);
            }
        } catch (e: any) {
            this.log.error(`Could not request configuration of ${connection.url}: ${e.message}`);
        }
    }

    /**
     * Is called if client timed out, sets connection to offline
     *
     * @param device raw URL of the wallbox device
     */
    private async timedOut(device: string): Promise<void> {
        try {
            this.log.warn(`Client "${device}" timed out`);
            if (this.knownClients.has(device)) {
                this.knownClients.delete(device);
            }
            this.clientTimeouts.delete(device);

            const devId = this.getDeviceId(device);
            await this.setStateAsync(`${devId}.connected`, false, true);
            const connState = await this.getStateAsync('info.connection');
            if (connState?.val && typeof connState.val === 'string') {
                const devices = connState.val.split(',');
                const idx = devices.indexOf(device);
                if (idx !== -1) {
                    devices.splice(idx, 1);
                    await this.setStateAsync('info.connection', devices.join(','), true);
                }
            }
        } catch (e: any) {
            this.log.error(`Error handling timeout for "${device}": ${e.message}`);
        }
    }

    /**
     * Sets the corresponding online states
     *
     * @param device raw URL of the wallbox device
     */
    private async setDeviceOnline(device: string): Promise<void> {
        const devId = this.getDeviceId(device);
        await this.setStateAsync(`${devId}.connected`, true, true);

        const connState = await this.getStateAsync('info.connection');

        if (typeof connState?.val === 'string') {
            const devices = connState.val ? connState.val.split(',') : [];
            if (devices.indexOf(device) === -1) {
                devices.push(device);
                await this.setStateAsync('info.connection', devices.join(','), true);
            }
        } else {
            await this.setStateAsync('info.connection', device, true);
        }
    }

    /**
     * Creates the corresponding state objects for a device
     *
     * @param device raw URL of the wallbox device
     */
    private async createDeviceObjects(device: string): Promise<void> {
        const devId = this.getDeviceId(device);
        await this.extendObjectAsync(
            devId,
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
            const fullId = `${devId}.${obj._id}`;
            await this.extendObjectAsync(fullId, { ...obj, _id: fullId }, { preserve: { common: ['name'] } });
        }
    }

    /**
     * Creates configuration objects and states accordingly
     *
     * @param deviceName raw URL of the wallbox device
     * @param config the config object
     */
    private async createConfigurationObjects(deviceName: string, config: GetConfigurationResponse): Promise<void> {
        if (!config.configurationKey) {
            return;
        }

        const iobDeviceName = this.getDeviceId(deviceName);

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
                this.log.info(`Supported profiles by client "${deviceName}" are "${entry.value}"`);
                this.knownClients.get(deviceName)!.supportedProfiles = entry.value
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean);
            }

            await this.extendObjectAsync(`${iobDeviceName}.configuration.${entry.key}`, {
                type: 'state',
                common: {
                    name: entry.key,
                    type: type,
                    role: role,
                    write: !entry.readonly,
                    read: true,
                    def: type === 'number' ? 0 : type === 'boolean' ? false : ''
                },
                native: {}
            });

            await this.setStateAsync(`${iobDeviceName}.configuration.${entry.key}`, value, true);
        }
    }

    /**
     * Parses a configuration value and determines data type, role and parsed value
     *
     * @param value value of config attribute
     * @param readOnly readonly flag
     */
    private parseConfigurationValue(value: string, readOnly: boolean): ParsedConfigurationAttribute {
        let parsedValue: string | number | boolean = value;
        let role: ConfigurationRole = 'text';
        let type: ConfigurationType = 'string';

        if (value === 'true') {
            parsedValue = true;
        } else if (value === 'false') {
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
            } else {
                role = 'switch';
            }
        }

        return { role, value: parsedValue, type };
    }

    /**
     * Creates the corresponding state objects for a device connector
     *
     * @param device raw URL of the wallbox device
     * @param connectorId id of the connector
     */
    private async createConnectorObjects(device: string, connectorId: number): Promise<void> {
        const iobDevice = this.getDeviceId(device);

        await this.extendObjectAsync(
            `${iobDevice}.${connectorId}`,
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
            const fullId = `${iobDevice}.${connectorId}.${obj._id}`;
            await this.extendObjectAsync(fullId, { ...obj, _id: fullId }, { preserve: { common: ['name'] } });
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private async onUnload(callback: () => void): Promise<void> {
        try {
            if (this.server) {
                await this.server.close();
                this.server = undefined;
            }

            // clear all timeouts using Map iteration (fixes Object.entries bug on Map)
            for (const [device, timeout] of this.clientTimeouts.entries()) {
                await this.setStateAsync(`${this.getDeviceId(device)}.connected`, false, true);
                this.clearTimeout(timeout);
            }
            this.clientTimeouts.clear();

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
        messageId = (messageId || 'unknown').replace(/\./g, '_');
        data = data || '';

        if (!this.knownDataTransfer.size) {
            await this.extendObjectAsync(`${device}.dataTransfer`, {
                type: 'channel',
                common: {
                    name: `Data Transfers of ${device}`
                },
                native: {}
            });
        }

        if (!this.knownDataTransfer.has(`${device}.${messageId}`)) {
            await this.extendObjectAsync(`${device}.dataTransfer.${messageId}`, {
                type: 'state',
                common: {
                    name: `Data Transfers for message "${messageId}"`,
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                    def: ''
                },
                native: {}
            });

            this.knownDataTransfer.add(`${device}.${messageId}`);
        }

        await this.setStateAsync(`${device}.dataTransfer.${messageId}`, data, true);
    }

    /**
     * Is called if a subscribed state changes
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            // if state deleted or already acknowledged
            return;
        }

        try {
            // handle state change
            const idArr = id.split('.');
            const deviceName = idArr[2];
            const channel = idArr[3];
            const connectorId = parseInt(channel, 10);
            const functionality = idArr[4];

            if (!this.server) {
                this.log.warn(`Cannot control "${deviceName}", because server is not running`);
                return;
            }

            const connState = await this.getStateAsync(`${deviceName}.connected`);
            const client = this.server.getClients().find(c => this.getDeviceId(c.url) === deviceName);

            if (!connState?.val || !client) {
                this.log.warn(`Cannot control "${deviceName}", because not connected`);
                return;
            }

            if (functionality === 'transactionActive') {
                // enable/disable transaction
                if (state.val) {
                    const cmdObj: RemoteStartTransactionRequest = {
                        connectorId,
                        idTag: 'ioBroker'
                    };

                    const limitState = await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimit`);

                    if (typeof limitState?.val === 'number' && limitState.val > 0) {
                        const limitTypeState = await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimitType`);
                        const limitType: LimitType = (limitTypeState?.val as LimitType) || 'A';

                        const numberPhases = await this._getNumberOfPhases(deviceName, connectorId);

                        const period: { startPeriod: number; limit: number; numberPhases?: number } = {
                            startPeriod: 0,
                            limit: limitState.val
                        };
                        if (typeof numberPhases === 'number' && numberPhases > 0) {
                            period.numberPhases = numberPhases;
                        }

                        // Issue #65 & #24: OCPP 1.6 specification requires chargingProfilePurpose = 'TxProfile' for RemoteStartTransaction
                        cmdObj.chargingProfile = {
                            chargingProfileId: 1,
                            stackLevel: 0,
                            chargingProfilePurpose: 'TxProfile',
                            chargingProfileKind: 'Recurring',
                            recurrencyKind: 'Daily',
                            chargingSchedule: {
                                duration: 86_400,
                                startSchedule: '2013-01-01T00:00:00.000Z',
                                chargingRateUnit: limitType,
                                chargingSchedulePeriod: [period]
                            }
                        };
                    }

                    this.log.debug(
                        `Sending RemoteStartTransaction for ${deviceName}.${connectorId}: ${JSON.stringify(cmdObj)}`
                    );
                    try {
                        const res = await client.sendCommand<
                            RemoteStartTransactionRequest,
                            RemoteStartTransactionResponse
                        >('RemoteStartTransaction', cmdObj);

                        if (res.status === 'Rejected') {
                            this.log.warn(`Starting transaction has been rejected by charge point`);
                        }
                    } catch (e: any) {
                        this.log.error(
                            `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`
                        );
                    }
                } else {
                    // stop the transaction using tracked transactionId if available (#65)
                    const knownClient = this.knownClients.get(client.url);
                    const transactionId = knownClient?.activeTransactions.get(connectorId) ?? connectorId;

                    this.log.debug(
                        `Sending RemoteStopTransaction for ${deviceName}.${connectorId} (transactionId: ${transactionId})`
                    );

                    try {
                        const res = await client.sendCommand<
                            RemoteStopTransactionRequest,
                            RemoteStopTransactionResponse
                        >('RemoteStopTransaction', {
                            transactionId
                        });

                        if (res.status === 'Rejected') {
                            this.log.warn(`Stopping transaction has been rejected by charge point`);
                        }
                    } catch (e: any) {
                        this.log.error(
                            `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`
                        );
                    }
                }
            } else if (functionality === 'availability') {
                try {
                    this.log.debug(
                        `Sending ChangeAvailability for ${deviceName}.${connectorId}: ${
                            state.val ? 'Operative' : 'Inoperative'
                        }`
                    );
                    const res = await client.sendCommand<ChangeAvailabilityRequest, ChangeAvailabilityResponse>(
                        'ChangeAvailability',
                        {
                            connectorId,
                            type: state.val ? 'Operative' : 'Inoperative'
                        }
                    );

                    if (res.status !== 'Rejected') {
                        await this.setStateAsync(`${deviceName}.${connectorId}.availability`, state.val, true);
                    }
                } catch (e: any) {
                    this.log.error(
                        `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`
                    );
                }
            } else if (functionality === 'chargeLimit') {
                if (typeof state.val !== 'number') {
                    return;
                }

                try {
                    const limitTypeState = await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimitType`);
                    const limitType: LimitType = (limitTypeState?.val as LimitType) || 'A';

                    const numberPhases = await this._getNumberOfPhases(deviceName, connectorId);

                    await this.changeChargeLimit({
                        connection: client,
                        limitType,
                        limit: state.val,
                        deviceName,
                        connectorId,
                        numberPhases
                    });
                } catch (e: any) {
                    this.log.error(
                        `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`
                    );
                }
            } else if (functionality === 'numberPhases') {
                if (typeof state.val !== 'number') {
                    return;
                }

                try {
                    const limitTypeState = await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimitType`);
                    const limitType: LimitType = (limitTypeState?.val as LimitType) || 'A';

                    const limit = (await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimit`))?.val;

                    if (typeof limit !== 'number') {
                        this.log.error(
                            `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": No chargeLimit set`
                        );
                        return;
                    }

                    await this.changeChargeLimit({
                        connection: client,
                        limitType,
                        limit,
                        deviceName,
                        connectorId,
                        numberPhases: state.val
                    });
                } catch (e: any) {
                    this.log.error(
                        `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`
                    );
                }
            } else if (functionality === 'chargeLimitType') {
                if (typeof state.val !== 'string') {
                    return;
                }
                await this.extendObjectAsync(`${deviceName}.${connectorId}.chargeLimit`, {
                    common: { unit: state.val }
                });
                await this.setStateAsync(`${deviceName}.${connectorId}.chargeLimitType`, state.val, true);
            } else if (functionality === 'hardReset' || functionality === 'softReset') {
                try {
                    const res = await client.sendCommand<ResetRequest, ResetResponse>('Reset', {
                        type: functionality === 'softReset' ? 'Soft' : 'Hard'
                    });

                    if (res.status === 'Rejected') {
                        this.log.warn(`${functionality} has been rejected by charge point`);
                    } else {
                        await this.setStateAsync(`${deviceName}.${connectorId}.${functionality}`, true, true);
                    }
                } catch (e: any) {
                    this.log.error(
                        `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`
                    );
                }
            } else if (functionality === 'authList') {
                const authList = state.val ?? '';

                if (typeof authList !== 'string') {
                    return;
                }

                try {
                    await this.syncAuthList(client, authList);
                } catch (e: any) {
                    this.log.error(`Could not synchronize Local Authentication List: ${e.message}`);
                }
            } else if (channel === 'configuration') {
                if (state.val === null) {
                    return;
                }

                const value = state.val.toString();

                this.log.info(`Changing configuration (device: ${deviceName}) of "${functionality}" to "${value}"`);

                try {
                    const res = await client.sendCommand<ChangeConfigurationRequest, ChangeConfigurationResponse>(
                        'ChangeConfiguration',
                        { key: functionality, value }
                    );

                    if (res.status === 'Accepted') {
                        await this.setStateAsync(`${deviceName}.configuration.${functionality}`, state.val, true);
                    } else if (res.status === 'RebootRequired') {
                        await this.setStateAsync(`${deviceName}.configuration.${functionality}`, state.val, true);
                        this.log.info(
                            `Reboot Required: Configuration changed (device: ${deviceName}) of "${functionality}" to "${state.val}"`
                        );
                    } else {
                        this.log.warn(
                            `Cannot change configuration of ${deviceName} (key: ${functionality}, value: ${state.val}): ${res.status}`
                        );
                    }
                } catch (e: any) {
                    this.log.error(
                        `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`
                    );
                }
            } else {
                this.log.warn(`State change of ${deviceName}.${connectorId}.${functionality} not implemented`);
            }
        } catch (e: any) {
            this.log.error(`Unhandled error in onStateChange for "${id}": ${e.message}`);
        }
    }

    /**
     * Determines user-configured number of phases for charging
     *
     * @param deviceName name of device in objects
     * @param connectorId Id of the connector
     */
    private async _getNumberOfPhases(deviceName: string, connectorId: number): Promise<number | undefined> {
        let numberPhases: number | undefined;

        try {
            const val = (await this.getStateAsync(`${deviceName}.${connectorId}.numberPhases`))?.val;
            if (typeof val === 'number' && val > 0) {
                numberPhases = val;
            }
        } catch (e: any) {
            this.log.warn(`Could not determine number of phases: ${e.message}`);
        }

        return numberPhases;
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
        if (!meterValues.meterValue?.length) {
            return;
        }

        for (const meterEntry of meterValues.meterValue) {
            for (const value of meterEntry.sampledValue || []) {
                let stateKey = '';
                let name = '';

                if (value.measurand) {
                    stateKey += value.measurand.replace(/\./g, '_');
                    name = value.measurand;
                }

                if (value.phase) {
                    stateKey += value.measurand ? `_${value.phase}` : value.phase.replace(/\./g, '_');
                    name += value.measurand ? ` ${value.phase}` : value.phase;
                }

                if (!value.phase && !value.measurand) {
                    stateKey = 'unknown';
                    name = 'Unknown';
                }

                const id = `${devName}.${connectorId}.meterValues.${stateKey}`;

                await this.extendObjectAsync(id, {
                    type: 'state',
                    common: {
                        name: name,
                        role: 'value',
                        type: 'number',
                        read: true,
                        write: false,
                        unit: value.unit,
                        def: 0
                    },
                    native: value as unknown as Record<string, any>
                });
                await this.setStateAsync(id, parseFloat(value.value), true);
            }
        }
    }

    /**
     * Waits for given ms using adapter-safe timer (Repochecker S5005)
     *
     * @param ms milliseconds to wait
     */
    private async _wait(ms: number): Promise<void> {
        return new Promise(resolve => {
            this.setTimeout(() => resolve(), ms);
        });
    }

    /**
     * Changes the general charge limit
     *
     * @param options the charge limit options
     */
    private async changeChargeLimit(options: ChangeChargeLimitOptions): Promise<void> {
        const { connection, connectorId, deviceName, limitType, limit, numberPhases } = options;
        this.log.debug(`Sending SetChargingProfile for ${deviceName}.${connectorId}`);

        const period: { startPeriod: number; limit: number; numberPhases?: number } = {
            startPeriod: 0,
            limit
        };
        if (typeof numberPhases === 'number' && numberPhases > 0) {
            period.numberPhases = numberPhases;
        }

        const res = await connection.sendCommand<SetChargingProfileRequest, SetChargingProfileResponse>(
            'SetChargingProfile',
            {
                connectorId,
                csChargingProfiles: {
                    chargingProfileId: 1,
                    stackLevel: 0,
                    chargingProfilePurpose: 'TxDefaultProfile',
                    chargingProfileKind: 'Recurring',
                    recurrencyKind: 'Daily',
                    chargingSchedule: {
                        duration: 86_400,
                        startSchedule: '2013-01-01T00:00:00.000Z',
                        chargingRateUnit: limitType,
                        chargingSchedulePeriod: [period]
                    }
                }
            }
        );

        if (res.status === 'Accepted') {
            await this.setStateAsync(`${deviceName}.${connectorId}.chargeLimitType`, limitType, true);
            await this.setStateAsync(`${deviceName}.${connectorId}.chargeLimit`, limit, true);
            await this.setStateAsync(`${deviceName}.${connectorId}.numberPhases`, numberPhases ?? null, true);
        } else {
            this.log.warn(`Charge point responded with "${res.status}" on changing charge limit`);
        }
    }

    /**
     * Synchronize auth list with local client
     *
     * @param connection the OcppClientConnection
     * @param authList csv string with tag ids
     */
    private async syncAuthList(connection: OcppClientConnection, authList: string): Promise<void> {
        const { listVersion } = await connection.sendCommand<GetLocalListVersionRequest, GetLocalListVersionResponse>(
            'GetLocalListVersion',
            {}
        );

        authList = authList.replace(/\s/g, '');

        const idTags = authList ? authList.split(',').filter(Boolean) : [];
        const localAuthorizationList: SendLocalListRequest['localAuthorizationList'] = [];

        for (const idTag of idTags) {
            localAuthorizationList.push({ idTag, idTagInfo: { status: 'Accepted' } });
        }

        const res = await connection.sendCommand<SendLocalListRequest, SendLocalListResponse>('SendLocalList', {
            listVersion: listVersion + 1,
            updateType: 'Full',
            localAuthorizationList
        });

        if (res.status === 'Accepted') {
            await this.setStateAsync(`${this.getDeviceId(connection.url)}.0.authList`, authList, true);
        } else {
            throw new Error(`Client has responded with status "${res.status}"`);
        }
    }

    /**
     * Remove states of non-supported profiles
     *
     * @param deviceName raw URL of the device
     * @param supportedProfiles supported profiles
     */
    private async removeUnsupportedStates(deviceName: string, supportedProfiles: string[]): Promise<void> {
        const iobDeviceName = this.getDeviceId(deviceName);

        const SMART_CHARGING_STATE_IDS = ['numberPhases', 'chargeLimitType', 'chargeLimit'] as const;
        const LOCAL_AUTH_LIST_STATE_IDS = ['authList'];

        const connectorIds = this.knownClients.get(deviceName)?.connectorIds;

        if (!connectorIds) {
            return;
        }

        if (!this.hasProfile(supportedProfiles, 'SmartCharging')) {
            this.log.info('Removing SmartCharging functionality as unsupported');
            for (const connectorId of connectorIds) {
                for (const id of SMART_CHARGING_STATE_IDS) {
                    try {
                        await this.delObjectAsync(`${iobDeviceName}.${connectorId}.${id}`);
                    } catch {
                        // ignore
                    }
                }
            }
        }

        if (!this.hasProfile(supportedProfiles, 'LocalAuthListManagement')) {
            this.log.info('Removing LocalAuthListManagement functionality as unsupported');
            for (const connectorId of connectorIds) {
                for (const id of LOCAL_AUTH_LIST_STATE_IDS) {
                    try {
                        await this.delObjectAsync(`${iobDeviceName}.${connectorId}.${id}`);
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Ocpp(options);
} else {
    // otherwise start the instance directly
    (() => new Ocpp())();
}
