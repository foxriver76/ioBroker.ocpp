"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stateObjects = void 0;
exports.stateObjects = [
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
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    {
        _id: 'status',
        type: 'state',
        common: {
            name: 'Current status of wallbox',
            type: 'string',
            role: 'indicator.status',
            write: false,
            read: true,
            states: [
                'Available',
                'Preparing',
                'Charging',
                'SuspendedEVSE',
                'SuspendedEV',
                'Finishing',
                'Reserved',
                'Unavailable',
                'Faulted'
            ]
        },
        native: {}
    },
    {
        _id: 'connectorId',
        type: 'state',
        common: {
            name: 'Connector ID',
            type: 'number',
            role: 'text',
            write: false,
            read: true
        },
        native: {}
    },
    {
        _id: 'transactionActive',
        type: 'state',
        common: {
            name: 'Transaction active',
            type: 'boolean',
            role: 'switch.power',
            write: true,
            read: true
        },
        native: {}
    },
    {
        _id: 'meterValue',
        type: 'state',
        common: {
            name: 'Power meter value',
            type: 'number',
            role: 'value.power',
            write: false,
            read: true,
            unit: 'Wh'
        },
        native: {}
    },
    {
        _id: 'availability',
        type: 'state',
        common: {
            name: 'Switch availability',
            type: 'boolean',
            role: 'switch.power',
            write: true,
            read: true
        },
        native: {}
    }
];
//# sourceMappingURL=states.js.map