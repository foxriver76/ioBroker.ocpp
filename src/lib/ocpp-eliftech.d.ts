declare module 'ocpp-eliftech' {

	export class OCPPCommands {
		static BootNotification: any;
	}

	export class CentralSystem {
		onRequest: (command: OCPPCommands) => Promise<{ status: string; currentTime: string; interval: number } | void>;
		listen(number: number)
	}
}
