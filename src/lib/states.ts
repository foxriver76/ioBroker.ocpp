export const stateObjects: ioBroker.Object[] = [
	{
		_id: 'connected',
		type: 'state',
		common: {
			name: 'If connected to server',
			type: 'boolean',
			role: 'indicator.connected',
			write: false,
			read: true
		},
		native: {}
	},
	{
		_id: 'status',
		type: 'state',
		common: {
			name: 'Current status of wallbox',
			type: 'string',
			role: 'indicator.status',
			write: false,
			read: true
		},
		native: {}
	}
];
