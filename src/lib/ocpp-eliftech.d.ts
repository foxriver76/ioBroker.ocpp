declare module 'ocpp-eliftech' {

	export class OCPPCommands {
		static BootNotification: any;
		static Authorize: any;
		static StartTransaction: any;
		static Heartbeat: any;
		static StopTransaction: any;
		static StatusNotification: any;
		connectorId: any;
	}

	export class CentralSystem {
		onRequest: (client: any, command: OCPPCommands) => Promise<any>;
		listen(number: number);
	}
}
