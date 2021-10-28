/*
 * Created with @iobroker/create-adapter v2.0.1
 */

import * as utils from '@iobroker/adapter-core';
import { stateObjects } from './lib/states';
import { CentralSystem, OCPPCommands } from 'ocpp-eliftech';

class Ocpp extends utils.Adapter {
	private client: { info: { connectors: any[] } };
	private readonly clientTimeouts: Record<string, NodeJS.Timeout>;
	private knownClients: string[];
	private readonly clients: Record<string, any>;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
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
	private async onReady(): Promise<void> {
		// subscribe own states
		this.subscribeStates('*');

		this.log.info('Starting OCPP Server');

		const server = new CentralSystem();

		const port = await this.getPortAsync(this.config.port);

		server.listen(port);

		this.log.info(`Server listening on port ${port}`);

		server.onRequest = async (client:any, command: OCPPCommands) => {
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
				case (command instanceof OCPPCommands.BootNotification):
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
				case (command instanceof OCPPCommands.Authorize):
					this.log.info(`Received Authorization Request from "${connection.url}"`);
					return {
						idTagInfo: {
							status: 'Accepted'
						}
					};
				case command instanceof OCPPCommands.StartTransaction:
					this.log.info(`Received Start transaction from "${connection.url}"`);
					await this.setStateAsync(`${connection.url}.enabled`, true, true);
					return {
						transactionId: 1,
						idTagInfo: {
							status: 'Accepted'
						}
					};
				case (command instanceof OCPPCommands.StopTransaction):
					this.log.info(`Received stop transaction from "${connection.url}"`);
					await this.setStateAsync(`${connection.url}.enabled`, false, true);
					return {
						transactionId: 1,
						idTagInfo: {
							status: 'Accepted'
						}
					};
				case (command instanceof OCPPCommands.Heartbeat):
					this.log.debug(`Received heartbeat from "${connection.url}"`);

					return {
						currentTime: new Date().toISOString()
					};
				case (command instanceof OCPPCommands.StatusNotification):
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
					} else {
						this.client.info.connectors[connectorIndex] = {
							...command
						};
					}
					return {};
				case (command instanceof OCPPCommands.MeterValues):
					this.log.info(`Received MeterValues from "${connection.url}"`);
					// {"connectorId":1,"transactionId":1,"meterValue":[{"timestamp":"2021-10-27T17:35:01Z",
					// "sampledValue":[{"value":"4264","format":"Raw","location":"Outlet","context":"Sample.Periodic",
					// "measurand":"Energy.Active.Import.Register","unit":"Wh"}]}]}
					await this.setStateAsync(`${connection.url}.meterValue`,
						parseFloat(command.meterValue[0].sampledValue[0].value), true);
					return {};
				default:
					this.log.warn(`Command not implemented from "${connection.url}": ${JSON.stringify(command)}`);
			}
		}
	}

	/**
	 * Request BootNotification, StatusNotification and MeterValues
	 * @param connection connection object
	 * @param command command object
	 * @private
	 */
	private async requestNewClient(connection: any, command: OCPPCommands): Promise<void> {
		// we want to request boot notification and status and meter values to ahve everything up to date again
		try {
			if (!(command instanceof OCPPCommands.BootNotification)) {
				// it's not a boot notification so request
				this.log.info(`Requesting BootNotification from "${connection.url}"`);
				await connection.send(new OCPPCommands.TriggerMessage({
					requestedMessage: 'BootNotification'
				}));

				await this.wait(1000);
			}

			if (!(command instanceof OCPPCommands.StatusNotification)) {
				// it's not a status notification so request
				this.log.info(`Requesting StatusNotification from "${connection.url}"`);
				await connection.send(new OCPPCommands.TriggerMessage({
					requestedMessage: 'StatusNotification'
				}));

				await this.wait(1000);
			}

			if (!(command instanceof OCPPCommands.MeterValues)) {
				this.log.info(`Requesting MeterValues from "${connection.url}"`);
				// it's not MeterValues, so request
				await connection.send(new OCPPCommands.TriggerMessage({
					requestedMessage: 'MeterValues'
				}));
			}
		} catch (e: any) {
			this.log.warn(`Could not request states of "${connection.url}": ${e.message}`)
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

		await this.setStateAsync(`${device}.connected`, false, true);
		const connState = await this.getStateAsync('info.connection');
		if (typeof connState?.val === 'string') {
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
		await this.setStateAsync(`${device}.connected`, true, true);

		const connState = await this.getStateAsync('info.connection');

		if (typeof connState?.val === 'string') {
			const devices = connState.val.split(',');
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
		await this.extendObjectAsync(device, {
			type: 'device',
			common: {
				name: device
			},
			native: {}
		}, {preserve: {common: ['name']}});

		for (const obj of stateObjects) {
			const id = obj._id;
			obj._id = `${device}.${obj._id}`;
			await this.extendObjectAsync(obj._id, obj, {preserve: {common: ['name']}});
			obj._id = id;
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 */
	private async onUnload(callback: () => void): Promise<void> {
		try {
			// clear all timeouts
			for (const [device, timeout] of Object.entries(this.clientTimeouts)) {
				await this.setStateAsync(`${device}.connected`, false, true);
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

		const connState = await this.getStateAsync(`${idArr[2]}.connected`);
		if (!connState?.val) {
			this.log.warn(`Cannot control "${idArr[2]}", because not connected`);
			return;
		}

		if (idArr[3] === 'enabled') {
			// enable/disable charger
			// we need connectorId
			const connIdState = await this.getStateAsync(`${idArr[2]}.connectorId`);

			if (!connIdState?.val) {
				this.log.warn(`No connectorId for "${idArr[2]}"`);
				return;
			}

			const connectorId = connIdState.val;

			let command;
			if (state.val) {
				// enable
				command = new OCPPCommands.RemoteStartTransaction({
					connectorId: connectorId,
					idTag: connectorId.toString()
				});
			} else {
				// disable
				command = new OCPPCommands.RemoteStopTransaction({
					transactionId: connectorId
				});
			}
			try {
				await this.clients[idArr[2]].connection.send(command);
			} catch (e: any) {
				this.log.error(`Cannot execute command "${idArr[4]}" for "${idArr[3]}": ${e.message}`);
			}
		}
	}

	/**
	 * Waits for given ms
	 * @param ms milliseconds to wait
	 * @private
	 */
	private async wait(ms: number): Promise<void> {
		return new Promise(resolve => {
			setTimeout(() => resolve(), ms);
		});
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Ocpp(options);
} else {
	// otherwise start the instance directly
	(() => new Ocpp())();
}
