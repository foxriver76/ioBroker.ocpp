/*
 * Created with @iobroker/create-adapter v2.0.1
 */

import * as utils from '@iobroker/adapter-core';
import { getConnectorObjects, deviceObjects } from './lib/states';
import type { OcppClientConnection } from './lib/ocpp-server';
import { OcppServer } from './lib/ocpp-server';
import type {
    AuthorizeRequest,
    AuthorizeResponse,
    BootNotificationResponse,
    ChangeAvailabilityRequest,
    ChangeAvailabilityResponse,
    ChangeConfigurationRequest,
    ChangeConfigurationResponse,
    ChargingProfile,
    ClearChargingProfileRequest,
    ClearChargingProfileResponse,
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
    TriggerMessageResponse,
} from './lib/ocpp-types';

/** limit can be in ampere or watts */
type LimitType = 'A' | 'W';

const SMART_CHARGING_STATE_IDS: readonly string[] = ['numberPhases', 'chargeLimitType', 'chargeLimit'];
const LOCAL_AUTH_LIST_STATE_IDS: readonly string[] = ['authList'];

interface KnownClient {
    connectorIds: number[];
    /** Promises tracking connector object creation to prevent race conditions on concurrent requests */
    connectorInitPromises: Map<number, Promise<void>>;
    /** Promise tracking initial device + connector 0 object creation */
    initPromise?: Promise<void>;
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
    private readonly activeTransactions: Map<string, Map<number, number>> = new Map();
    private server: OcppServer | undefined;
    private readonly knownDataTransferChannels = new Set<string>();
    private readonly knownDataTransferStates = new Set<string>();
    private nextTransactionId = 1;
    private isUnloading = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'ocpp',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Converts a raw connection URL (e.g. "/EVB-123.45" or "http://192.168.178.80:9220/EVB-123.45")
     * into the ioBroker device ID.
     * Respects `config.stripLeadingSlash` (Issue #60) while keeping 100% backward compatibility by default
     *
     * @param url raw connection URL
     */
    private getDeviceId(url: string): string {
        let normalized = url;
        if (this.config.stripLeadingSlash) {
            normalized = normalized
                .replace(/^\/+/, '')
                .replace(/^(?:https?|wss?):\/\/[^/]+/i, '')
                .replace(/^\/+/, '');
        }
        normalized = normalized.replace(/\./g, '_');
        if (this.FORBIDDEN_CHARS) {
            normalized = normalized.replace(this.FORBIDDEN_CHARS, '_');
        }
        return normalized || 'chargepoint';
    }

    /**
     * Sanitizes a dynamic key (configuration key, dataTransfer messageId, measurand) for safe ioBroker object IDs
     *
     * @param part raw key segment
     */
    private sanitizeIdPart(part: string): string {
        let clean = part.replace(/[.\s/\\]+/g, '_');
        if (this.FORBIDDEN_CHARS) {
            clean = clean.replace(this.FORBIDDEN_CHARS, '_');
        }
        return clean || 'unknown';
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
     * Checks whether a client connection is still the active session and the adapter is not unloading
     *
     * @param connection client connection to check
     */
    private isClientStillActive(connection: OcppClientConnection): boolean {
        return (
            !this.isUnloading &&
            connection.isOpen() &&
            this.server?.getClient(connection.url) === connection &&
            this.knownClients.has(connection.url)
        );
    }

    /**
     * Ensures a connector and all its objects exist before any state updates are written (prevents concurrent race conditions)
     *
     * @param url raw device URL
     * @param connectorId connector ID (0..N)
     */
    private async ensureConnectorInitialized(url: string, connectorId: number): Promise<void> {
        const knownClient = this.knownClients.get(url);
        if (!knownClient) {
            return;
        }

        if (knownClient.initPromise) {
            await knownClient.initPromise;
        }

        if (!knownClient.connectorIds.includes(connectorId)) {
            knownClient.connectorIds.push(connectorId);
        }

        let connPromise = knownClient.connectorInitPromises.get(connectorId);
        if (!connPromise) {
            connPromise = this.createConnectorObjects(url, connectorId);
            knownClient.connectorInitPromises.set(connectorId, connPromise);
        }
        await connPromise;
    }

    /**
     * Updates the `info.connection` state deterministically from `knownClients` without read-modify-write races
     */
    private async updateConnectionInfoState(): Promise<void> {
        if (this.isUnloading) {
            return;
        }
        const connectedUrls = Array.from(this.knownClients.keys());
        await this.setStateAsync('info.connection', connectedUrls.join(','), true);
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
                ocppProtocolVersion?: string,
            ): Promise<[boolean, number, string]> => {
                this.log.debug(
                    `Connection from "${url}" (auth: ${credentials ? 'provided' : 'none'}), protocol: "${protocol}"${
                        ocppProtocolVersion ? `, OCPP: ${ocppProtocolVersion}` : ''
                    }`,
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
                    })`,
                );

                // sometimes a reconnect happens without time out - ensure to handle as new client (request states etc)
                if (this.knownClients.has(url)) {
                    this.knownClients.delete(url);
                }

                return Promise.resolve([true, 200, 'OK']);
            };

            this.server = new OcppServer({
                validateConnection,
                supportedProtocols: ['ocpp1.6'],
            });

            const port = await this.getPortAsync(this.config.port);

            await this.server.listen(port);

            this.log.info(`Server listening on port ${port}`);

            this.server.onClientError = (client, action, error): void => {
                this.log.error(
                    `Received error from "${client.url}"${action ? ` (command "${action}")` : ''}: ${error.message}`,
                );
            };

            this.server.onClientDisconnect = (client, code, reason): void => {
                if (this.isUnloading) {
                    return;
                }
                this.log.info(
                    `Client "${client.url}" disconnected (code: ${code}${reason ? `, reason: ${reason}` : ''})`,
                );
                void this.handleClientOffline(client.url);
            };

            this.server.onRequest = async (
                client: OcppClientConnection,
                action: string,
                payload: Record<string, unknown>,
            ): Promise<Record<string, unknown>> => {
                if (this.isUnloading) {
                    return {};
                }

                const url = client.url;
                const devName = this.getDeviceId(url);

                // we received a new command, first check if the client is known to us
                let knownClient = this.knownClients.get(url);
                if (!knownClient) {
                    this.log.info(`New device connected: "${url}"`);
                    const existingTx = this.activeTransactions.get(url);
                    knownClient = {
                        connectorIds: [0],
                        connectorInitPromises: new Map(),
                        activeTransactions: existingTx ? new Map(existingTx) : new Map(),
                    };
                    this.knownClients.set(url, knownClient);

                    const initTask = (async (): Promise<void> => {
                        await this.createDeviceObjects(url);
                        await this.setDeviceOnline(url);
                        const conn0Promise = this.createConnectorObjects(url, 0);
                        knownClient.connectorInitPromises.set(0, conn0Promise);
                        await conn0Promise;
                    })();

                    knownClient.initPromise = initTask;
                    await initTask;

                    // request all important values at start, do not await this
                    void this.requestNewClient(client, action);
                } else if (knownClient.initPromise) {
                    // Wait for ongoing device initialization if a second message arrived concurrently
                    await knownClient.initPromise;
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
                            native: payload,
                        });

                        // we are requesting heartbeat every 55 seconds
                        const response: BootNotificationResponse = {
                            status: 'Accepted',
                            currentTime: new Date().toISOString(),
                            interval: 55,
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
                                status,
                            },
                        };
                        return response as unknown as Record<string, unknown>;
                    }
                    case 'StartTransaction': {
                        const startCommand = payload as unknown as StartTransactionRequest;
                        const connectorId = startCommand.connectorId;

                        await this.ensureConnectorInitialized(url, connectorId);

                        const transactionId = this.nextTransactionId++;
                        knownClient.activeTransactions.set(connectorId, transactionId);
                        let devTx = this.activeTransactions.get(url);
                        if (!devTx) {
                            devTx = new Map();
                            this.activeTransactions.set(url, devTx);
                        }
                        devTx.set(connectorId, transactionId);

                        this.log.info(
                            `Received Start transaction from "${url}.${connectorId}" (transactionId: ${transactionId})`,
                        );

                        await this.setStateAsync(`${devName}.${connectorId}.idTag`, startCommand.idTag, true);
                        await this.setStateAsync(
                            `${devName}.${connectorId}.transactionStartMeter`,
                            startCommand.meterStart,
                            true,
                        );
                        await this.setStateAsync(`${devName}.${connectorId}.transactionActive`, true, true);

                        const response: StartTransactionResponse = {
                            transactionId,
                            idTagInfo: {
                                status: 'Accepted',
                            },
                        };
                        return response as unknown as Record<string, unknown>;
                    }
                    case 'StopTransaction': {
                        const stopCommand = payload as unknown as StopTransactionRequest;

                        // Resolve connectorId from tracked activeTransactions, falling back to transactionId if matching a known connector
                        let connectorId: number | undefined;
                        const devTx = this.activeTransactions.get(url);
                        if (devTx) {
                            for (const [connId, txId] of devTx.entries()) {
                                if (txId === stopCommand.transactionId) {
                                    connectorId = connId;
                                    devTx.delete(connId);
                                    knownClient.activeTransactions.delete(connId);
                                    break;
                                }
                            }
                        }

                        if (connectorId === undefined) {
                            for (const [connId, txId] of knownClient.activeTransactions.entries()) {
                                if (txId === stopCommand.transactionId) {
                                    connectorId = connId;
                                    knownClient.activeTransactions.delete(connId);
                                    break;
                                }
                            }
                        }

                        if (connectorId === undefined) {
                            if (
                                knownClient.connectorIds.includes(stopCommand.transactionId) &&
                                stopCommand.transactionId > 0
                            ) {
                                connectorId = stopCommand.transactionId;
                            } else {
                                // Default to connector 1 if single-connector charger restarted and lost transaction mapping
                                connectorId =
                                    knownClient.connectorIds.find(id => id > 0) ?? (stopCommand.transactionId || 1);
                            }
                        }

                        await this.ensureConnectorInitialized(url, connectorId);

                        if (stopCommand.idTag) {
                            await this.setStateAsync(`${devName}.${connectorId}.idTag`, stopCommand.idTag, true);
                        }

                        const startMeterState = await this.getStateAsync(
                            `${devName}.${connectorId}.transactionStartMeter`,
                        );

                        this.log.info(`Received stop transaction from "${url}.${connectorId}"`);

                        if (typeof startMeterState?.val === 'number') {
                            const consumption = stopCommand.meterStop - startMeterState.val;
                            await this.setStateAsync(
                                `${devName}.${connectorId}.lastTransactionConsumption`,
                                consumption,
                                true,
                            );
                        }

                        await this.setStateAsync(
                            `${devName}.${connectorId}.transactionEndMeter`,
                            stopCommand.meterStop,
                            true,
                        );
                        await this.setStateAsync(`${devName}.${connectorId}.transactionActive`, false, true);

                        const response: StopTransactionResponse = {
                            idTagInfo: {
                                status: 'Accepted',
                            },
                        };
                        return response as unknown as Record<string, unknown>;
                    }
                    case 'Heartbeat': {
                        this.log.debug(`Received heartbeat from "${url}"`);

                        const response: HeartbeatResponse = {
                            currentTime: new Date().toISOString(),
                        };
                        return response as unknown as Record<string, unknown>;
                    }
                    case 'StatusNotification': {
                        const statusCommand = payload as unknown as StatusNotificationRequest;
                        const connectorId = statusCommand.connectorId;

                        this.log.info(
                            `Received Status Notification from "${url}.${connectorId}": ${statusCommand.status}`,
                        );

                        if (statusCommand.errorCode && statusCommand.errorCode !== 'NoError') {
                            this.log.warn(
                                `Status from "${url}.${connectorId}" contains an error: ${statusCommand.errorCode}`,
                            );
                        }

                        await this.ensureConnectorInitialized(url, connectorId);

                        await this.setStateAsync(`${devName}.${connectorId}.status`, statusCommand.status, true);

                        const response: StatusNotificationResponse = {};
                        return response;
                    }
                    case 'MeterValues': {
                        const meterValuesCommand = payload as unknown as MeterValuesRequest;
                        const connectorId = meterValuesCommand.connectorId;
                        this.log.info(`Received MeterValues from "${url}.${connectorId}"`);

                        await this.ensureConnectorInitialized(url, connectorId);

                        await this._setMeterValues(devName, connectorId, meterValuesCommand);

                        const response: MeterValuesResponse = {};
                        return response;
                    }
                    case 'DataTransfer': {
                        const dataTransferCommand = payload as unknown as DataTransferRequest;
                        this.log.info(
                            `Received DataTransfer from "${url}" with id "${dataTransferCommand.messageId}": ${dataTransferCommand.data}`,
                        );
                        try {
                            await this.synchronizeDataTransfer(
                                devName,
                                dataTransferCommand.messageId,
                                dataTransferCommand.data,
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
                            }`,
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
        if (!this.isClientStillActive(connection)) {
            return;
        }

        this.log.info(`Sending GetConfiguration to "${connection.url}"`);
        const res = await connection.sendCommand<GetConfigurationRequest, GetConfigurationResponse>(
            'GetConfiguration',
            {},
        );

        if (!this.isClientStillActive(connection)) {
            return;
        }

        this.log.debug(`Received configuration from ${connection.url}: ${JSON.stringify(res)}`);
        await this.createConfigurationObjects(connection.url, res);

        // Issue #65: If charge point truncated response due to GetConfigurationMaxKeys, query SupportedFeatureProfiles explicitly
        const hasSupportedProfilesKey = (res.configurationKey || []).some(
            entry => entry.key === 'SupportedFeatureProfiles',
        );
        if (!hasSupportedProfilesKey && this.isClientStillActive(connection)) {
            try {
                this.log.debug(`Explicitly requesting SupportedFeatureProfiles from "${connection.url}"`);
                const profileRes = await connection.sendCommand<GetConfigurationRequest, GetConfigurationResponse>(
                    'GetConfiguration',
                    { key: ['SupportedFeatureProfiles'] },
                );
                if (this.isClientStillActive(connection)) {
                    await this.createConfigurationObjects(connection.url, profileRes);
                }
            } catch (e: any) {
                this.log.debug(
                    `Could not explicitly query SupportedFeatureProfiles from "${connection.url}": ${e.message}`,
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
        if (!this.isClientStillActive(connection)) {
            return;
        }

        // we want to request boot notification and status and meter values to have everything up to date again
        if (initialAction !== 'BootNotification' && this.isClientStillActive(connection)) {
            try {
                this.log.info(`Requesting BootNotification from "${connection.url}"`);
                await connection.sendCommand<TriggerMessageRequest, TriggerMessageResponse>('TriggerMessage', {
                    requestedMessage: 'BootNotification',
                });
            } catch (e: any) {
                if (this.isClientStillActive(connection)) {
                    this.log.debug(`Could not trigger BootNotification from "${connection.url}": ${e.message}`);
                }
            }
            await this._wait(1_000);
        }

        if (initialAction !== 'StatusNotification' && this.isClientStillActive(connection)) {
            try {
                this.log.info(`Requesting StatusNotification from "${connection.url}"`);
                await connection.sendCommand<TriggerMessageRequest, TriggerMessageResponse>('TriggerMessage', {
                    requestedMessage: 'StatusNotification',
                });
            } catch (e: any) {
                if (this.isClientStillActive(connection)) {
                    this.log.debug(`Could not trigger StatusNotification from "${connection.url}": ${e.message}`);
                }
            }
            await this._wait(1_000);
        }

        if (initialAction !== 'MeterValues' && this.isClientStillActive(connection)) {
            try {
                this.log.info(`Requesting MeterValues from "${connection.url}"`);
                await connection.sendCommand<TriggerMessageRequest, TriggerMessageResponse>('TriggerMessage', {
                    requestedMessage: 'MeterValues',
                });
            } catch (e: any) {
                if (this.isClientStillActive(connection)) {
                    this.log.debug(`Could not trigger MeterValues from "${connection.url}": ${e.message}`);
                }
            }
            await this._wait(1_000);
        }

        if (!this.isClientStillActive(connection)) {
            return;
        }

        try {
            await this.requestConfiguration(connection);
            const supportedProfiles = this.knownClients.get(connection.url)?.supportedProfiles;
            // Only remove unsupported states if SupportedFeatureProfiles was actually reported by the charger (#65)
            if (supportedProfiles && supportedProfiles.length > 0 && this.isClientStillActive(connection)) {
                await this.removeUnsupportedStates(connection.url, supportedProfiles);
            }
        } catch (e: any) {
            if (this.isClientStillActive(connection)) {
                this.log.error(`Could not request configuration of ${connection.url}: ${e.message}`);
            }
        }
    }

    /**
     * Marks a client offline and updates `connected` and `info.connection` states
     *
     * @param device raw URL of the wallbox device
     */
    private async handleClientOffline(device: string): Promise<void> {
        try {
            const timeout = this.clientTimeouts.get(device);
            if (timeout) {
                this.clearTimeout(timeout);
                this.clientTimeouts.delete(device);
            }

            if (this.knownClients.has(device)) {
                this.knownClients.delete(device);
            }

            if (!this.isUnloading) {
                const devId = this.getDeviceId(device);
                await this.setStateAsync(`${devId}.connected`, false, true);
                await this.updateConnectionInfoState();
            }
        } catch (e: any) {
            this.log.error(`Error setting client "${device}" offline: ${e.message}`);
        }
    }

    /**
     * Is called if client timed out, sets connection to offline
     *
     * @param device raw URL of the wallbox device
     */
    private async timedOut(device: string): Promise<void> {
        this.log.warn(`Client "${device}" timed out`);
        await this.handleClientOffline(device);
    }

    /**
     * Sets the corresponding online states
     *
     * @param device raw URL of the wallbox device
     */
    private async setDeviceOnline(device: string): Promise<void> {
        const devId = this.getDeviceId(device);
        await this.setStateAsync(`${devId}.connected`, true, true);
        await this.updateConnectionInfoState();
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
                    name: device,
                },
                native: {},
            },
            { preserve: { common: ['name'] } },
        );

        for (const obj of deviceObjects) {
            const fullId = `${devId}.${obj._id}`;
            await this.extendObjectAsync(fullId, { ...obj, _id: fullId } as ioBroker.PartialObject, {
                preserve: { common: ['name'] },
            });
        }
    }

    /**
     * Creates configuration objects and states accordingly
     *
     * @param deviceName raw URL of the wallbox device
     * @param config the config object
     */
    private async createConfigurationObjects(deviceName: string, config: GetConfigurationResponse): Promise<void> {
        if (!config.configurationKey || this.isUnloading) {
            return;
        }

        const iobDeviceName = this.getDeviceId(deviceName);

        await this.extendObjectAsync(`${iobDeviceName}.configuration`, {
            type: 'channel',
            common: {
                name: 'Configuration',
            },
            native: {},
        });

        for (const entry of config.configurationKey) {
            if (this.isUnloading) {
                return;
            }

            const { role, type, value } = this.parseConfigurationValue(entry.value || '', entry.readonly);

            if (entry.key === 'SupportedFeatureProfiles' && entry.value && this.knownClients.has(deviceName)) {
                this.log.info(`Supported profiles by client "${deviceName}" are "${entry.value}"`);
                this.knownClients.get(deviceName)!.supportedProfiles = entry.value
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean);
            }

            const safeKey = this.sanitizeIdPart(entry.key);

            await this.extendObjectAsync(`${iobDeviceName}.configuration.${safeKey}`, {
                type: 'state',
                common: {
                    name: entry.key,
                    type: type,
                    role: role,
                    write: !entry.readonly,
                    read: true,
                    def: type === 'number' ? 0 : type === 'boolean' ? false : '',
                },
                native: {
                    ocppKey: entry.key,
                },
            });

            await this.setStateAsync(`${iobDeviceName}.configuration.${safeKey}`, value, true);
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
        const supportedProfiles = this.knownClients.get(device)?.supportedProfiles;

        await this.extendObjectAsync(
            `${iobDevice}.${connectorId}`,
            {
                type: 'channel',
                common: {
                    name: connectorId ? `Connector ${connectorId}` : 'Main',
                },
                native: {},
            },
            { preserve: { common: ['name'] } },
        );

        const connectorObjects = getConnectorObjects(connectorId);

        for (const obj of connectorObjects) {
            // If SupportedFeatureProfiles is already known, skip creating states for unsupported profiles
            if (supportedProfiles && supportedProfiles.length > 0) {
                if (
                    SMART_CHARGING_STATE_IDS.includes(obj._id) &&
                    !this.hasProfile(supportedProfiles, 'SmartCharging')
                ) {
                    continue;
                }
                if (
                    LOCAL_AUTH_LIST_STATE_IDS.includes(obj._id) &&
                    !this.hasProfile(supportedProfiles, 'LocalAuthListManagement')
                ) {
                    continue;
                }
            }

            const fullId = `${iobDevice}.${connectorId}.${obj._id}`;
            await this.extendObjectAsync(fullId, { ...obj, _id: fullId } as ioBroker.PartialObject, {
                preserve: { common: ['name'] },
            });
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback
     */
    private async onUnload(callback: () => void): Promise<void> {
        this.isUnloading = true;
        try {
            if (this.server) {
                await this.server.close();
                this.server = undefined;
            }

            // clear all timeouts using Map iteration (fixes Object.entries bug on Map)
            for (const [device, timeout] of this.clientTimeouts.entries()) {
                this.clearTimeout(timeout);
                await this.setStateAsync(`${this.getDeviceId(device)}.connected`, false, true);
            }
            this.clientTimeouts.clear();
            this.knownClients.clear();
            this.activeTransactions.clear();

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
        data: string | undefined,
    ): Promise<void> {
        const safeMessageId = this.sanitizeIdPart(messageId || 'unknown');
        data = data || '';

        if (!this.knownDataTransferChannels.has(device)) {
            await this.extendObjectAsync(`${device}.dataTransfer`, {
                type: 'channel',
                common: {
                    name: `Data Transfers of ${device}`,
                },
                native: {},
            });
            this.knownDataTransferChannels.add(device);
        }

        const fullStateId = `${device}.dataTransfer.${safeMessageId}`;
        if (!this.knownDataTransferStates.has(fullStateId)) {
            await this.extendObjectAsync(fullStateId, {
                type: 'state',
                common: {
                    name: `Data Transfers for message "${messageId || 'unknown'}"`,
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                    def: '',
                },
                native: {},
            });

            this.knownDataTransferStates.add(fullStateId);
        }

        await this.setStateAsync(fullStateId, data, true);
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param id
     * @param state
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || this.isUnloading) {
            // if state deleted, already acknowledged, or adapter is shutting down
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
                        idTag: 'ioBroker',
                    };

                    const limitState = await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimit`);

                    if (typeof limitState?.val === 'number' && limitState.val > 0) {
                        const limitTypeState = await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimitType`);
                        const limitType: LimitType = (limitTypeState?.val as LimitType) || 'A';

                        const numberPhases = await this._getNumberOfPhases(deviceName, connectorId);

                        if (limitType === 'W') {
                            const effectivePhases =
                                typeof numberPhases === 'number' && numberPhases > 0 ? numberPhases : 3;
                            const estimatedCurrent = limitState.val / (effectivePhases * 230);
                            if (estimatedCurrent < 6) {
                                this.log.warn(
                                    `[chargeLimit] ${limitState.val} W across ${effectivePhases} phase(s) results in ~${estimatedCurrent.toFixed(1)} A, which is below the IEC 61851 minimum of 6 A. The charge point may reject this profile or stop charging.`,
                                );
                            }
                        }

                        const period: { startPeriod: number; limit: number; numberPhases?: number } = {
                            startPeriod: 0,
                            limit: limitState.val,
                        };
                        if (typeof numberPhases === 'number' && numberPhases > 0) {
                            period.numberPhases = numberPhases;
                        }

                        // Issue #65 & #24: OCPP 1.6 specification requires chargingProfilePurpose = 'TxProfile' for RemoteStartTransaction.
                        // A TxProfile must be 'Relative' (never 'Recurring') with no startSchedule or recurrencyKind.
                        cmdObj.chargingProfile = {
                            chargingProfileId: 1,
                            stackLevel: 0,
                            chargingProfilePurpose: 'TxProfile',
                            chargingProfileKind: 'Relative',
                            chargingSchedule: {
                                duration: 86_400,
                                chargingRateUnit: limitType,
                                chargingSchedulePeriod: [period],
                            },
                        };
                    }

                    this.log.debug(
                        `Sending RemoteStartTransaction for ${deviceName}.${connectorId}: ${JSON.stringify(cmdObj)}`,
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
                            `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`,
                        );
                    }
                } else {
                    // stop the transaction using tracked transactionId if available (#65)
                    const knownClient = this.knownClients.get(client.url);
                    const transactionId = knownClient?.activeTransactions.get(connectorId) ?? connectorId;

                    this.log.debug(
                        `Sending RemoteStopTransaction for ${deviceName}.${connectorId} (transactionId: ${transactionId})`,
                    );

                    try {
                        const res = await client.sendCommand<
                            RemoteStopTransactionRequest,
                            RemoteStopTransactionResponse
                        >('RemoteStopTransaction', {
                            transactionId,
                        });

                        if (res.status === 'Rejected') {
                            this.log.warn(`Stopping transaction has been rejected by charge point`);
                        }
                    } catch (e: any) {
                        this.log.error(
                            `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`,
                        );
                    }
                }
            } else if (functionality === 'availability') {
                try {
                    this.log.debug(
                        `Sending ChangeAvailability for ${deviceName}.${connectorId}: ${
                            state.val ? 'Operative' : 'Inoperative'
                        }`,
                    );
                    const res = await client.sendCommand<ChangeAvailabilityRequest, ChangeAvailabilityResponse>(
                        'ChangeAvailability',
                        {
                            connectorId,
                            type: state.val ? 'Operative' : 'Inoperative',
                        },
                    );

                    if (res.status !== 'Rejected') {
                        await this.setStateAsync(`${deviceName}.${connectorId}.availability`, state.val, true);
                    }
                } catch (e: any) {
                    this.log.error(
                        `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`,
                    );
                }
            } else if (functionality === 'chargeLimit') {
                if (state.val === null || state.val === 0) {
                    try {
                        this.log.debug(`Clearing charging profile for ${deviceName}.${connectorId}`);
                        const res = await client.sendCommand<ClearChargingProfileRequest, ClearChargingProfileResponse>(
                            'ClearChargingProfile',
                            {
                                connectorId,
                            },
                        );

                        if (res.status === 'Accepted' || res.status === 'Unknown') {
                            await this.setStateAsync(`${deviceName}.${connectorId}.chargeLimit`, null, true);
                        } else {
                            this.log.warn(
                                `Charge point responded with "${String(res.status)}" on clearing charging profile for "${deviceName}.${connectorId}"`,
                            );
                        }
                    } catch (e: any) {
                        this.log.error(`Cannot clear chargeLimit for "${deviceName}.${connectorId}": ${e.message}`);
                    }
                    return;
                }

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
                        numberPhases,
                    });
                } catch (e: any) {
                    this.log.error(
                        `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`,
                    );
                }
            } else if (functionality === 'numberPhases') {
                if (typeof state.val !== 'number' && state.val !== null) {
                    return;
                }

                try {
                    const limitTypeState = await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimitType`);
                    const limitType: LimitType = (limitTypeState?.val as LimitType) || 'A';

                    const limit = (await this.getStateAsync(`${deviceName}.${connectorId}.chargeLimit`))?.val;

                    if (typeof limit !== 'number') {
                        this.log.error(
                            `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": No chargeLimit set`,
                        );
                        return;
                    }

                    await this.changeChargeLimit({
                        connection: client,
                        limitType,
                        limit,
                        deviceName,
                        connectorId,
                        numberPhases: typeof state.val === 'number' ? state.val : undefined,
                    });
                } catch (e: any) {
                    this.log.error(
                        `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`,
                    );
                }
            } else if (functionality === 'chargeLimitType') {
                if (typeof state.val !== 'string') {
                    return;
                }
                await this.extendObjectAsync(`${deviceName}.${connectorId}.chargeLimit`, {
                    common: { unit: state.val },
                });
                await this.setStateAsync(`${deviceName}.${connectorId}.chargeLimitType`, state.val, true);
            } else if (functionality === 'hardReset' || functionality === 'softReset') {
                try {
                    const res = await client.sendCommand<ResetRequest, ResetResponse>('Reset', {
                        type: functionality === 'softReset' ? 'Soft' : 'Hard',
                    });

                    if (res.status === 'Rejected') {
                        this.log.warn(`${functionality} has been rejected by charge point`);
                    } else {
                        await this.setStateAsync(`${deviceName}.${connectorId}.${functionality}`, true, true);
                    }
                } catch (e: any) {
                    this.log.error(
                        `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`,
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
                const configObj = await this.getObjectAsync(`${deviceName}.configuration.${functionality}`);
                const ocppKey = (configObj?.native?.ocppKey as string) || functionality;

                this.log.info(`Changing configuration (device: ${deviceName}) of "${ocppKey}" to "${value}"`);

                try {
                    const res = await client.sendCommand<ChangeConfigurationRequest, ChangeConfigurationResponse>(
                        'ChangeConfiguration',
                        { key: ocppKey, value },
                    );

                    if (res.status === 'Accepted') {
                        await this.setStateAsync(`${deviceName}.configuration.${functionality}`, state.val, true);
                    } else if (res.status === 'RebootRequired') {
                        await this.setStateAsync(`${deviceName}.configuration.${functionality}`, state.val, true);
                        this.log.info(
                            `Reboot Required: Configuration changed (device: ${deviceName}) of "${ocppKey}" to "${state.val}"`,
                        );
                    } else {
                        this.log.warn(
                            `Cannot change configuration of ${deviceName} (key: ${ocppKey}, value: ${state.val}): ${res.status}`,
                        );
                    }
                } catch (e: any) {
                    this.log.error(
                        `Cannot execute command "${functionality}" for "${deviceName}.${connectorId}": ${e.message}`,
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
        meterValues: MeterValuesRequest,
    ): Promise<void> {
        if (!meterValues.meterValue?.length || this.isUnloading) {
            return;
        }

        for (const meterEntry of meterValues.meterValue) {
            for (const value of meterEntry.sampledValue || []) {
                if (this.isUnloading) {
                    return;
                }

                let stateKey = '';
                let name = '';

                if (value.measurand) {
                    stateKey += this.sanitizeIdPart(value.measurand);
                    name = value.measurand;
                }

                if (value.phase) {
                    const cleanPhase = this.sanitizeIdPart(value.phase);
                    stateKey += value.measurand ? `_${cleanPhase}` : cleanPhase;
                    name += value.measurand ? ` ${value.phase}` : value.phase;
                }

                if (!value.phase && !value.measurand) {
                    stateKey = 'unknown';
                    name = 'Unknown';
                }

                const id = `${devName}.${connectorId}.meterValues.${stateKey}`;
                const numericVal = parseFloat(value.value);
                if (Number.isNaN(numericVal)) {
                    continue;
                }

                await this.extendObjectAsync(id, {
                    type: 'state',
                    common: {
                        name: name,
                        role: 'value',
                        type: 'number',
                        read: true,
                        write: false,
                        unit: value.unit,
                        def: 0,
                    },
                    native: value as unknown as Record<string, any>,
                });
                await this.setStateAsync(id, numericVal, true);
            }
        }
    }

    /**
     * Waits for given ms using adapter-safe timer (Repochecker S5005)
     *
     * @param ms milliseconds to wait
     */
    private async _wait(ms: number): Promise<void> {
        if (this.isUnloading) {
            return;
        }
        return new Promise(resolve => {
            const handle = this.setTimeout(() => resolve(), ms);
            if (!handle) {
                resolve();
            }
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

        if (limitType === 'W') {
            const effectivePhases = typeof numberPhases === 'number' && numberPhases > 0 ? numberPhases : 3;
            const estimatedCurrent = limit / (effectivePhases * 230);
            if (estimatedCurrent < 6) {
                this.log.warn(
                    `[chargeLimit] ${limit} W across ${effectivePhases} phase(s) results in ~${estimatedCurrent.toFixed(1)} A, which is below the IEC 61851 minimum of 6 A. The charge point may reject this profile or stop charging.`,
                );
            }
        }

        const period: { startPeriod: number; limit: number; numberPhases?: number } = {
            startPeriod: 0,
            limit,
        };
        if (typeof numberPhases === 'number' && numberPhases > 0) {
            period.numberPhases = numberPhases;
        }

        const activeTxId = this.activeTransactions.get(connection.url)?.get(connectorId);

        const chargingProfile: ChargingProfile = {
            chargingProfileId: 1,
            stackLevel: 0,
            chargingProfilePurpose: activeTxId !== undefined ? 'TxProfile' : 'TxDefaultProfile',
            chargingProfileKind: 'Relative',
            chargingSchedule: {
                duration: 86_400,
                chargingRateUnit: limitType,
                chargingSchedulePeriod: [period],
            },
        };

        if (activeTxId !== undefined) {
            chargingProfile.transactionId = activeTxId;
        }

        const res = await connection.sendCommand<SetChargingProfileRequest, SetChargingProfileResponse>(
            'SetChargingProfile',
            {
                connectorId,
                csChargingProfiles: chargingProfile,
            },
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
            {},
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
            localAuthorizationList,
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
