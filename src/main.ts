/*
 * Created with @iobroker/create-adapter v2.0.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
import * as utils from '@iobroker/adapter-core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
import { CentralSystem, OCPPCommands } from 'ocpp-eliftech';

// Load your modules here, e.g.:
// import * as fs from "fs";

class Ocpp extends utils.Adapter {
	private client: { info: { connectors: any[] } };

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
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
	private async onReady(): Promise<void> {
		this.log.info('Starting OCPP Server');

		for (const i in OCPPCommands['Authorize']) {
			this.log.warn(i);
		}

		const server = new CentralSystem();

		const port = await this.getPortAsync(this.config.port);

		server.listen(port);

		this.log.info(`Server listening on port ${port}`);

		server.onRequest = async (client:any, command: OCPPCommands) => {
			const connection = client.connection;
			this.log.info(`New command from ${connection.url}`);

			switch (true) {
				case (command instanceof OCPPCommands.BootNotification):
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
				case (command instanceof OCPPCommands.Authorize):
					this.log.info('Received Authorization Request');
					return {
						idTagInfo: {
							status: 'Accepted'
						}
					};
				case command instanceof OCPPCommands.StartTransaction:
					this.log.info('Received Start transaction');
					return {
						transactionId: 1,
						idTagInfo: {
							status: 'Accepted'
						}
					};
				case (command instanceof OCPPCommands.StopTransaction):
					this.log.info('Received stop transaction');
					return {
						transactionId: 1,
						idTagInfo: {
							status: 'Accepted'
						}
					};
				case (command instanceof OCPPCommands.Heartbeat):
					this.log.info('Received heartbeat');
					return {
						currentTime: new Date().toISOString()
					};
				case (command instanceof OCPPCommands.StatusNotification):
					this.log.info('Received Status Notification');
					// client.info = client.info || {};
					// client.info.connectors = client.info.connectors || [];

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
				default:
					this.log.warn(`Command not implemented: ${JSON.stringify(command)}`);
			}
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 */
	private async onUnload(callback: () => void): Promise<void> {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);
			await this.setStateAsync('info.connection', false, true);
			callback();
		} catch {
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
	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  */
	// private onMessage(obj: ioBroker.Message): void {
	// 	if (typeof obj === 'object' && obj.message) {
	// 		if (obj.command === 'send') {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info('send command');

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
	// 		}
	// 	}
	// }

}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Ocpp(options);
} else {
	// otherwise start the instance directly
	(() => new Ocpp())();
}
